import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import { createDocument } from '../src/shared/catalog';
import { mutateDocument } from '../src/shared/operations';
import { buildScene, meshData } from '../src/shared/scene-runtime';
import type { MeshData } from '../src/shared/design-capabilities';
import type { DesignDocument } from '../src/shared/schema';

const command = (doc: DesignDocument, command: unknown) => mutateDocument(doc, [{ op: 'scene-command', pageId: doc.pages[0].id, command }]);
/** A box with split UV seams on every face and two-bone skinning by height. */
function skinnedBox(): MeshData {
  const geometry = new T.BoxGeometry(1, 1, 1), mesh = meshData(geometry);
  geometry.dispose();
  const count = mesh.positions.length / 3;
  mesh.skinIndices = Array.from({ length: count }, () => [0, 1, 0, 0]).flat();
  mesh.skinWeights = Array.from({ length: count }, (_, i) => { const up = mesh.positions[i * 3 + 1] > 0 ? .75 : .25; return [1 - up, up, 0, 0]; }).flat();
  mesh.morphTargets = [{ name: 'lift', positions: Array.from({ length: count * 3 }, (_, i) => i % 3 === 1 ? .1 : 0) }];
  return mesh;
}
function setup(mesh = skinnedBox()) {
  const doc = createDocument('3d', 'Detail');
  doc.pages[0].nodes = [{ id: 'head', type: 'model3d', name: 'head', x: 0, y: 0, width: 400, height: 400, scene: { mesh, position: [0, 0, 0], scale: [1, 1, 1], bones: [{ name: 'root', parent: -1, position: [0, 0, 0] }, { name: 'top', parent: 0, position: [0, .5, 0] }] } }];
  return doc;
}
/** Edges used by only one triangle once coincident vertices are welded; a closed surface has none. */
function openEdges(mesh: MeshData) {
  const ids = new Map<string, number>(), weld = (i: number) => { const key = mesh.positions.slice(i * 3, i * 3 + 3).map(v => Math.round(v * 1e5)).join(','); if (!ids.has(key)) ids.set(key, ids.size); return ids.get(key)!; };
  const uses = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3) for (let j = 0; j < 3; j++) { const a = weld(mesh.indices[t + j]), b = weld(mesh.indices[t + (j + 1) % 3]), key = [a, b].sort((x, y) => x - y).join(':'); uses.set(key, (uses.get(key) ?? 0) + 1); }
  return [...uses.values()].filter(n => n === 1).length;
}

