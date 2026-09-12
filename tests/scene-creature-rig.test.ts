import test from 'node:test';
import assert from 'node:assert/strict';
import { SkinnedMesh, Vector3 } from 'three';
import { createDocument } from '../src/shared/catalog';
import { mutateDocument } from '../src/shared/operations';
import { sceneCommandSchema, type SceneCommand } from '../src/shared/scene-authoring-schema';
import { bind } from '../src/shared/scene-rigging';
import { buildScene, disposeScene } from '../src/shared/scene-runtime';
import { scenePose } from '../src/shared/scene-shared-rig';
import { documentSchema } from '../src/shared/schema';

type Landmarks = Extract<SceneCommand,{action:'rig-winged-quadruped'}>['landmarks'];
const landmarks:Landmarks={
  hips:[0,1,0],chest:[0,1.5,.8],head:[0,2,2],frontLeft:[-.5,0,1],frontRight:[.5,0,1],backLeft:[-.5,0,-.5],backRight:[.5,0,-.5],tail:[0,1,-2],jaw:[0,1.7,2],jawTip:[0,1.5,2.9],
  wingLeft:{shoulder:[-.5,1.5,.8],elbow:[-1.7,1.6,.6],wrist:[-2.8,1.6,.3],fingers:[{base:[-3,1.6,.5],tip:[-4,1.6,1]},{base:[-3,1.6,.2],tip:[-4,1.6,0]},{base:[-2.9,1.6,0],tip:[-3.6,1.6,-1]}]},
  wingRight:{shoulder:[.5,1.5,.8],elbow:[1.7,1.6,.6],wrist:[2.8,1.6,.3],fingers:[{base:[3,1.6,.5],tip:[4,1.6,1]},{base:[3,1.6,.2],tip:[4,1.6,0]},{base:[2.9,1.6,0],tip:[3.6,1.6,-1]}]},
};
function setup(){
  const doc=createDocument('3d','Creature deformation');
  // A single connected indexed surface spans both wings, chest and jaw region.
  const positions:number[]=[],indices:number[]=[],columns=41,rows=21;
  for(let z=0;z<rows;z++)for(let x=0;x<columns;x++)positions.push(-4+x*.2,1.6,-1+z*.2);
  for(let z=0;z<rows-1;z++)for(let x=0;x<columns-1;x++){const a=z*columns+x;indices.push(a,a+columns,a+1,a+1,a+columns,a+columns+1);}
  doc.pages[0].nodes=[{id:'creature',type:'model3d',name:'Creature',x:0,y:0,width:400,height:400,scene:{position:[0,0,0],scale:[1,1,1],mesh:{positions,indices}}}];
  return doc;
}
function command(doc:ReturnType<typeof setup>,value:unknown){return mutateDocument(doc,[{op:'scene-command',pageId:doc.pages[0].id,command:value}]);}
function rig(){return command(setup(),{action:'rig-winged-quadruped',nodeId:'creature',landmarks});}

test('winged preset requires explicit landmarks and preserves native quadruped names',()=>{
  assert.equal(sceneCommandSchema.safeParse({action:'rig-winged-quadruped',nodeId:'creature'}).success,false);
  const next=rig(),bones=next.pages[0].nodes[0].scene!.bones!;
  for(const name of ['head','frontLeftFoot','tail3','jaw','jawTip','wingLeftShoulder','wingRightElbow','wingLeftWrist','wingRightFinger3Tip'])assert(bones.some(b=>b.name===name),name);
  const jaw=bones.find(b=>b.name==='jaw')!;assert.equal(bones[jaw.parent].name,'head');
  assert.equal(bones.find(b=>b.name==='wingLeftWrist')!.mirrorBone,'wingRightWrist');
  assert(documentSchema.safeParse(next).success);
  const collapsed=structuredClone(landmarks);collapsed.wingLeft.elbow=collapsed.wingLeft.shoulder;
  assert.throws(()=>command(setup(),{action:'rig-winged-quadruped',nodeId:'creature',landmarks:collapsed}),/differ from its parent/);
});

test('wing membrane and jaw deform through real continuous skin with unchanged topology',async()=>{
  let doc=command(rig(),{action:'bind',nodeId:'creature',smooth:2});
  const mesh=doc.pages[0].nodes[0].scene!.mesh!,rest=structuredClone(mesh);
  for(let i=0;i<mesh.positions.length/3;i++)assert(Math.abs(mesh.skinWeights!.slice(i*4,i*4+4).reduce((a,b)=>a+b,0)-1)<1e-8);
  doc=command(doc,{action:'clip',nodeId:'creature',preset:'wing-flap',start:0,duration:2,wristLag:.2});
  doc=command(doc,{action:'clip',nodeId:'creature',preset:'roar',start:2,duration:2});
  const saved=JSON.stringify(doc);
  for(const [time,region] of [[.5,'wing'],[3,'jaw']] as const){
    const built=await buildScene(doc,0,time);
    try{
      const skin=built.objects.get('creature') as SkinnedMesh;assert(skin.isSkinnedMesh);skin.updateMatrixWorld(true);skin.skeleton.update();
      let moved=0,total=0,maxDisplacement=0;
      const deformed:Vector3[]=[];
      for(let i=0;i<mesh.positions.length/3;i++){
        const point=new Vector3().fromArray(mesh.positions,i*3),posed=skin.applyBoneTransform(i,point.clone());deformed.push(posed);
        if(region==='wing'?Math.abs(point.x)>1&&point.z<1:Math.abs(point.x)<.4&&point.z>2.3){total++;const distance=point.distanceTo(posed);if(distance>.03)moved++;maxDisplacement=Math.max(maxDisplacement,distance);}
      }
      assert(moved>total*.8,`${region}: ${moved}/${total} vertices deform`);assert(maxDisplacement>.1);
      // Adjacent triangles retain shared vertices across joints; no detached wing objects.
      assert.deepEqual(Array.from(skin.geometry.index!.array),rest.indices);
      let stretch=0;
      for(let i=0;i<mesh.indices.length;i+=3)for(let edge=0;edge<3;edge++){const a=mesh.indices[i+edge],b=mesh.indices[i+(edge+1)%3],distance=deformed[a].distanceTo(deformed[b]);assert(Number.isFinite(distance));stretch=Math.max(stretch,distance);}
      assert(stretch<1,`Connected surface edge grew to ${stretch}`);
      assert.equal(built.objects.size,1);
    }finally{disposeScene(built.scene);}
  }
  assert.equal(JSON.stringify(doc),saved);assert.deepEqual(doc.pages[0].nodes[0].scene!.mesh,rest);
});

