import * as T from 'three';
import type {GLTF} from 'three/addons/loaders/GLTFLoader.js';
import type {DesignNode} from './schema';

type Binding = {root:T.Object3D; clips:T.AnimationClip[]; mixer:T.AnimationMixer;placements:Map<string,T.AnimationClip>};
const imports = new WeakMap<T.Object3D,Binding>();

/** Keep source names below a document-owned wrapper, so animation bindings survive. */
export function registerImportedScene(gltf:Pick<GLTF,'scene'|'animations'>) {
  const wrapper=new T.Group(); wrapper.add(gltf.scene);
  const names=new Set<string>(),clips=gltf.animations.map((original,index)=>{const clip=original.clone(),base=(original.name||`Clip ${index+1}`).slice(0,140);let name=base,suffix=2;while(names.has(name))name=`${base} (${suffix++})`;names.add(name);clip.name=name;return clip;});
  imports.set(wrapper,{root:gltf.scene,clips,mixer:new T.AnimationMixer(gltf.scene),placements:new Map()});
  return wrapper;
}

export function inspectImportedScene(object:T.Object3D) {
  const binding=imports.get(object); let vertices=0,triangles=0;
  const bones:string[]=[],morphs:{mesh:string;names:string[]}[]=[],materials:string[]=[];
  (binding?.root??object).traverse(child=>{
    if(child instanceof T.Bone)bones.push(child.name);
    if(child instanceof T.Mesh){vertices+=child.geometry.getAttribute('position')?.count??0;triangles+=(child.geometry.index?.count??child.geometry.getAttribute('position')?.count??0)/3;
      if(child.morphTargetDictionary)morphs.push({mesh:child.name,names:Object.keys(child.morphTargetDictionary)});
      for(const m of Array.isArray(child.material)?child.material:[child.material])materials.push(m.name||m.type);
    }
  });
  return {vertices,triangles,bones,morphs,materials:[...new Set(materials)],clips:binding?.clips.map(c=>({name:c.name,duration:c.duration,tracks:c.tracks.length}))??[]};
}

export function animateImportedScene(object:T.Object3D,node:DesignNode,time:number) {
  const binding=imports.get(object); if(!binding)return;
  const {mixer,clips}=binding;
  mixer.stopAllAction();
  // Reset and sample absolute time, never accumulate frame deltas during seeking.
  for(const [index,placement] of (node.scene?.importedClips??[]).entries()){
    const clip=clips.find(c=>c.name===placement.name);
    if(!clip)throw new Error(`Animation clip "${placement.name}" is missing from ${node.name}. Inspect the imported model's clips.`);
    if(time<placement.start||time>placement.end)continue;
    const key=`${index}:${placement.name}`;
    let source=binding.placements.get(key);if(!source){source=clip.clone();binding.placements.set(key,source);}
    const action=mixer.clipAction(source);action.reset();action.enabled=true;action.clampWhenFinished=true;
    action.setLoop(T.LoopOnce,1);action.setEffectiveWeight(placement.weight??1);
    const local=(time-placement.start)*(placement.speed??1);
    action.time=placement.loop&&clip.duration>0&&time<placement.end?local%clip.duration:Math.min(local,clip.duration);
    action.play();action.paused=true;
  }
  mixer.update(0);binding.root.updateMatrixWorld(true);
}

export function disposeImportedScene(object:T.Object3D){const binding=imports.get(object);if(binding){binding.mixer.stopAllAction();binding.mixer.uncacheRoot(binding.root);imports.delete(object);}}

export function importedSampleValues(object:T.Object3D,node:DesignNode,frames:number){const binding=imports.get(object);if(!binding||!node.scene?.importedClips?.length)return 0;let count=0;binding.root.traverse(o=>{count+=10+(o instanceof T.Mesh?o.morphTargetInfluences?.length??0:0);});return count*frames;}

/** Bake imported descendant transforms/morphs with document timing for portable exports. */
export function bakeImportedScene(object:T.Object3D,node:DesignNode,duration:number,fps:number):T.KeyframeTrack[]{
  const binding=imports.get(object);if(!binding||!node.scene?.importedClips?.length)return [];
  const targets:T.Object3D[]=[];binding.root.traverse(o=>targets.push(o));
  const frames=Math.ceil(duration*fps)+1;
  const scalars=targets.reduce((s,o)=>s+10+(o instanceof T.Mesh?o.morphTargetInfluences?.length??0:0),0)*frames;
  if(scalars>2000000)throw new Error('Imported animation export exceeds two million sampled values. Reduce duration, FPS or model complexity.');
  const values=targets.map(o=>({o,p:[] as number[],q:[] as number[],s:[] as number[],m:[] as number[]})),times:number[]=[];
  for(let frame=0;frame<frames;frame++){
    const time=Math.min(duration,frame/fps);times.push(time);animateImportedScene(object,node,time);
    for(const v of values){v.p.push(...v.o.position.toArray());v.q.push(...v.o.quaternion.toArray());v.s.push(...v.o.scale.toArray());if(v.o instanceof T.Mesh)v.m.push(...v.o.morphTargetInfluences??[]);}
  }
  return values.flatMap(v=>[new T.VectorKeyframeTrack(`${v.o.uuid}.position`,times,v.p),new T.QuaternionKeyframeTrack(`${v.o.uuid}.quaternion`,times,v.q),new T.VectorKeyframeTrack(`${v.o.uuid}.scale`,times,v.s),...(v.m.length?[new T.NumberKeyframeTrack(`${v.o.uuid}.morphTargetInfluences`,times,v.m)]:[])]);
}
