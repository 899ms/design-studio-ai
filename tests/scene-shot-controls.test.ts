import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { PerspectiveCamera, Vector3 } from 'three';
import { createDocument } from '../src/shared/catalog';
import { documentSchema } from '../src/shared/schema';
import { duplicateSceneShot } from '../src/shared/scene-shot-operations';
import { fitSceneCamera, boxCorners } from '../src/shared/scene-shot';
import { Box3 } from 'three';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SceneView } from '../src/app/scene-view';
import { DocumentView } from '../src/app/document-view';

test('portrait shot duplicates remap rigs, parents and animation while retaining assets', () => {
  const doc = createDocument('3d', 'Shots'), page = doc.pages[0];
  page.width = 800; page.height = 600;
  const mesh = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], skinIndices: Array(12).fill(0), skinWeights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] };
  page.nodes = [
    { id: 'group', name: 'Group', type: 'group', x: 0, y: 0, width: 200, height: 200 },
    { id: 'rig', name: 'Rig', type: 'model3d', parentId: 'group', x: 200, y: 100, width: 200, height: 200, scene: { mesh, bones: [{ name: 'root', parent: -1, position: [0, 0, 0] }] }, interactions: [{ trigger: 'click', action: 'toggle', target: 'skin' }] },
    { id: 'skin', name: 'Skin', type: 'model3d', x: 200, y: 100, width: 200, height: 200, data: { rigSourceId: 'rig' }, scene: { mesh, rigId: 'rig', material: { textureAssetId: 'texture' } } },
  ];
  doc.assets = [{ id: 'texture', name: 'Texture', type: 'image', mimeType: 'image/png', url: 'https://example.com/texture.png' }];
  doc.timeline = { duration: 2, fps: 30, tracks: [{ id: 'travel', nodeId: 'rig', keyframes: [{ time: 0, values: { x: 200 } }, { time: 2, values: { x: 500 } }] }] };
  const before = structuredClone(doc), result = duplicateSceneShot(documentSchema.parse(doc), page.id, 'portrait');
  assert.deepEqual(doc, before); assert.deepEqual(result.document.assets, doc.assets); assert.equal(result.document.pages.length, doc.pages.length + 1);
  const shot = result.document.pages.find(p => p.id === result.pageId)!;
  assert.deepEqual([shot.width, shot.height], [1080, 1920]);
  const rig = shot.nodes.find(n => n.id === result.nodeIds.rig)!, skin = shot.nodes.find(n => n.id === result.nodeIds.skin)!;
  assert.equal(rig.parentId, result.nodeIds.group); assert.equal(skin.scene?.rigId, rig.id); assert.equal(skin.scene?.material?.textureAssetId, 'texture'); assert.equal(rig.interactions?.[0].target, skin.id);
  assert.equal(skin.data?.rigSourceId, rig.id);
  assert.equal((rig.x + rig.width / 2 - shot.width / 2) / 240, (page.nodes[1].x + 100 - page.width / 2) / 240);
  const track = result.document.timeline!.tracks.find(t => t.nodeId === rig.id)!;
  assert.notEqual(track.id, 'travel'); assert.equal(track.keyframes[1].values.x, 640);
  assert.equal(duplicateSceneShot(doc, page.id, 'square').document.pages[1].height, 1080);
});

test('safe frame stays in authoring and native media controls yield to timeline audio', () => {
  const doc = createDocument('3d', 'Authoring guide'), page = doc.pages[0];
  page.scene = { camera: { position: [0, 0, 8], target: [0, 0, 0], fov: 40, safeFrame: .15 }, ambient: 2, light: { position: [3, 4, 5], intensity: 4, color: '#ffffff' } };
  const props = { page, theme: doc.theme, selected: null, onSelect: () => {}, doc };
  const authoring = renderToStaticMarkup(createElement(SceneView, { ...props, onPage: () => {} }));
  assert.match(authoring, /data-scene-safe-frame/); assert.match(authoring, /inset:15%/); assert.match(authoring, /pointer-events:none/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(SceneView, props)), /data-scene-safe-frame/);
  page.nodes = [{ id: 'audio', name: 'Audio', type: 'audio', x: 0, y: 0, width: 100, height: 30, src: 'https://example.com/audio.wav' }];
  doc.timeline = { duration: 2, fps: 30, tracks: [] };
  const timed = renderToStaticMarkup(createElement(DocumentView, { doc })); assert.match(timed, /<audio[^>]*muted=/); assert.doesNotMatch(timed, /<audio[^>]*controls=/);
  doc.timeline = undefined; assert.match(renderToStaticMarkup(createElement(DocumentView, { doc })), /<audio[^>]*controls=/);
});

