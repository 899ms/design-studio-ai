import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import {createDocument} from '../src/shared/catalog';
import {documentSchema} from '../src/shared/schema';
import {buildScene,animateScene,disposeScene,defaultScene} from '../src/shared/scene-runtime';
import {fitSceneCamera,visibleBounds,boxCorners} from '../src/shared/scene-shot';
import {mutateDocument} from '../src/shared/operations';
import {exportOptionsSchema} from '../src/shared/export-contract';

function setup(){const doc=createDocument('3d','Production scene');doc.pages[0].scene=structuredClone(defaultScene);doc.pages[0].width=1080;doc.pages[0].height=1920;doc.pages[0].nodes=[{id:'dragon',type:'model3d',name:'dragon',x:0,y:0,width:400,height:400,scene:{position:[0,0,0],scale:[2,1,1]}}];return doc;}
test('camera fitting contains animated subjects within a portrait safe frame',async()=>{
  const doc=setup(),page=doc.pages[0];page.scene!.camera.safeFrame=.1;doc.timeline={duration:2,fps:30,tracks:[{id:'move',nodeId:'dragon',keyframes:[{time:0,values:{'scene.position.x':-3}},{time:1,values:{'scene.position.y':4,'scene.rotation.z':70}},{time:2,values:{'scene.position.x':3,'scene.scale.x':3}}]}]};
  const original=JSON.stringify(doc),fit=await fitSceneCamera(doc,page.id,['dragon'],17);assert.equal(JSON.stringify(doc),original);page.scene!.camera=fit.camera as NonNullable<typeof page.scene>['camera'];documentSchema.parse(doc);
  const built=await buildScene(doc);try{for(let i=0;i<=16;i++){animateScene(built.scene,doc,0,i/8);built.scene.updateMatrixWorld(true);for(const point of boxCorners(visibleBounds(built.objects.get('dragon')!))){point.project(built.camera);assert(Math.abs(point.x)<=.80001&&Math.abs(point.y)<=.80001,`Subject clipped at ${i/8}: ${point.toArray()}`);}}}finally{disposeScene(built.scene);}
});
test('effects persist, honor initial export time and seek deterministically',async()=>{
  const doc=setup();doc.pages[0].scene!.atmosphere={fogColor:'#421010',fogDensity:.02};doc.pages[0].scene!.lights=[{id:'lava',type:'point',position:[0,-2,0],color:'#ff3300',intensity:12}];doc.pages[0].scene!.emitters=[{id:'ash',position:[0,0,0],spread:[2,3,4],velocity:[0,2,0],count:10,size:.1,color:'#ff5500',lifetime:3,seed:42,start:1,end:4}];
  const built=await buildScene(documentSchema.parse(doc),0,2);try{const object=built.scene.getObjectByName('emitter-ash') as T.Points;const atTwo=Array.from(object.geometry.getAttribute('position').array);assert(built.scene.fog instanceof T.FogExp2);assert.equal((built.scene.getObjectByName('light-lava') as T.PointLight).intensity,12);animateScene(built.scene,doc,0,3);assert.notDeepEqual(Array.from(object.geometry.getAttribute('position').array),atTwo);animateScene(built.scene,doc,0,2);assert.deepEqual(Array.from(object.geometry.getAttribute('position').array),atTwo);animateScene(built.scene,doc,0,0);assert.equal(object.visible,false);animateScene(built.scene,doc,0,5);assert.equal(object.visible,false);}finally{disposeScene(built.scene);}
});
test('asset replacement preserves node identity and motion while updating material and source references',()=>{
  const doc=setup();doc.assets=[{id:'old',name:'old',type:'image',mimeType:'image/png',url:'data:image/png;base64,AAAA'},{id:'new',name:'new',type:'image',mimeType:'image/png',url:'data:image/png;base64,BBBB'}];doc.pages[0].nodes[0].scene!.material={textureAssetId:'old',normalTextureAssetId:'old',emissiveTextureAssetId:'old'};doc.pages[0].nodes.push({id:'poster',name:'poster',type:'image',src:doc.assets[0].url,x:0,y:0,width:10,height:10});doc.timeline={duration:1,fps:30,tracks:[{id:'motion',nodeId:'dragon',keyframes:[{time:0,values:{rotation:0}},{time:1,values:{rotation:10}}]}]};const original=JSON.stringify(doc),next=mutateDocument(doc,[{op:'replace-asset',assetId:'old',replacementId:'new'}]);assert.equal(JSON.stringify(doc),original);assert.deepEqual(next.timeline,doc.timeline);assert.equal(next.pages[0].nodes[0].id,'dragon');assert.deepEqual(next.pages[0].nodes[0].scene!.position,[0,0,0]);assert.equal(next.pages[0].nodes[0].scene!.material!.normalTextureAssetId,'new');assert.equal(next.pages[0].nodes[1].src,doc.assets[1].url);assert.equal(next.assets.length,2);assert.throws(()=>mutateDocument(doc,[{op:'replace-asset',assetId:'missing',replacementId:'new'}]));
});
test('review and editable export controls are bounded by the shared contract',()=>{assert(exportOptionsSchema.safeParse({format:'editable-scene',nodeId:'dragon'}).success);assert(exportOptionsSchema.safeParse({format:'scene-angles',start:0,end:2,reviewSamples:5}).success);assert(!exportOptionsSchema.safeParse({format:'scene-angles',reviewSamples:26}).success);assert(!exportOptionsSchema.safeParse({format:'scene-angles',reviewSamples:1}).success);});
