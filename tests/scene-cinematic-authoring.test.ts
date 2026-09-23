import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import { createDocument } from '../src/shared/catalog';
import { mutateDocument } from '../src/shared/operations';
import { cameraAt } from '../src/shared/scene-runtime';
import { addSceneEffects, animateSceneEffects, sceneUsesPostProcessing } from '../src/shared/scene-effects';
import { inspectScene } from '../src/shared/scene-inspection';
import { documentChanges, projectSummary, summarizeScene } from '../src/shared/document-change-summary';
import { documentSchema, type DesignDocument } from '../src/shared/schema';
import { visualInspectionSchema } from '../src/shared/visual-inspection';
import { operationJobSchema } from '../src/shared/operation-jobs';
import { emitterPresets } from '../src/shared/scene-presets';

function setup() {
  const doc = createDocument('3d', 'Ice dragon');
  doc.pages[0].nodes = [{ id: 'body', type: 'model3d', name: 'body', x: 0, y: 0, width: 400, height: 400, data: { geometry: 'sphere' }, scene: { position: [0, 0, 0], scale: [1, 1, 1] } }];
  return doc;
}
const command = (doc: DesignDocument, command: unknown) => mutateDocument(doc, [{ op: 'scene-command', pageId: doc.pages[0].id, command }]);
const positions = (scene: T.Scene, id: string) => [...(scene.getObjectByName(`emitter-${id}`) as T.Points).geometry.getAttribute('position').array];

test('camera keys interpolate with easing and clamp outside their range', () => {
  const camera = { position: [0, 0, 10] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 40, keys: [
    { time: 2, position: [10, 0, 0] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 60, ease: 'linear' as const },
    { time: 0, position: [0, 0, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], ease: 'linear' as const },
  ] };
  assert.deepEqual(cameraAt(camera, -1).position, [0, 0, 0]);
  assert.deepEqual(cameraAt(camera, 5).position, [10, 0, 0]);
  const middle = cameraAt(camera, 1);
  assert.ok(Math.abs(middle.position[0] - 5) < 1e-9);
  assert.ok(Math.abs(middle.fov - 50) < 1e-9, 'a key without fov inherits the base camera fov');
  assert.deepEqual(cameraAt({ ...camera, keys: undefined }, 1).position, [0, 0, 10]);
  camera.keys[1].ease = 'ease-in' as 'linear';
  assert.ok(cameraAt(camera, .5).position[0] < 2.5, 'ease-in starts slower than linear');
});

test('page commands never turn a 2D page into a 3D scene', () => {
  const web = createDocument('web', 'Landing');
  assert.throws(() => command(web, { action: 'environment', ambient: .5 }), /3D project page/);
  assert.equal(web.pages[0].scene, undefined);
});

test('page commands merge camera, keys, lighting and rendering without replacing the scene', () => {
  let doc = command(setup(), { action: 'camera', position: [1, 2, 3], fov: 30 });
  assert.deepEqual(doc.pages[0].scene!.camera.position, [1, 2, 3]);
  assert.equal(doc.pages[0].scene!.camera.fov, 30);
  assert.deepEqual(doc.pages[0].scene!.camera.target, [0, .5, 0], 'unspecified fields keep the default scene values');
  doc = command(doc, { action: 'camera-key', time: 3, position: [0, 1, 8], target: [0, 1, 0] });
  doc = command(doc, { action: 'camera-key', time: 0, position: [4, 1, 8], target: [0, 1, 0], ease: 'ease-out' });
  doc = command(doc, { action: 'camera-key', time: 3, fov: 25 });
  assert.deepEqual(doc.pages[0].scene!.camera.keys!.map(key => key.time), [0, 3]);
  assert.equal(doc.pages[0].scene!.camera.keys![1].fov, 25);
  assert.deepEqual(doc.pages[0].scene!.camera.keys![1].position, [0, 1, 8]);
  assert.ok(doc.timeline!.duration >= 3);
  assert.throws(() => command(doc, { action: 'camera-key', time: 9, fov: 40 }), /position and target/);
  doc = command(doc, { action: 'camera-key', time: 0, remove: true });
  assert.equal(doc.pages[0].scene!.camera.keys!.length, 1);
  assert.throws(() => command(doc, { action: 'camera-key', time: 7, remove: true }), /No camera key/);

  doc = command(doc, { action: 'environment', ambient: .4, light: { intensity: 6 }, atmosphere: { fogDensity: .05 }, rendering: { bloom: .8, vignette: .3, environment: 'sky', sky: { elevation: 8, azimuth: 120 } } });
  const scene = doc.pages[0].scene!;
  assert.equal(scene.ambient, .4);
  assert.equal(scene.light.intensity, 6);
  assert.equal(scene.light.color, '#ffffff');
  assert.equal(scene.atmosphere!.fogDensity, .05);
  assert.equal(scene.rendering!.environment, 'sky');
  assert.ok(sceneUsesPostProcessing(doc.pages[0]));
  doc = command(doc, { action: 'environment', rendering: { vignette: null, grain: .2 } });
  assert.equal(doc.pages[0].scene!.rendering!.vignette, undefined);
  assert.equal(doc.pages[0].scene!.rendering!.bloom, .8);
  assert.throws(() => command(doc, { action: 'environment', rendering: { blooom: 1 } }), /Unknown rendering setting: blooom/);
  assert.throws(() => command(doc, { action: 'environment', rendering: { environment: 'panorama' } }), /environmentAssetId/);
  doc = command(doc, { action: 'environment', atmosphere: null, rendering: null });
  assert.equal(doc.pages[0].scene!.atmosphere, undefined);
  assert.equal(doc.pages[0].scene!.rendering, undefined);
});