test('camera fitting includes animated bounds and requested safe margins', async () => {
  const doc = createDocument('3d', 'Moving subject'), page = doc.pages[0];
  page.width = 1080; page.height = 1920;
  page.nodes = [{ id: 'moving', type: 'model3d', name: 'Moving sphere', x: 0, y: 0, width: 200, height: 200, scene: { position: [0, 0, 0] }, data: { geometry: 'sphere' } }];
  page.scene = { camera: { position: [0, 0, 8], target: [0, 0, 0], fov: 40, safeFrame: .15 }, ambient: 2, light: { position: [3, 4, 5], intensity: 4, color: '#ffffff' } };
  doc.timeline = { duration: 2, fps: 30, tracks: [{ id: 'move', nodeId: 'moving', keyframes: [{ time: 0, values: { 'scene.position.x': -5 } }, { time: 2, values: { 'scene.position.x': 5 } }] }] };
  const fitted = await fitSceneCamera(doc, page.id, ['moving'], 33);
  assert.ok(fitted.bounds.min[0] < -5); assert.ok(fitted.bounds.max[0] > 5);
  const camera = new PerspectiveCamera(fitted.camera.fov, page.width / page.height, .01, 10000); camera.position.fromArray(fitted.camera.position); camera.lookAt(new Vector3(...fitted.camera.target)); camera.updateMatrixWorld(true);
  const box = new Box3(new Vector3(...fitted.bounds.min), new Vector3(...fitted.bounds.max));
  for (const corner of boxCorners(box)) { const point = corner.project(camera); assert.ok(Math.abs(point.x) <= .7001 && Math.abs(point.y) <= .7001); }
});

test('environment and shot controls persist real settings at desktop and mobile widths', { timeout: 60000 }, async () => {
  const bundle = await build({ stdin: { contents: `
    import {createElement,useState} from 'react';import {createRoot} from 'react-dom/client';import {SceneInspector} from './src/app/scene-inspector';import {documentSchema} from './src/shared/schema';
    globalThis.mountSceneControls=initial=>{function Controls(){const [doc,setDoc]=useState(initial);globalThis.sceneDocument=doc;return createElement(SceneInspector,{doc,page:doc.pages[0],update:()=>{},pageUpdate:patch=>setDoc(current=>documentSchema.parse({...current,pages:current.pages.map((p,i)=>i===0?{...p,...patch}:p)})),onDocument:setDoc});}createRoot(document.getElementById('root')).render(createElement(Controls));};`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.route('http://localhost/scene-controls-test', route => route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root" style="max-width:320px"></div></body></html>' }));
      await page.goto('http://localhost/scene-controls-test');
      await page.addStyleTag({ content: await readFile('src/styles.css', 'utf8') }); await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const doc = createDocument('3d', 'Shot controls'); doc.pages[0].nodes = [{ id: 'sphere', name: 'Sphere', type: 'model3d', x: 200, y: 200, width: 200, height: 200, data: { geometry: 'sphere' } }]; doc.timeline = { duration: 2, fps: 30, tracks: [] };
      await page.evaluate(doc => (globalThis as any).mountSceneControls(doc), doc);
      await page.getByText('Additional lights', { exact: true }).click(); await page.getByRole('button', { name: 'Add light', exact: true }).click();
      await page.getByRole('spinbutton', { name: 'Light 1 intensity', exact: true }).fill('12');
      await page.getByRole('combobox', { name: 'Light 1 type', exact: true }).selectOption('spot');
      await expect(page.getByRole('spinbutton', { name: 'Light 1 cone angle (radians)', exact: true })).toBeVisible();
      await page.getByText('Atmosphere and rendering', { exact: true }).click(); await page.getByRole('checkbox', { name: 'Fog', exact: true }).check(); await page.getByRole('checkbox', { name: 'Enhanced rendering', exact: true }).check();
      await page.getByRole('spinbutton', { name: 'Bloom strength', exact: true }).fill('1.2');
      await page.getByText('Particle emitters', { exact: true }).click(); await page.getByRole('button', { name: 'Add emitter', exact: true }).click(); await page.getByRole('spinbutton', { name: 'Emitter 1 particle count', exact: true }).fill('80');
      await page.getByRole('spinbutton', { name: 'Safe frame margin (%)', exact: true }).fill('15');
      const settings = await page.evaluate(() => (globalThis as any).sceneDocument.pages[0].scene);
      assert.equal(settings.lights[0].intensity, 12); assert.equal(settings.rendering.bloom, 1.2); assert.equal(settings.atmosphere.fogDensity, .02); assert.equal(settings.emitters[0].count, 80); assert.equal(settings.camera.safeFrame, .15);
      await page.getByRole('button', { name: 'Create 9:16 shot', exact: true }).click(); await expect(page.getByRole('status')).toContainText('Created');
      const saved = await page.evaluate(() => (globalThis as any).sceneDocument); assert.equal(saved.pages[1].width, 1080); assert.equal(saved.pages[1].height, 1920); assert.equal(saved.pages[1].scene.camera.safeFrame, .15);
      await page.getByRole('button', { name: 'Remove light 1', exact: true }).click(); await page.getByRole('button', { name: 'Remove emitter 1', exact: true }).click();
      const cleared = await page.evaluate(() => (globalThis as any).sceneDocument.pages[0].scene); assert.equal(cleared.lights.length, 0); assert.equal(cleared.emitters.length, 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Controls overflow at ${width}px`); await page.close();
    }
  } finally { await browser.close(); }
});
