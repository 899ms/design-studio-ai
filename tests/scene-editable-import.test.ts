import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createDocument } from '../src/shared/catalog';
import { documentSchema } from '../src/shared/schema';
import { mutateDocument } from '../src/shared/operations';

const browserHarness = `
import * as T from 'three';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {editableImport} from './src/shared/scene-editable-import';
import {buildScene,animateScene,exportScene,disposeScene} from './src/shared/scene-runtime';

async function fixture(mode) {
  const geometry=new T.BufferGeometry();
  geometry.setAttribute('position',new T.Float32BufferAttribute([-1,0,0, 1,0,0, -1,1,0, 1,1,0],3));
  geometry.setIndex([0,1,2, 1,3,2]);geometry.addGroup(0,3,0);geometry.addGroup(3,3,1);
  geometry.setAttribute('uv',new T.Float32BufferAttribute([0,0, 1,0, 0,1, 1,1],2));
  geometry.setAttribute('color',new T.Float32BufferAttribute([1,0,0, 0,1,0, 0,0,1, 1,1,1],3));
  geometry.setAttribute('skinIndex',new T.Uint16BufferAttribute([0,0,0,0, 0,0,0,0, 1,0,0,0, 1,0,0,0],4));
  geometry.setAttribute('skinWeight',new T.Float32BufferAttribute([1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0],4));
  geometry.morphTargetsRelative=true;
  const morph=new T.Float32BufferAttribute([0,0,0, 0,0,0, 0,0,.5, 0,0,.5],3);morph.name='spread';
  geometry.morphAttributes.position=[morph];geometry.computeVertexNormals();
  if(mode==='morph-collision'){
    morph.name='eye.left';
    const other=new T.Float32BufferAttribute([0,0,0,0,0,0,.3,0,0,.3,0,0],3);other.name='eye left';
    geometry.morphAttributes.position.push(other);
  }
  if(mode==='morph-normal')geometry.morphAttributes.normal=[new T.Float32BufferAttribute([0,0,0,0,0,0,0,.2,0,0,.2,0],3)];
  const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;
  const context=canvas.getContext('2d');
  for(const [index,color] of ['#ff0000','#00ff00','#0000ff','#ffffff'].entries()){context.fillStyle=color;context.fillRect(index%2,Math.floor(index/2),1,1);}
  const dataCanvas=canvas.cloneNode();dataCanvas.getContext('2d').drawImage(canvas,0,0);
  if(mode==='transparent')context.clearRect(0,0,1,1);
  const texture=new T.CanvasTexture(canvas);texture.flipY=false;texture.colorSpace=T.SRGBColorSpace;
  const normalCanvas=document.createElement('canvas');normalCanvas.width=2;normalCanvas.height=2;normalCanvas.getContext('2d').fillStyle='#80c0e0';normalCanvas.getContext('2d').fillRect(0,0,2,2);
  const normalTexture=new T.CanvasTexture(normalCanvas);normalTexture.flipY=false;
  const dataTexture=new T.CanvasTexture(dataCanvas);dataTexture.flipY=false;dataTexture.colorSpace=T.NoColorSpace;
  const materials=['#a45a25','#286bad'].map(color=>new T.MeshStandardMaterial({color,roughness:.65,metalness:.2,map:texture,normalMap:normalTexture,roughnessMap:dataTexture,metalnessMap:dataTexture,emissive:'#102030',emissiveIntensity:.5,emissiveMap:texture,side:T.DoubleSide,vertexColors:true}));
  if(mode==='transparent')materials.forEach(material=>material.transparent=true);
  if(mode==='physical')materials[0]=new T.MeshPhysicalMaterial({color:'#a45a25',clearcoat:1});
  if(mode==='physical-map')materials[0]=new T.MeshPhysicalMaterial({color:'#a45a25',specularIntensityMap:dataTexture});
  const mesh=new T.SkinnedMesh(geometry,materials);mesh.name='WingMesh';
  mesh.position.set(.3,.4,.2);
  const root=new T.Bone(),tip=new T.Bone();root.name='RootJoint';tip.name='WingJoint';tip.position.y=1;
  if(mode==='rest-scale')tip.scale.y=2;
  root.add(tip);mesh.add(root);
  const group=new T.Group();group.name='Creature';group.position.set(1,.5,-.25);group.rotation.z=.3;group.add(mesh);group.updateMatrixWorld(true);
  mesh.bind(new T.Skeleton([root,tip]));
  if(mode==='reordered-skin'){
    const inverses=mesh.skeleton.boneInverses;
    mesh.skeleton=new T.Skeleton([tip,root],[inverses[1],inverses[0]]);
    const indices=geometry.getAttribute('skinIndex');
    for(let i=0;i<indices.array.length;i++)indices.array[i]=1-indices.array[i];
  }
  const q=new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),Math.PI/2);
  const tracks=[new T.QuaternionKeyframeTrack('WingJoint.quaternion',[0,1],[0,0,0,1,...q.toArray()]),new T.NumberKeyframeTrack('WingMesh.morphTargetInfluences',[0,1],[0,1])];
  if(mode==='morph-collision')tracks[1]=new T.NumberKeyframeTrack('WingMesh.morphTargetInfluences',[0,1],[0,1,1,0]);
  if(mode==='rotation-wrap'){
    const start=new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),170*Math.PI/180),end=new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),190*Math.PI/180);
    tracks[0]=new T.QuaternionKeyframeTrack('WingJoint.quaternion',[0,1],[...start.toArray(),...end.toArray()]);
  }
  if(mode==='animated-scale')tracks.push(new T.VectorKeyframeTrack('WingJoint.scale',[0,1],[1,1,1,1,2,1]));
  try {
    const bytes=await new GLTFExporter().parseAsync(group,{binary:true,animations:[new T.AnimationClip('flight',1,tracks)]});
    return await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(new Blob([bytes],{type:'model/gltf-binary'}));});
  } finally {disposeScene(group);}
}

function pixels(texture,channel) {
  if(!texture)return null;
  const canvas=document.createElement('canvas');canvas.width=texture.image.width;canvas.height=texture.image.height;
  const context=canvas.getContext('2d');context.drawImage(texture.image,0,0);
  const rgba=Array.from(context.getImageData(0,0,canvas.width,canvas.height).data);
  // Roughness reads G and metalness reads B; GLTFExporter may repack the unused channels.
  return {pixels:channel===undefined?rgba:rgba.filter((_,index)=>index%4===channel),flipY:texture.flipY};
}

function snapshot(scene) {
  scene.updateMatrixWorld(true);const meshes=[];
  scene.traverseVisible(mesh=>{
    if(!mesh.isSkinnedMesh)return;mesh.skeleton.update();
    const material=mesh.material;
    meshes.push({color:material.color.getHexString(),roughness:material.roughness,metalness:material.metalness,
      emissive:material.emissive.getHexString(),emissiveIntensity:material.emissiveIntensity,side:material.side,normalScale:material.normalScale.toArray(),transparent:material.transparent,opacity:material.opacity,
      map:pixels(material.map),emissiveMap:pixels(material.emissiveMap),normalMap:pixels(material.normalMap),roughnessMap:pixels(material.roughnessMap,1),metalnessMap:pixels(material.metalnessMap,2),
      skinWeights:Array.from(mesh.geometry.getAttribute('skinWeight').array),
      uv:Array.from(mesh.geometry.getAttribute('uv').array),colors:Array.from(mesh.geometry.getAttribute('color').array),
      bones:mesh.skeleton.bones.length,morph:mesh.morphTargetInfluences[0],
      vertices:Array.from({length:mesh.geometry.getAttribute('position').count},(_,index)=>mesh.getVertexPosition(index,new T.Vector3()).applyMatrix4(mesh.matrixWorld).toArray()).flat(),
    });
  });
  return meshes.sort((a,b)=>a.color.localeCompare(b.color));
}

globalThis.editableHarness={
  async convert(input,mode='normal') {
    const doc=structuredClone(input);doc.pages[0].nodes[0].src=await fixture(mode);
    const before=JSON.stringify(doc),gltf=await new GLTFLoader().loadAsync(doc.pages[0].nodes[0].src);
    try {
      const result=editableImport(doc,doc.pages[0].id,doc.pages[0].nodes[0].id,gltf);
      return {result,input:doc,unchanged:JSON.stringify(doc)===before,error:null};
    } catch(error) {return {input:doc,unchanged:JSON.stringify(doc)===before,error:String(error.message)};}
    finally {disposeScene(gltf.scene);}
  },
  async sample(doc,times) {
    const built=await buildScene(doc,0,times[0]);
    try {return times.map(time=>{animateScene(built.scene,doc,0,time);return snapshot(built.scene);});}
    finally {disposeScene(built.scene);}
  },
  async reopen(doc,times) {
    const bytes=await exportScene(doc),gltf=await new GLTFLoader().parseAsync(bytes,'');
    try {
      const mixer=new T.AnimationMixer(gltf.scene);mixer.clipAction(gltf.animations[0]).setLoop(T.LoopOnce,1).play();
      return times.map(time=>{mixer.setTime(time);return snapshot(gltf.scene);});
    } finally {disposeScene(gltf.scene);}
  },
};
`;

