import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createDocument } from '../src/shared/catalog';
import { documentSchema } from '../src/shared/schema';

// Exercise real GLB import/export in the browser where FileReader and asset loading live.
const browserHarness = `
import * as THREE from 'three';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {buildScene, animateScene, disposeScene, exportScene} from './src/shared/scene-runtime';
import {inspectImportedScene, importedSampleValues} from './src/shared/scene-import';

async function fixture(extraObjects = 0) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,1,0, -1,1,0],3));
  geometry.setIndex([0,1,2]);
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0,0,0,0, 1,0,0,0, 1,0,0,0],4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1,0,0,0, 1,0,0,0, 1,0,0,0],4));
  geometry.morphTargetsRelative = true;
  const morph = new THREE.Float32BufferAttribute([0,0,0, 0,0,.5, 0,0,.5],3);
  morph.name = 'spread';
  geometry.morphAttributes.position = [morph];
  geometry.computeVertexNormals();
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({color:'#a45a25',roughness:.65,metalness:.2}));
  mesh.name = 'WingMesh';
  const root = new THREE.Bone(), tip = new THREE.Bone();
  root.name = 'RootJoint'; tip.name = 'WingJoint'; tip.position.y = 1;
  root.add(tip); mesh.add(root); mesh.bind(new THREE.Skeleton([root,tip]));
  const group = new THREE.Group(); group.name = 'SourceCreature'; group.add(mesh);
  for(let index=0;index<extraObjects;index++) {const object=new THREE.Group();object.name='StaticPart'+index;group.add(object);}
  const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2);
  const clip = new THREE.AnimationClip('flight',1,[
    new THREE.QuaternionKeyframeTrack('WingJoint.quaternion',[0,1],[0,0,0,1,...quaternion.toArray()]),
    new THREE.NumberKeyframeTrack('WingMesh.morphTargetInfluences',[0,1],[0,1]),
  ]);
  try {
    const bytes = await new GLTFExporter().parseAsync(group,{binary:true,animations:[clip]});
    const url = await new Promise(resolve => {const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(new Blob([bytes],{type:'model/gltf-binary'}));});
    return {url,magic:new TextDecoder().decode(new Uint8Array(bytes,0,4))};
  } finally { disposeScene(group); }
}

function snapshot(object) {
  let mesh;
  object.traverse(child => {if(child.isSkinnedMesh) mesh = child;});
  if(!mesh) throw new Error('Imported/exported GLB lost its skinned mesh');
  object.updateMatrixWorld(true); mesh.skeleton.update();
  return {
    quaternion:mesh.skeleton.bones[1].quaternion.toArray(),
    morph:mesh.morphTargetInfluences[0],
    vertex:mesh.getVertexPosition(1,new THREE.Vector3()).toArray(),
    boneCount:mesh.skeleton.bones.length,
    morphCount:mesh.geometry.morphAttributes.position.length,
    skinWeights:Array.from(mesh.geometry.getAttribute('skinWeight').array),
    inverseBinds:mesh.skeleton.boneInverses.map(matrix=>matrix.toArray()),
    color:mesh.material.color.getHexString(),
    roughness:mesh.material.roughness,
  };
}

globalThis.importHarness = {
  fixture,
  async sample(doc,times) {
    const built = await buildScene(doc,0,times[0]);
    try {
      const object = built.objects.get(doc.pages[0].nodes[0].id);
      const initial = snapshot(object), inventory = inspectImportedScene(object);
      const samples = times.map(time => {animateScene(built.scene,doc,0,time);return snapshot(object);});
      return {initial,inventory,samples};
    } finally {disposeScene(built.scene);}
  },
  async missing(doc) {
    try {const built = await buildScene(doc);disposeScene(built.scene);return null;}
    catch(error) {return String(error.message);}
  },
  async budget(doc) {
    const built = await buildScene(doc);
    let counts;
    try {counts = doc.pages[0].nodes.map(node => importedSampleValues(built.objects.get(node.id),node,Math.ceil(doc.timeline.duration*doc.timeline.fps)+1));}
    finally {disposeScene(built.scene);}
    try {await exportScene(doc,0,true);return {counts,error:null};}
    catch(error) {return {counts,error:String(error.message)};}
  },
  async roundTrip(doc,times) {
    const bytes = await exportScene(doc,0,true);
    const gltf = await new GLTFLoader().parseAsync(bytes,'');
    try {
      const mixer = new THREE.AnimationMixer(gltf.scene);
      if(!gltf.animations.length) throw new Error('Exported GLB lost imported clip animation');
      mixer.clipAction(gltf.animations[0]).setLoop(THREE.LoopOnce,1).play();
      const samples = times.map(time=>{mixer.setTime(time);return snapshot(gltf.scene);});
      return {magic:new TextDecoder().decode(new Uint8Array(bytes,0,4)),animationCount:gltf.animations.length,samples};
    } finally {disposeScene(gltf.scene);}
  },
};
`;

