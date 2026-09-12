import {z} from 'zod';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {documentSchema,type DesignDocument} from '../shared/schema';
import {disposeScene,defaultScene} from '../shared/scene-runtime';
import {registerImportedScene,inspectImportedScene,disposeImportedScene} from '../shared/scene-import';
import {editableImport} from '../shared/scene-editable-import';
import {fitSceneCamera} from '../shared/scene-shot';
import {duplicateSceneShot} from '../shared/scene-shot-operations';

export function browserSceneTools(get:()=>DesignDocument,set:(doc:DesignDocument)=>void){
  const result=(value:unknown)=>({content:[{type:'text',text:JSON.stringify(value)}]});
  const modelInput=z.object({pageId:z.string(),nodeId:z.string(),convert:z.boolean().default(false),preview:z.boolean().default(true)});
  const shotInput=z.object({pageId:z.string(),nodeIds:z.array(z.string()).min(1).max(32),samples:z.number().int().min(2).max(61).default(17),aspect:z.enum(['portrait','square']).optional(),preview:z.boolean().default(true)});
  return [{name:'studio_imported_model',description:'Inspect GLB mesh, skeleton, morph and clip inventory. Set convert to preview/apply editable conversion with a hidden source checkpoint. Unsupported conversion data is rejected; GLB playback remains available.',inputSchema:z.toJSONSchema(modelInput),execute:async(args:Record<string,unknown>)=>{
    const input=modelInput.parse(args),original=get(),node=original.pages.find(p=>p.id===input.pageId)?.nodes.find(n=>n.id===input.nodeId);
    if(!node?.src||node.scene?.mesh)throw new Error('Choose an imported GLB model');
    const gltf=await new GLTFLoader().loadAsync(node.src),wrapper=registerImportedScene(gltf);
    try{const inventory=inspectImportedScene(wrapper);if(!input.convert)return result(inventory);
      const converted=editableImport(original,input.pageId,input.nodeId,gltf);const document=documentSchema.parse(converted.document);
      if(get()!==original)throw new Error('Design changed during conversion. Inspect and retry.');
      if(!input.preview)set(document);return result({inventory,preview:input.preview,...converted.report});
    }finally{disposeImportedScene(wrapper);disposeScene(gltf.scene);}
  }},{name:'studio_frame_scene_shot',description:'Fit selected subjects across sampled animation times with the page safe margin. Optionally duplicate a portrait/square shot sharing asset files. Preview by default; apply is undoable.',inputSchema:z.toJSONSchema(shotInput),execute:async(args:Record<string,unknown>)=>{
    const input=shotInput.parse(args),original=get();let next=structuredClone(original),pageId=input.pageId,nodeIds=input.nodeIds;
    if(input.aspect){const shot=duplicateSceneShot(next,pageId,input.aspect);next=shot.document;pageId=shot.pageId;nodeIds=nodeIds.map(id=>shot.nodeIds[id]);}
    const fit=await fitSceneCamera(next,pageId,nodeIds,input.samples),page=next.pages.find(p=>p.id===pageId)!;
    page.scene??=structuredClone(defaultScene);page.scene.camera=fit.camera as typeof page.scene.camera;
    next=documentSchema.parse(next);if(get()!==original)throw new Error('Design changed during framing. Inspect and retry.');
    if(!input.preview)set(next);return result({preview:input.preview,pageId,...fit});
  }}];
}