function close(actual: number, expected: number, label: string) {
  assert(Math.abs(actual - expected) < 1e-4, `${label}: expected ${expected}, received ${actual}`);
}

function samePose(actual: any[], expected: any[], label: string) {
  assert.equal(actual.length, expected.length, `${label}: material groups`);
  actual.forEach((mesh, index) => {
    const source = expected[index];
    for (const property of ['color', 'roughness', 'metalness', 'emissive', 'emissiveIntensity', 'side', 'normalScale', 'transparent', 'opacity', 'map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'skinWeights', 'uv', 'colors', 'bones']) {
      assert.deepEqual(mesh[property], source[property], `${label}: ${property}`);
    }
    close(mesh.morph, source.morph, `${label}: morph`);
    assert.equal(mesh.vertices.length, source.vertices.length);
    mesh.vertices.forEach((value: number, axis: number) => close(value, source.vertices[axis], `${label}: vertex ${axis}`));
  });
}

test('editable import preserves real GLB geometry and animation in native document nodes', { timeout: 90000 }, async t => {
  const bundle = await build({ stdin: { contents: browserHarness, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://studio.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto('https://studio.test/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const doc = createDocument('3d', 'Editable imported flight');
    doc.timeline = { duration: 2, fps: 20, tracks: [] };
    doc.pages[0].nodes = [{ id: 'creature', name: 'Creature', type: 'model3d', x: 0, y: 0, width: 400, height: 400,
      scene: { position: [2, 0, 0], scale: [1, 1, 1], importedClips: [{ name: 'flight', start: .25, end: 1.25 }] } }];
    const converted = await page.evaluate(doc => (globalThis as any).editableHarness.convert(doc), doc);
    assert.equal(converted.error, null);
    const next = converted.result.document;

    await t.test('converted nodes validate and retain a hidden original checkpoint', () => {
      assert.equal(converted.unchanged, true);
      assert(documentSchema.safeParse(next).success, JSON.stringify(documentSchema.safeParse(next)));
      const nodes = next.pages[0].nodes;
      const checkpoint = nodes.find((node: any) => node.id === converted.result.report.sourceCheckpointId);
      assert.equal(checkpoint.src, converted.input.pages[0].nodes[0].src);
      assert.equal(checkpoint.visible, false);
      assert.equal(checkpoint.locked, true);
      assert.equal(checkpoint.data.sceneSourceCheckpoint, true);
      assert.deepEqual(checkpoint.scene.importedClips, doc.pages[0].nodes[0].scene!.importedClips);
      assert.equal(nodes.find((node: any) => node.id === 'creature').type, 'group');
      const meshes = nodes.filter((node: any) => node.scene?.mesh);
      assert.equal(meshes.length, 2);
      assert(meshes.every((node: any) => node.parentId === 'creature' && node.scene.bones.length === 2 && node.scene.mesh.morphTargets.length === 1));
      assert(next.assets.length > 0);
      assert(next.assets.every((asset: any) => asset.mimeType === 'image/png' && asset.url.startsWith('data:image/png;base64,')));
    });

    await t.test('native playback matches original world-space deformation and texture pixels', async () => {
      const times = [.2, .5, .75, 1.5, .5];
      const original = await page.evaluate(({ doc, times }) => (globalThis as any).editableHarness.sample(doc, times), { doc: converted.input, times });
      const editable = await page.evaluate(({ doc, times }) => (globalThis as any).editableHarness.sample(doc, times), { doc: next, times });
      times.forEach((time, index) => samePose(editable[index], original[index], `Time ${time}`));
      assert.notDeepEqual(original[1][0].vertices, original[2][0].vertices, 'The fixture must exercise actual skin/morph deformation');
    });

    await t.test('converted joints accept the existing native pose command and deform vertices', async () => {
      const paused = documentSchema.parse(next);
      paused.timeline!.tracks = [];
      const node = paused.pages[0].nodes.find(node => node.scene?.mesh)!;
      const posed = mutateDocument(paused, [{ op: 'scene-command', pageId: paused.pages[0].id, command: { action: 'pose', nodeId: node.id, bone: 'WingJoint', rotation: [0, 0, 30] } }]);
      assert.deepEqual(posed.pages[0].nodes.find(part => part.id === node.id)!.scene!.bones![1].rotation, [0, 0, 30]);
      const before = await page.evaluate(doc => (globalThis as any).editableHarness.sample(doc, [0]), paused);
      const after = await page.evaluate(doc => (globalThis as any).editableHarness.sample(doc, [0]), posed);
      assert.notDeepEqual(before[0].map((mesh: any) => mesh.vertices), after[0].map((mesh: any) => mesh.vertices));
    });

    await t.test('native GLB export reopens with original sampled deformation', async () => {
      const times = [.5, .75, 1.5];
      const original = await page.evaluate(({ doc, times }) => (globalThis as any).editableHarness.sample(doc, times), { doc: converted.input, times });
      const reopened = await page.evaluate(({ doc, times }) => (globalThis as any).editableHarness.reopen(doc, times), { doc: next, times });
      times.forEach((time, index) => samePose(reopened[index], original[index], `Reopened time ${time}`));
    });

    for (const mode of ['rest-scale', 'animated-scale']) {
      await t.test(`${mode} rejects unsupported bone scale without changing the input`, async () => {
        const result = await page.evaluate(({ doc, mode }) => (globalThis as any).editableHarness.convert(doc, mode), { doc, mode });
        assert.equal(result.unchanged, true);
        assert.equal(typeof result.error, 'string');
        assert.match(result.error, /bone scale|joint scale|armature scale/i);
      });
    }

    for (const [mode, error] of [['physical', /physical material/i], ['physical-map', /physical material/i], ['morph-normal', /morph normals/i]] as const) {
      await t.test(`${mode} conversion rejects unsupported source features explicitly`, async () => {
        const result = await page.evaluate(({ doc, mode }) => (globalThis as any).editableHarness.convert(doc, mode), { doc, mode });
        assert.equal(result.unchanged, true);
        assert.equal(typeof result.error, 'string');
        assert.match(result.error, error);
      });
    }

    await t.test('texture alpha blending survives native seeks and export when opacity is one', async () => {
      const result = await page.evaluate(doc => (globalThis as any).editableHarness.convert(doc, 'transparent'), doc);
      assert.equal(result.error, null);
      const times = [.5, .75];
      const original = await page.evaluate(({ doc, times }) => (globalThis as any).editableHarness.sample(doc, times), { doc: result.input, times });
      const editable = await page.evaluate(({ doc, times }) => (globalThis as any).editableHarness.sample(doc, times), { doc: result.result.document, times });
      const reopened = await page.evaluate(({ doc, times }) => (globalThis as any).editableHarness.reopen(doc, times), { doc: result.result.document, times });
      assert.equal(original[0][0].opacity, 1);
      assert.equal(original[0][0].transparent, true);
      assert.equal(original[0][0].map.pixels[3], 0);
      times.forEach((time, index) => {
        samePose(editable[index], original[index], `Transparent time ${time}`);
        samePose(reopened[index], original[index], `Transparent export time ${time}`);
      });
    });

    await t.test('baked Euler rotation follows the short arc across 180 degrees between frames', async () => {
      const result = await page.evaluate(doc => (globalThis as any).editableHarness.convert(doc, 'rotation-wrap'), doc);
      assert.equal(result.error, null);
      const times = [.725, .775, .825];
      const original = await page.evaluate(({ doc, times }) => (globalThis as any).editableHarness.sample(doc, times), { doc: result.input, times });
      const editable = await page.evaluate(({ doc, times }) => (globalThis as any).editableHarness.sample(doc, times), { doc: result.result.document, times });
      times.forEach((time, index) => samePose(editable[index], original[index], `Rotation wrap time ${time}`));
    });

    await t.test('unordered source joints become parent-first without changing skin deformation', async () => {
      const result = await page.evaluate(doc => (globalThis as any).editableHarness.convert(doc, 'reordered-skin'), doc);
      assert.equal(result.error, null);
      assert.equal(result.unchanged, true);
      assert(documentSchema.safeParse(result.result.document).success);
      const mesh = result.result.document.pages[0].nodes.find((node: any) => node.scene?.mesh);
      assert.deepEqual(mesh.scene.bones.map((bone: any) => [bone.name, bone.parent]), [['RootJoint', -1], ['WingJoint', 0]]);
      const times = [.2, .5, .75, 1.5, .5];
      const original = await page.evaluate(({ doc, times }) => (globalThis as any).editableHarness.sample(doc, times), { doc: result.input, times });
      const editable = await page.evaluate(({ doc, times }) => (globalThis as any).editableHarness.sample(doc, times), { doc: result.result.document, times });
      const reopened = await page.evaluate(({ doc, times }) => (globalThis as any).editableHarness.reopen(doc, times), { doc: result.result.document, times });
      times.forEach((time, index) => {
        samePose(editable[index], original[index], `Reordered skin time ${time}`);
        samePose(reopened[index], original[index], `Reordered skin export time ${time}`);
      });
    });

    await t.test('colliding sanitized morph names retain independent animation channels', async () => {
      const result = await page.evaluate(doc => (globalThis as any).editableHarness.convert(doc, 'morph-collision'), doc);
      assert.equal(result.error, null);
      assert(documentSchema.safeParse(result.result.document).success);
      const mesh = result.result.document.pages[0].nodes.find((node: any) => node.scene?.mesh);
      assert.deepEqual(mesh.scene.mesh.morphTargets.map((morph: any) => morph.name), ['eye_left', 'eye_left_2']);
      const times = [.25, .5, .75, 1.25];
      const original = await page.evaluate(({ doc, times }) => (globalThis as any).editableHarness.sample(doc, times), { doc: result.input, times });
      const editable = await page.evaluate(({ doc, times }) => (globalThis as any).editableHarness.sample(doc, times), { doc: result.result.document, times });
      const reopened = await page.evaluate(({ doc, times }) => (globalThis as any).editableHarness.reopen(doc, times), { doc: result.result.document, times });
      times.forEach((time, index) => {
        samePose(editable[index], original[index], `Morph names time ${time}`);
        samePose(reopened[index], original[index], `Morph names export time ${time}`);
      });
    });

    await t.test('conversion rejects timelines exceeding the native keyframe limit without mutating input', async () => {
      const long = structuredClone(doc);
      long.timeline!.duration = 120;
      const result = await page.evaluate(doc => (globalThis as any).editableHarness.convert(doc), long);
      assert.equal(result.unchanged, true);
      assert.equal(typeof result.error, 'string');
      assert.match(result.error, /2,?000.*key|keyframe.*limit/i);
    });
  } finally { await browser.close(); }
});