function close(actual: number, expected: number, message: string) {
  assert(Math.abs(actual - expected) < 1e-5, `${message}: expected ${expected}, received ${actual}`);
}

test('imported GLB clips preserve authored deformation during seek and export', { timeout: 90000 }, async t => {
  const bundle = await build({ stdin: { contents: browserHarness, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const fixture = await page.evaluate(() => (globalThis as any).importHarness.fixture());
    assert.equal(fixture.magic, 'glTF');
    const doc = createDocument('3d', 'Imported flight');
    doc.timeline = { duration: 2, fps: 20, tracks: [] };
    doc.pages[0].nodes = [{
      id: 'creature', name: 'Imported creature', type: 'model3d', x: 0, y: 0, width: 400, height: 400, src: fixture.url,
      scene: { position: [2, 0, 0], scale: [1, 1, 1], importedClips: [{ name: 'flight', start: .25, end: 1.75, loop: false }] },
    }];

    await t.test('the document contract retains clip placements and rejects invalid ranges', () => {
      const parsed = documentSchema.parse(doc);
      assert.deepEqual(parsed.pages[0].nodes[0].scene!.importedClips, doc.pages[0].nodes[0].scene!.importedClips);
      const invalid = structuredClone(doc);
      invalid.pages[0].nodes[0].scene!.importedClips![0].end = .1;
      assert.equal(documentSchema.safeParse(invalid).success, false);
    });

    await t.test('seeks backward deterministically and evaluates the initial requested time', async () => {
      const result = await page.evaluate(doc => (globalThis as any).importHarness.sample(doc, [.5, .75, .5]), doc);
      assert.deepEqual(result.initial, result.samples[0]);
      assert.deepEqual(result.samples[0], result.samples[2]);
      assert.deepEqual(result.inventory.clips, [{ name: 'flight', duration: 1, tracks: 2 }]);
      assert.deepEqual(result.inventory.bones, ['RootJoint', 'WingJoint']);
      assert.deepEqual(result.inventory.morphs, [{ mesh: 'WingMesh', names: ['spread'] }]);
      assert.equal(result.inventory.vertices, 3);
      assert.equal(result.inventory.triangles, 1);
      assert.equal(result.inventory.materials.length, 1);
      close(result.samples[0].morph, .25, 'Morph weight at clip time .25');
      close(result.samples[1].morph, .5, 'Morph weight at clip time .5');
      close(result.samples[0].quaternion[2], Math.sin(Math.PI / 16), 'Wing rotation at clip time .25');
      close(result.samples[1].quaternion[2], Math.sin(Math.PI / 8), 'Wing rotation at clip time .5');
      assert.notDeepEqual(result.samples[0].vertex, result.samples[1].vertex, 'Playback must deform actual vertices');
    });

    await t.test('placement speed, weight, looping and interval boundaries sample consistently', async () => {
      const scheduled = structuredClone(doc);
      scheduled.pages[0].nodes[0].scene!.importedClips![0] = { name: 'flight', start: .25, end: 1.75, speed: 2, weight: .5, loop: true };
      const result = await page.evaluate(doc => (globalThis as any).importHarness.sample(doc, [.9, 0, 1.75, 1.8, .9]), scheduled);
      close(result.samples[0].morph, .15, 'Looped source time with speed and blend weight');
      close(result.samples[1].morph, 0, 'Authored pose before placement');
      close(result.samples[2].morph, .5, 'Final boundary samples the source end');
      close(result.samples[3].morph, 0, 'Authored pose after placement');
      assert.deepEqual(result.samples[0], result.samples[4]);
      assert.deepEqual(result.samples[1].quaternion, [0, 0, 0, 1]);
      assert.deepEqual(result.samples[3].quaternion, [0, 0, 0, 1]);
    });

    await t.test('overlapping placements of the same source clip blend independent local times', async () => {
      const overlapping = structuredClone(doc);
      overlapping.pages[0].nodes[0].scene!.importedClips = [
        { name: 'flight', start: 0, end: 2, weight: .5 },
        { name: 'flight', start: .25, end: 2, weight: .5 },
      ];
      const result = await page.evaluate(doc => (globalThis as any).importHarness.sample(doc, [.75, .5, .75]), overlapping);
      close(result.samples[0].morph, .625, 'Two independent half-weight clip placements');
      close(result.samples[1].morph, .375, 'Overlapping clips after backward seek');
      assert.deepEqual(result.samples[0], result.samples[2]);
    });

    await t.test('missing requested source clips fail explicitly', async () => {
      const missing = structuredClone(doc);
      missing.pages[0].nodes[0].scene!.importedClips![0].name = 'lost-flight';
      const message = await page.evaluate(doc => (globalThis as any).importHarness.missing(doc), missing);
      assert.equal(typeof message, 'string');
      assert.match(message, /lost-flight/);
      assert.match(message, /clip/i);
    });

    await t.test('the export sample budget includes the sum of all imported models', async () => {
      const largeFixture = await page.evaluate(() => (globalThis as any).importHarness.fixture(100));
      const crowded = structuredClone(doc);
      crowded.timeline = { duration: 20, fps: 60, tracks: [] };
      crowded.pages[0].nodes[0].src = largeFixture.url;
      crowded.pages[0].nodes[0].scene!.importedClips = [{ name: 'flight', start: 0, end: 20 }];
      crowded.pages[0].nodes.push({ ...structuredClone(crowded.pages[0].nodes[0]), id: 'second-creature' });
      const result = await page.evaluate(doc => (globalThis as any).importHarness.budget(doc), crowded);
      assert(result.counts.every((count: number) => count < 2000000), 'Each imported model fits the individual budget');
      assert(result.counts.reduce((sum: number, count: number) => sum + count, 0) > 2000000, 'Together the models exceed the scene budget');
      assert.equal(typeof result.error, 'string');
      assert.match(result.error, /two million sampled values/i);
    });

    await t.test('exported GLB reopens with the same skeleton, morphs, material and sampled motion', async () => {
      const times = [.5, .75];
      const expected = await page.evaluate(({ doc, times }) => (globalThis as any).importHarness.sample(doc, times), { doc, times });
      const reopened = await page.evaluate(({ doc, times }) => (globalThis as any).importHarness.roundTrip(doc, times), { doc, times });
      assert.equal(reopened.magic, 'glTF');
      assert(reopened.animationCount > 0);
      for (let i = 0; i < times.length; i++) {
        const actual = reopened.samples[i], original = expected.samples[i];
        assert.equal(actual.boneCount, 2);
        assert.equal(actual.morphCount, 1);
        assert.deepEqual(actual.skinWeights, original.skinWeights);
        assert.deepEqual(actual.inverseBinds, original.inverseBinds);
        assert.equal(actual.color, original.color);
        close(actual.roughness, .65, 'Authored roughness');
        close(actual.morph, original.morph, 'Reopened morph weight');
        actual.quaternion.forEach((value: number, index: number) => close(value, original.quaternion[index], 'Reopened joint rotation'));
        actual.vertex.forEach((value: number, index: number) => close(value, original.vertex[index], 'Reopened deformed vertex'));
      }
    });
  } finally { await browser.close(); }
});
