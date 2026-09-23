import * as T from 'three';
import {buildScene,animateScene,disposeScene,defaultScene} from './scene-runtime';
import type {DesignDocument,DesignPage} from './schema';

export function visibleBounds(root:T.Object3D){const box=new T.Box3();for(let parent:T.Object3D|null=root.parent;parent;parent=parent.parent)if(!parent.visible)return box;root.traverseVisible(object=>{if(object instanceof T.Mesh){const attribute=object.geometry.getAttribute('position');for(let i=0;i<(attribute?.count??0);i++)box.expandByPoint(object.getVertexPosition(i,new T.Vector3()).applyMatrix4(object.matrixWorld));}});return box;}
export function boxCorners(box:T.Box3){return Array.from({length:8},(_,i)=>new T.Vector3(i&1?box.max.x:box.min.x,i&2?box.max.y:box.min.y,i&4?box.max.z:box.min.z));}
export async function fitSceneCamera(doc:DesignDocument,pageId:string,nodeIds:string[],samples=17){
  const index=doc.pages.findIndex(p=>p.id===pageId),page=doc.pages[index];if(!page||!nodeIds.length||nodeIds.length>32||!Number.isInteger(samples)||samples<2||samples>61)throw new Error('Choose a page, 1–32 subjects and 2–61 samples');
  const built=await buildScene(doc,index),bounds=new T.Box3(),sampled:{time:number;bounds:T.Box3}[]=[];
  try{
    for(const id of nodeIds)if(!built.objects.has(id))throw new Error(`Unknown scene subject: ${id}`);
    let vertices=0;for(const id of nodeIds)built.objects.get(id)!.traverseVisible(o=>{if(o instanceof T.Mesh)vertices+=o.geometry.getAttribute('position')?.count??0;});
    if(vertices*samples>20000000)throw new Error('Camera fitting exceeds 20 million sampled vertices. Reduce subjects or samples.');
    const duration=doc.timeline?.duration??Math.max(0,...page.nodes.flatMap(n=>(n.scene?.importedClips??[]).map(c=>c.end)));
    for(let i=0;i<samples;i++){const time=duration*i/(samples-1),frame=new T.Box3();animateScene(built.scene,doc,index,time);built.scene.updateMatrixWorld(true);for(const id of nodeIds)frame.union(visibleBounds(built.objects.get(id)!));bounds.union(frame);sampled.push({time,bounds:frame});}
    if(bounds.isEmpty()||[...bounds.min.toArray(),...bounds.max.toArray()].some(v=>!Number.isFinite(v)))throw new Error('Selected subjects have no finite visible geometry');
    const shot:NonNullable<DesignPage['scene']>['camera']=page.scene?.camera??defaultScene.camera,padding=1/(1-2*(shot.safeFrame??.08));
    // Distance along a fixed view direction at which every sampled corner fits the padded frame around the look-at point.
    const place=(position:readonly number[],aim:readonly number[],lookAt:T.Vector3,fov:number,box:T.Box3)=>{
      const direction=new T.Vector3(...position).sub(new T.Vector3(...aim));if(direction.lengthSq()<.0001)direction.set(0,0,1);direction.normalize();
      const camera=new T.PerspectiveCamera(fov,page.width/page.height,.01,10000);camera.position.copy(lookAt).add(direction);camera.lookAt(lookAt);camera.updateMatrixWorld(true);
      const inverse=camera.quaternion.clone().invert(),halfY=Math.tan(T.MathUtils.degToRad(fov/2)),halfX=halfY*camera.aspect;
      let distance=.1;for(const corner of boxCorners(box)){const p=corner.clone().sub(lookAt).applyQuaternion(inverse);distance=Math.max(distance,p.z+Math.abs(p.x)*padding/halfX,p.z+Math.abs(p.y)*padding/halfY);}
      if(distance+box.getSize(new T.Vector3()).length()>9000)throw new Error('The fitted camera would sit beyond the render distance. Narrow the field of view or the safe frame, or move the look-at point closer to the subjects.');
      return lookAt.clone().addScaledVector(direction,distance).toArray() as [number,number,number];
    };
    const center=bounds.getCenter(new T.Vector3()),position=place(shot.position,shot.target,center,shot.fov,bounds);
    // Camera keys keep their direction and look-at point, so authored pans survive; only each key's distance changes.
    // Each key frames the motion between its neighbouring keys, so a tracking shot stays tight instead of framing the whole path.
    const times=[...new Set(shot.keys?.map(key=>key.time))].sort((a,b)=>a-b);
    const windowBounds=(time:number)=>{const at=times.indexOf(time),from=at>0?times[at-1]:0,to=at<times.length-1?times[at+1]:duration,box=new T.Box3();for(const sample of sampled)if(sample.time>=from&&sample.time<=to)box.union(sample.bounds);if(box.isEmpty())box.copy(sampled.reduce((best,sample)=>Math.abs(sample.time-time)<Math.abs(best.time-time)?sample:best).bounds);return box;};
    const keys=shot.keys?.map(key=>({...key,position:place(key.position,key.target,new T.Vector3(...key.target),key.fov??shot.fov,windowBounds(key.time))}));
    return {camera:{...shot,position,target:center.toArray() as [number,number,number],...(keys?{keys}:{})},bounds:{min:bounds.min.toArray(),max:bounds.max.toArray()},samples,nodeIds};
  }finally{disposeScene(built.scene);}
}
