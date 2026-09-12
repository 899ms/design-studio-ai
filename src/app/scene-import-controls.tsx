import {useEffect,useRef,useState} from 'react';
import {GLTFLoader,type GLTF} from 'three/addons/loaders/GLTFLoader.js';
import {registerImportedScene,inspectImportedScene,disposeImportedScene} from '../shared/scene-import';
import {editableImport} from '../shared/scene-editable-import';
import {disposeScene} from '../shared/scene-runtime';
import {documentSchema,type DesignDocument,type DesignNode} from '../shared/schema';
import {isNodeProtected} from './editor-selection';

export function SceneImportControls({doc,pageId,node,onDocument}:{doc:DesignDocument;pageId:string;node:DesignNode;onDocument:(doc:DesignDocument)=>void}){
  const [inventory,setInventory]=useState<ReturnType<typeof inspectImportedScene>>(),[error,setError]=useState(''),[pending,setPending]=useState<ReturnType<typeof editableImport>>(),[busy,setBusy]=useState(false);
  const loaded=useRef<GLTF|undefined>(undefined),latest=useRef(doc),base=useRef(doc);latest.current=doc;
  useEffect(()=>{let stopped=false;let gltf:GLTF|undefined;loaded.current=undefined;setInventory(undefined);setPending(undefined);setError('');
    void new GLTFLoader().loadAsync(node.src!).then(value=>{gltf=value;if(stopped){disposeScene(value.scene);return;}loaded.current=value;const wrapper=registerImportedScene(value);setInventory(inspectImportedScene(wrapper));disposeImportedScene(wrapper);}).catch(e=>{if(!stopped)setError(e.message);});
    return()=>{stopped=true;if(gltf)disposeScene(gltf.scene);};
  },[node.src]);
  const change=(recipe:(node:DesignNode,doc:DesignDocument)=>void)=>{try{if(isNodeProtected(doc.pages.find(p=>p.id===pageId)!,node))throw new Error('Unlock and show this model before editing.');const next=structuredClone(doc),target=next.pages.find(p=>p.id===pageId)!.nodes.find(n=>n.id===node.id)!;recipe(target,next);onDocument(documentSchema.parse(next));setError('');}catch(e){setError((e as Error).message);}};
  return <details open><summary>Imported model & animation</summary>{!inventory&&!error?<p>Reading model, skeleton and clips…</p>:null}{inventory&&<>
    <p>{inventory.vertices.toLocaleString()} vertices · {inventory.bones.length} bones · {inventory.morphs.reduce((s,m)=>s+m.names.length,0)} morphs · {inventory.clips.length} clips</p>
    {inventory.clips.map((clip,i)=><button key={i} onClick={()=>change((n,d)=>{const start=0,end=clip.duration||1;n.scene??={};n.scene.importedClips??=[];n.scene.importedClips.push({name:clip.name,start,end,speed:1,weight:1,loop:true});d.timeline??={duration:end,fps:30,tracks:[]};d.timeline.duration=Math.max(d.timeline.duration,end);})}>Add {clip.name} ({clip.duration.toFixed(2)}s)</button>)}
    {(node.scene?.importedClips??[]).map((clip,i)=><fieldset key={i}><legend>{clip.name}</legend>{(['start','end','speed','weight'] as const).map(key=><label key={key}>{key}<input aria-label={`${clip.name} ${key} ${i+1}`} type="number" step=".1" min={0} value={clip[key]??1} onChange={e=>change((n,d)=>{n.scene!.importedClips![i][key]=+e.target.value;if(d.timeline)d.timeline.duration=Math.max(d.timeline.duration,n.scene!.importedClips![i].end);})}/></label>)}<label><input type="checkbox" checked={clip.loop??false} onChange={e=>change(n=>{n.scene!.importedClips![i].loop=e.target.checked;})}/>Loop</label><button onClick={()=>change(n=>{n.scene!.importedClips!.splice(i,1);})}>Remove clip placement</button></fieldset>)}
    <button disabled={busy||!loaded.current} onClick={()=>{setBusy(true);try{base.current=doc;const result=editableImport(doc,pageId,node.id,loaded.current!);documentSchema.parse(result.document);setPending(result);setError('');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>Preview editable conversion</button>
    {pending&&<><p>{pending.report.meshes} editable meshes, {pending.report.textures} textures, {pending.report.frames} sampled frames. Original model stays as a hidden checkpoint.</p><button disabled={isNodeProtected(doc.pages.find(p=>p.id===pageId)!,node)} onClick={()=>{if(latest.current!==base.current){setError('Design changed. Preview conversion again.');return;}onDocument(documentSchema.parse(pending.document));}}>Apply editable conversion</button></>}
    <p>Blender interchange: import a GLB with named actions, bones and PBR textures; export GLB to continue editing in Blender. Review conversion warnings before applying.</p>
  </>}{error&&<p role="alert">{error}</p>}</details>;
}