test('subdivide smooths across UV seams and keeps skinning, UVs and morphs aligned', () => {
  const before = skinnedBox(), triangles = before.indices.length / 3;
  const mesh = command(setup(), { action: 'subdivide', nodeId: 'head', iterations: 2 }).pages[0].nodes[0].scene!.mesh!;
  const count = mesh.positions.length / 3;
  assert.equal(mesh.indices.length / 3, triangles * 16);
  assert.equal(mesh.uv!.length, count * 2);
  assert.equal(mesh.skinIndices!.length, count * 4);
  assert.equal(mesh.morphTargets![0].positions.length, count * 3);
  for (let i = 0; i < count; i++) assert.ok(Math.abs(mesh.skinWeights!.slice(i * 4, i * 4 + 4).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(openEdges(before), 0);
  assert.equal(openEdges(mesh), 0, 'seams stay closed after smoothing');
  const radius = (m: MeshData) => Math.max(...Array.from({ length: m.positions.length / 3 }, (_, i) => Math.hypot(...m.positions.slice(i * 3, i * 3 + 3))));
  assert.ok(radius(mesh) < radius(before) * .8, 'box corners are rounded');
  const shaded = { ...skinnedBox(), normals: [] as number[] };
  shaded.normals = Array(shaded.positions.length).fill(0);
  const refreshed = command(setup(shaded), { action: 'subdivide', nodeId: 'head' }).pages[0].nodes[0].scene!.mesh!;
  assert.equal(refreshed.normals!.length, refreshed.positions.length, 'authored normals are recomputed for the new vertices');
});

test('linear subdivide keeps the surface and rejects meshes past the budget', () => {
  const mesh = command(setup(), { action: 'subdivide', nodeId: 'head', smooth: false }).pages[0].nodes[0].scene!.mesh!;
  for (let i = 0; i < mesh.positions.length / 3; i++) assert.ok(Math.abs(Math.max(...mesh.positions.slice(i * 3, i * 3 + 3).map(Math.abs)) - .5) < 1e-9);
  const geometry = new T.SphereGeometry(1, 256, 128), dense = meshData(geometry);
  geometry.dispose();
  assert.throws(() => command(setup(dense), { action: 'subdivide', nodeId: 'head', iterations: 3 }), /mesh budget/);
});

test('light command adds, patches, clears fields and removes page lights', () => {
  let doc = command(setup(), { action: 'light', id: 'belly', type: 'point', position: [0, 1, 1], intensity: 10, distance: 4 });
  assert.deepEqual(doc.pages[0].scene!.lights, [{ id: 'belly', type: 'point', position: [0, 1, 1], intensity: 10, distance: 4, color: '#ffffff' }]);
  doc = command(doc, { action: 'light', id: 'belly', intensity: 2, color: '#88ccff', distance: null });
  assert.deepEqual(doc.pages[0].scene!.lights, [{ id: 'belly', type: 'point', position: [0, 1, 1], intensity: 2, color: '#88ccff' }]);
  assert.throws(() => command(doc, { action: 'light', id: 'rim', intensity: 3 }), /needs type, position and intensity/);
  for (let i = 0; i < 7; i++) doc = command(doc, { action: 'light', id: `l${i}`, type: 'spot', position: [i, 2, 0], intensity: 1 });
  assert.throws(() => command(doc, { action: 'light', id: 'extra', type: 'point', position: [0, 0, 0], intensity: 1 }), /at most 8/);
  doc = command(doc, { action: 'light', id: 'belly', remove: true });
  assert.equal(doc.pages[0].scene!.lights!.length, 7);
  assert.throws(() => command(doc, { action: 'light', id: 'belly', remove: true }), /Unknown light/);
});

test('remove-node takes children, checkpoints and tracks but keeps shared rigs intact', () => {
  const doc = setup();
  doc.pages[0].nodes.push(
    { id: 'cone', type: 'model3d', name: 'cone', x: 0, y: 0, width: 400, height: 400, data: { geometry: 'cone' } },
    { id: 'cap', type: 'model3d', name: 'cap', parentId: 'cone', x: 0, y: 0, width: 400, height: 400, data: { geometry: 'sphere' } },
  );
  doc.timeline = { duration: 2, fps: 30, tracks: [{ id: 'cap-spin', nodeId: 'cap', keyframes: [] }] };
  let next = command(doc, { action: 'checkpoint', nodeId: 'cone', outputId: 'cone-v1' });
  next = command(next, { action: 'remove-node', nodeId: 'cone' });
  assert.deepEqual(next.pages[0].nodes.map(n => n.id), ['head']);
  assert.deepEqual(next.timeline!.tracks, []);
  const shared = setup();
  shared.pages[0].nodes.push({ id: 'jaw', type: 'model3d', name: 'jaw', x: 0, y: 0, width: 400, height: 400, scene: { mesh: skinnedBox(), rigId: 'head', bones: structuredClone(shared.pages[0].nodes[0].scene!.bones) } });
  assert.throws(() => command(shared, { action: 'remove-node', nodeId: 'head' }), /Remove jaw first/);
  assert.throws(() => command(shared, { action: 'remove-node', nodeId: 'missing' }), /Unknown node/);
});

test('fog:false draws a node without page fog', async () => {
  const doc = command(setup(), { action: 'material', nodeId: 'head', fog: false, emissive: '#ffffff' });
  assert.equal(doc.pages[0].nodes[0].scene!.material!.fog, false);
  const { scene } = await buildScene(doc);
  const material = (scene.getObjectByName('head') as T.Mesh).material as T.MeshStandardMaterial;
  assert.equal(material.fog, false);
  const restored = command(doc, { action: 'material', nodeId: 'head', fog: null });
  assert.equal(restored.pages[0].nodes[0].scene!.material!.fog, undefined);
});

test('ridged terrain sits flush and paints snow above the snow line', () => {
  const base = { action: 'terrain', outputId: 'range', size: [20, 20], resolution: 32, height: 5, seed: 4 };
  const plain = command(setup(), { ...base, shape: 'ridges' }).pages[0].nodes.find(n => n.id === 'range')!;
  assert.equal(plain.scene!.mesh!.colors, undefined, 'terrain without a snow line keeps its flat material color');
  const node = command(setup(), { ...base, shape: 'ridges', color: '#203040', snowLine: .4, snowColor: '#ffffff' }).pages[0].nodes.find(n => n.id === 'range')!;
  const mesh = node.scene!.mesh!, count = mesh.positions.length / 3;
  assert.equal(node.scene!.material!.color, '#FFFFFF', 'vertex colors carry the rock and snow tint');
  assert.equal(mesh.colors!.length, count * 3);
  const heights = Array.from({ length: count }, (_, i) => mesh.positions[i * 3 + 1]), peak = Math.max(...heights);
  assert.ok(peak > 1 && peak <= 5);
  for (let i = 0; i <= 32; i++) assert.equal(heights[i], 0, 'the footprint edge rests on the ground');
  const brightness = (i: number) => mesh.colors![i * 3] + mesh.colors![i * 3 + 1] + mesh.colors![i * 3 + 2];
  const top = heights.indexOf(peak), foot = 0;
  assert.ok(brightness(top) > 2.9, 'the summit is snow');
  assert.ok(brightness(foot) < .3, 'the foot is rock');
});

test('sculpt keeps seams closed, mirrors across x and brushes along a path', () => {
  const subdivided = command(setup(), { action: 'subdivide', nodeId: 'head', iterations: 2, smooth: false });
  for (const mode of ['inflate', 'crease', 'smooth', 'flatten', 'pinch', 'move'] as const) {
    const mesh = command(subdivided, { action: 'sculpt', nodeId: 'head', center: [.3, .5, .3], radius: .35, strength: .8, mode, delta: [0, .2, 0], symmetry: true }).pages[0].nodes[0].scene!.mesh!;
    assert.equal(openEdges(mesh), 0, `${mode} must move both sides of a UV seam together`);
    const key = (x: number, y: number, z: number) => [x, y, z].map(v => Math.round(v * 1e4)).join(',');
    const points = new Set(Array.from({ length: mesh.positions.length / 3 }, (_, i) => key(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2])));
    // Smoothing follows mesh connectivity, and this box's diagonals are not mirror symmetric.
    if (mode !== 'smooth') for (let i = 0; i < mesh.positions.length / 3; i++) assert.ok(points.has(key(-mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2])), `${mode} result is mirror symmetric`);
  }
  const top = (doc: DesignDocument) => { const p = doc.pages[0].nodes[0].scene!.mesh!.positions; return Array.from({ length: p.length / 3 }, (_, i) => p[i * 3 + 1]).filter(y => y > .5).length; };
  const dabbed = command(subdivided, { action: 'sculpt', nodeId: 'head', center: [-.5, .5, 0], radius: .2, strength: 1, mode: 'move', delta: [0, .1, 0] });
  const stroked = command(subdivided, { action: 'sculpt', nodeId: 'head', center: [-.5, .5, 0], path: [[.5, .5, 0]], radius: .2, strength: 1, mode: 'move', delta: [0, .1, 0] });
  assert.ok(top(stroked) > top(dabbed) * 2, 'a path raises the whole ridge, not one spot');
  assert.throws(() => command(subdivided, { action: 'sculpt', nodeId: 'head', center: [0, 0, 0], path: [[100, 0, 0]], radius: .01, mode: 'move' }), /path is too long/);
});