test('emitter presets merge under explicit fields with a stable seed and a page limit', () => {
  let doc = command(setup(), { action: 'emitter', id: 'breath', preset: 'frost-breath', position: [0, 3, 2] });
  const breath = doc.pages[0].scene!.emitters![0];
  assert.deepEqual(breath.position, [0, 3, 2]);
  assert.equal(breath.sprite, emitterPresets['frost-breath'].sprite);
  const seed = breath.seed;
  doc = command(doc, { action: 'emitter', id: 'breath', count: 400 });
  assert.equal(doc.pages[0].scene!.emitters![0].count, 400);
  assert.deepEqual(doc.pages[0].scene!.emitters![0].position, [0, 3, 2], 'a later edit keeps earlier explicit values');
  assert.equal(doc.pages[0].scene!.emitters![0].seed, seed);
  assert.throws(() => command(doc, { action: 'emitter', id: 'bare', count: 10 }), /position|Invalid/);
  for (let i = 0; i < 7; i++) doc = command(doc, { action: 'emitter', id: `snow-${i}`, preset: 'snowfall' });
  assert.throws(() => command(doc, { action: 'emitter', id: 'ninth', preset: 'snowfall' }), /at most 8/);
  doc = command(doc, { action: 'remove-emitter', id: 'breath' });
  assert.equal(doc.pages[0].scene!.emitters!.length, 7);
  assert.throws(() => command(doc, { action: 'remove-emitter', id: 'breath' }), /Unknown emitter/);
});

test('particles are deterministic and styling options keep the legacy spawn positions', () => {
  const base = { id: 'snow', position: [0, 2, 0] as [number, number, number], spread: [4, 1, 4] as [number, number, number], velocity: [0, -.5, 0] as [number, number, number], count: 64, size: .05, color: '#ffffff', lifetime: 4, seed: 7 };
  const build = (emitter: object, time: number) => { const doc = setup(); doc.pages[0].scene = { camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 40 }, ambient: 1, light: { position: [1, 1, 1], intensity: 1, color: '#ffffff' }, emitters: [emitter as typeof base] }; const scene = new T.Scene(); addSceneEffects(scene, doc.pages[0]); animateSceneEffects(scene, time); return scene; };
  assert.deepEqual(positions(build(base, 1.3), 'snow'), positions(build(base, 1.3), 'snow'));
  const styled = build({ ...base, sprite: 'flake', blending: 'normal', fadeIn: .2, fadeOut: .2, sizeVariance: .5 }, 1.3);
  assert.deepEqual(positions(styled, 'snow'), positions(build(base, 1.3), 'snow'));
  assert.ok((styled.getObjectByName('emitter-snow') as T.Points).material instanceof T.ShaderMaterial);
  assert.ok((build(base, 0).getObjectByName('emitter-snow') as T.Points).material instanceof T.PointsMaterial);
  const moved = positions(build({ ...base, gravity: [0, -9.8, 0], turbulence: .5, swirl: 1 }, 1.3), 'snow');
  assert.notDeepEqual(moved, positions(build(base, 1.3), 'snow'));
  assert.deepEqual(moved, positions(build({ ...base, gravity: [0, -9.8, 0], turbulence: .5, swirl: 1 }, 1.3), 'snow'));
});

test('material edits merge physical and bloom fields without touching geometry', () => {
  let doc = command(setup(), { action: 'convert', nodeId: 'body' });
  doc = command(doc, { action: 'material', nodeId: 'body', color: '#aee4ff', roughness: .3 });
  const mesh = JSON.stringify(doc.pages[0].nodes[0].scene!.mesh);
  doc = command(doc, { action: 'material', nodeId: 'body', transmission: .7, ior: 1.31, bloom: false, opacity: .9 });
  const node = doc.pages[0].nodes[0];
  assert.deepEqual({ color: node.scene!.material!.color, roughness: node.scene!.material!.roughness, transmission: node.scene!.material!.transmission, bloom: node.scene!.material!.bloom }, { color: '#aee4ff', roughness: .3, transmission: .7, bloom: false });
  assert.equal(node.opacity, .9);
  assert.equal(JSON.stringify(node.scene!.mesh), mesh);
  assert.throws(() => command(doc, { action: 'material', nodeId: 'body', ior: 5 }));
  doc = command(doc, { action: 'material', nodeId: 'body', transmission: null, ior: null });
  assert.deepEqual(doc.pages[0].nodes[0].scene!.material, { color: '#aee4ff', roughness: .3, bloom: false }, 'null removes a field so the renderer default applies');
  doc = command(doc, { action: 'material', nodeId: 'body', color: null, roughness: null, bloom: null });
  assert.equal(doc.pages[0].nodes[0].scene!.material, undefined);
});