test('semantic motion rejects incomplete rigs and wrist lag changes only the expected wing phase',()=>{
  const doc=rig(),bones=doc.pages[0].nodes[0].scene!.bones!;
  const noLag=command(doc,{action:'clip',nodeId:'creature',preset:'wing-flap',wristLag:0}),lag=command(doc,{action:'clip',nodeId:'creature',preset:'wing-flap',wristLag:.25});
  const wrist=bones.findIndex(b=>b.name==='wingLeftWrist'),shoulder=bones.findIndex(b=>b.name==='wingLeftShoulder');
  const a=scenePose(noLag.pages[0].nodes[0],noLag,.5).scene!.bones!,b=scenePose(lag.pages[0].nodes[0],lag,.5).scene!.bones!;
  assert.equal(a[shoulder].rotation![2],b[shoulder].rotation![2]);assert(Math.abs(a[wrist].rotation![2]-b[wrist].rotation![2])>20);
  const missing=structuredClone(doc);missing.pages[0].nodes[0].scene!.bones!.find(b=>b.name==='wingLeftWrist')!.name='unmappedWrist';
  assert.throws(()=>command(missing,{action:'clip',nodeId:'creature',preset:'wing-flap'}),/wingLeftWrist/);
  const quadruped=command(setup(),{action:'rig-quadruped',nodeId:'creature'});
  assert.throws(()=>command(quadruped,{action:'clip',nodeId:'creature',preset:'roar'}),/jaw/);
});

test('named limits clamp FK, gizmos, sampled animation and mirrored poses without changing rest',()=>{
  let doc=rig();doc=command(doc,{action:'joint-limits',nodeId:'creature',bone:'wingLeftWrist',min:[-10,-20,-30],max:[10,20,30],mirrorBone:'wingRightWrist'});
  doc=command(doc,{action:'pose',nodeId:'creature',bone:'wingLeftWrist',rotation:[25,40,60]});
  doc=command(doc,{action:'mirror-pose',nodeId:'creature',bone:'wingLeftWrist'});
  const bones=doc.pages[0].nodes[0].scene!.bones!,left=bones.findIndex(b=>b.name==='wingLeftWrist'),right=bones.findIndex(b=>b.name==='wingRightWrist');
  assert.deepEqual(bones[left].rotation,[10,20,30]);assert.deepEqual(bones[right].rotation,[10,-20,-30]);assert.deepEqual(bones[left].bindRotation,[0,0,0]);
  doc=command(doc,{action:'joint',nodeId:'creature',bone:'wingLeftWrist',mode:'pose',value:[-90,-90,-90]});assert.deepEqual(doc.pages[0].nodes[0].scene!.bones![left].rotation,[-10,-20,-30]);
  doc.timeline={duration:1,fps:30,tracks:[{id:'limits',nodeId:'creature',keyframes:[{time:0,values:{[`scene.bones.${left}.rotation.z`]:0}},{time:1,values:{[`scene.bones.${left}.rotation.z`]:150}}]}]};
  const saved=JSON.stringify(doc);assert.equal(scenePose(doc.pages[0].nodes[0],doc,1).scene!.bones![left].rotation![2],30);assert.equal(JSON.stringify(doc),saved);
  assert.throws(()=>command(doc,{action:'joint-limits',nodeId:'creature',bone:'jaw',min:[20,0,0],max:[10,0,0]}),/minimum rotation/);
  assert.throws(()=>command(doc,{action:'joint-limits',nodeId:'creature',bone:'jaw',min:[0,0,0],max:[40,0,0],mirrorBone:'absent'}),/mirror bone/);
});

test('automatic weights consider every branch from a joint',()=>{
  const mesh={positions:[0,1,0,.01,1,0,0,1.01,0],indices:[0,1,2]};
  bind(mesh,[{name:'fork',parent:-1,position:[0,0,0]},{name:'first',parent:0,position:[2,0,0]},{name:'second',parent:0,position:[0,2,0]}],0);
  const result=mesh as typeof mesh&{skinIndices:number[];skinWeights:number[]};
  assert.equal(result.skinIndices[0],0);assert(result.skinWeights[0]>.99);
});
