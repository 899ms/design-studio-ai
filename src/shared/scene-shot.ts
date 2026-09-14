import * as T from 'three';
import {buildScene,animateScene,disposeScene,defaultScene} from './scene-runtime';
import type {DesignDocument} from './schema';

export function visibleBounds(root:T.Object3D){const box=new T.Box3();for(let parent:T.Object3D|null=root.parent;parent;parent=parent.parent)if(!parent.visible)return box;root.traverseVisible(object=>{if(object instanceof T.Mesh){const attribute=object.geometry.getAttribute('position');for(let i=0;i<(attribute?.count??0);i++)box.expandByPoint(object.getVertexPosition(i,new T.Vector3()).applyMatrix4(object.matrixWorld));}});return box;}
export function boxCorners(box:T.Box3){return Array.from({length:8},(_,i)=>new T.Vector3(i&1?box.max.x:box.min.x,i&2?box.max.y:box.min.y,i&4?box.max.z:box.min.z));}
export async function fitSceneCamera(doc:DesignDocument,pageId:string,nodeIds:string[],samples=17){
  const index=doc.pages.findIndex(p=>p.id===pageId),page=doc.pages[index];if(!page||!nodeIds.length||nodeIds.length>32||!Number.isInteger(samples)||samples<2||samples>61)throw new Error('Choose a page, 1–32 subjects and 2–61 samples');
  const built=await buildScene(doc,index),bounds=new T.Box3();
  try{
    for(const id of nodeIds)if(!built.objects.has(id))throw new Error(`Unknown scene subject: ${id}`);
    let vertices=0;for(const id of nodeIds)built.objects.get(id)!.traverseVisible(o=>{if(o instanceof T.Mesh)vertices+=o.geometry.getAttribute('position')?.count??0;});
    if(vertices*samples>20000000)throw new Error('Camera fitting exceeds 20 million sampled vertices. Reduce subjects or samples.');
    const duration=doc.timeline?.duration??Math.max(0,...page.nodes.flatMap(n=>(n.scene?.importedClips??[]).map(c=>c.end)));
    for(let i=0;i<samples;i++){animateScene(built.scene,doc,index,duration*i/(samples-1));built.scene.updateMatrixWorld(true);for(const id of nodeIds)bounds.union(visibleBounds(built.objects.get(id)!));}
    if(bounds.isEmpty()||[...bounds.min.toArray(),...bounds.max.toArray()].some(v=>!Number.isFinite(v)))throw new Error('Selected subjects have no finite visible geometry');
    const config=page.scene??defaultScene,target=bounds.getCenter(new T.Vector3()),direction=new T.Vector3(...config.camera.position).sub(new T.Vector3(...config.camera.target));if(direction.lengthSq()<.0001)direction.set(0,0,1);direction.normalize();
    const camera=new T.PerspectiveCamera(config.camera.fov,page.width/page.height,.01,10000);camera.position.copy(target).add(direction);camera.lookAt(target);camera.updateMatrixWorld(true);
    const inverse=camera.quaternion.clone().invert(),halfY=Math.tan(T.MathUtils.degToRad(camera.fov/2)),halfX=halfY*camera.aspect,padding=1/(1-2*(page.scene?.camera.safeFrame??.08));
    let distance=.1;for(const corner of boxCorners(bounds)){const p=corner.sub(target).applyQuaternion(inverse);distance=Math.max(distance,p.z+Math.abs(p.x)*padding/halfX,p.z+Math.abs(p.y)*padding/halfY);}
    return {camera:{...config.camera,position:target.clone().addScaledVector(direction,distance).toArray(),target:target.toArray()},bounds:{min:bounds.min.toArray(),max:bounds.max.toArray()},samples,nodeIds};
  }finally{disposeScene(built.scene);}
}