test('terrain is deterministic, faces upward and sits at its requested position', () => {
  const doc = command(setup(), { action: 'terrain', outputId: 'peak', shape: 'mountain', size: [10, 10], resolution: 16, height: 3, seed: 5, position: [0, -1, 0] });
  const again = command(setup(), { action: 'terrain', outputId: 'peak', shape: 'mountain', size: [10, 10], resolution: 16, height: 3, seed: 5, position: [0, -1, 0] });
  const terrain = doc.pages[0].nodes.find(node => node.id === 'peak')!;
  assert.deepEqual(terrain.scene!.mesh, again.pages[0].nodes.find(node => node.id === 'peak')!.scene!.mesh);
  assert.deepEqual(terrain.scene!.position, [0, -1, 0]);
  const mesh = terrain.scene!.mesh!, geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute(mesh.positions, 3)); geometry.setIndex(mesh.indices); geometry.computeVertexNormals();
  const normals = geometry.getAttribute('normal');
  let upward = 0; for (let i = 0; i < normals.count; i++) if (normals.getY(i) > 0) upward++;
  assert.equal(upward, normals.count);
  const report = inspectScene(doc).pages[0].nodes.find(node => node.id === 'peak')!;
  assert.ok('issues' in report && !report.issues.some(issue => /non-manifold|winding|degenerate/.test(issue)));
  const other = command(setup(), { action: 'terrain', outputId: 'peak', resolution: 16, seed: 6 });
  assert.notDeepEqual(other.pages[0].nodes.find(node => node.id === 'peak')!.scene!.mesh!.positions, mesh.positions);
  assert.throws(() => command(doc, { action: 'terrain', outputId: 'peak' }), /already exists/);
});

test('tail-swipe animates tail bones and breath-attack requires a jaw', () => {
  let doc = command(setup(), { action: 'convert', nodeId: 'body' });
  doc = command(doc, { action: 'rig-quadruped', nodeId: 'body' });
  doc = command(doc, { action: 'clip', nodeId: 'body', preset: 'tail-swipe', duration: 1.5 });
  const track = doc.timeline!.tracks.find(t => t.clipName === 'tail-swipe-0')!;
  const bones = doc.pages[0].nodes[0].scene!.bones!, tail = bones.findIndex(b => b.name === 'tail3');
  const values = track.keyframes.map(frame => Number(frame.values[`scene.bones.${tail}.rotation.z`]));
  assert.ok(Math.max(...values) - Math.min(...values) > 20, 'the swipe sweeps the tail tip');
  assert.throws(() => command(doc, { action: 'clip', nodeId: 'body', preset: 'breath-attack', start: 2 }), /jaw/);
});

test('summary responses report changed IDs and compact scene data', () => {
  const before = command(setup(), { action: 'convert', nodeId: 'body' });
  const after = command(command(before, { action: 'emitter', id: 'snow', preset: 'snowfall' }), { action: 'material', nodeId: 'body', color: '#ffffff' });
  const changes = documentChanges(before, after);
  assert.deepEqual(changes.changedNodeIds, ['body']);
  assert.deepEqual(changes.changedPageIds, [after.pages[0].id]);
  const saved = structuredClone(after); saved.metadata = { ...saved.metadata, updatedAt: '2099-01-01T00:00:00.000Z' };
  assert.equal(documentChanges(before, saved).documentSettingsChanged, false, 'A save timestamp is not a settings change');
  const summary = summarizeScene(inspectScene(after), after);
  const node = summary.pages[0].nodes[0] as Record<string, unknown>;
  assert.equal(node.diagnostics, undefined);
  assert.equal(typeof node.bones, 'number');
  assert.deepEqual(summary.pages[0].scene!.emitters, ['snow']);
  assert.deepEqual(projectSummary({ id: 'p', revision: 2, document: after }), { id: 'p', revision: 2 });
});

test('contracts validate panoramas, camera overrides and durable scene jobs', () => {
  const doc = setup();
  doc.pages[0].scene = { camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 40 }, ambient: 1, light: { position: [1, 1, 1], intensity: 1, color: '#ffffff' }, rendering: { environment: 'panorama', environmentAssetId: 'missing' } };
  assert.match(JSON.stringify(documentSchema.safeParse(doc).error?.issues), /PNG, JPEG or WebP/);
  assert.ok(visualInspectionSchema.safeParse({ mode: 'page', camera: { position: [1, 2, 3], target: [0, 0, 0] } }).success);
  assert.ok(!visualInspectionSchema.safeParse({ camera: { position: [1, 2, 3], target: [0, 0, 0] } }).success);
  const job = operationJobSchema.parse({ kind: 'scene', operationId: 'remesh-1', input: { pageId: 'page', expectedRevision: 3, command: { action: 'convert', nodeId: 'body' } } });
  assert.equal(job.kind, 'scene');
  assert.ok(!('preview' in job.input));
});
