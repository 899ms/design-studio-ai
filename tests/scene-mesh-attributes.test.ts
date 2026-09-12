import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { createDocument } from '../src/shared/catalog';
import { documentSchema } from '../src/shared/schema';
import { meshSchema, type MeshData } from '../src/shared/design-capabilities';
import { editableImport } from '../src/shared/scene-editable-import';
import { editMesh } from '../src/shared/mesh-editing';
import { sculpt, splitEdges, insertLoop } from '../src/shared/scene-brushes';
import { relax } from '../src/shared/scene-mesh-topology';
import { packUV } from '../src/shared/scene-uv';
import { transformMeshShading } from '../src/shared/mesh-shading';
import { geometryFor, buildScene, disposeScene } from '../src/shared/scene-runtime';

function convertedMesh() {
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3));
  geometry.setAttribute('uv', new T.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  geometry.setIndex([0, 1, 2, 1, 3, 2]);
  geometry.computeVertexNormals(); geometry.computeTangents();
  const scene = new T.Group(); scene.add(new T.Mesh(geometry, new T.MeshStandardMaterial()));
  const doc = createDocument('3d', 'Attributed imported mesh');
  doc.pages[0].nodes = [{ id: 'source', type: 'model3d', name: 'Source', src: 'https://studio.test/mesh.glb', x: 0, y: 0, width: 400, height: 400, scene: { position: [0, 0, 0], scale: [1, 1, 1] } }];
  try {
    const result = editableImport(doc, doc.pages[0].id, 'source', { scene, animations: [] } as unknown as GLTF);
    assert(documentSchema.safeParse(result.document).success);
    return result.document.pages[0].nodes.find(node => node.scene?.mesh)!.scene!.mesh!;
  } finally { disposeScene(scene); }
}

function validShading(mesh: MeshData) {
  assert(meshSchema.safeParse(mesh).success, JSON.stringify(meshSchema.safeParse(mesh)));
  assert.equal(mesh.normals?.length, mesh.positions.length);
  assert.equal(mesh.tangents?.length, mesh.positions.length / 3 * 4);
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const normal = new T.Vector3().fromArray(mesh.normals!, i * 3);
    const tangent = new T.Vector3().fromArray(mesh.tangents!, i * 4);
    assert(Number.isFinite(normal.length()) && Number.isFinite(tangent.length()));
    assert(Math.abs(normal.dot(tangent)) < 1e-5, 'Tangent must remain orthogonal to the updated normal');
    if (mesh.indices.includes(i)) assert.equal(Math.abs(mesh.tangents![i * 4 + 3]), 1);
  }
}

test('legacy topology edits retain valid shading buffers for converted attributed meshes', () => {
  for (const op of ['subdivide', 'extrude', 'inset', 'delete-faces', 'weld'] as const) {
    const input = convertedMesh(), before = structuredClone(input);
    const output = editMesh(input, { op, selection: [0], amount: .2 });
    validShading(output);
    assert.deepEqual(input, before, `${op} must not mutate the source mesh`);
  }
});

test('moving and sculpting vertices update surface normals and tangent directions', () => {
  const input = convertedMesh();
  const moved = editMesh(input, { op: 'translate', selection: [3], vector: [0, 0, 1] });
  validShading(moved);
  assert.notDeepEqual(moved.normals, input.normals);
  assert.notDeepEqual(moved.tangents, input.tangents);
  for (const mode of ['move', 'inflate', 'smooth'] as const) {
    const mesh = structuredClone(moved), before = [...mesh.normals!];
    sculpt(mesh, [1, 1, 1], 1.5, .4, mode, [0, 0, .6]);
    validShading(mesh);
    assert.notDeepEqual(mesh.normals, before, `${mode} must refresh shading after displacement`);
  }
  const relaxed = structuredClone(moved), old = [...relaxed.normals!];
  relax(relaxed, 1, .3); validShading(relaxed);
  assert.notDeepEqual(relaxed.normals, old);
});

test('edge and plane cuts interpolate aligned attributes without losing skin or morph data', async () => {
  for (const cut of ['edge', 'plane']) {
    const mesh = convertedMesh();
    mesh.skinIndices = Array(16).fill(0); mesh.skinWeights = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    mesh.morphTargets = [{ name: 'raise', positions: [0, 0, 0, 0, 0, 0, 0, 0, .5, 0, 0, .5] }];
    if (cut === 'edge') splitEdges(mesh, [[1, 2]]); else insertLoop(mesh, 0, .5);
    validShading(mesh);
    assert(mesh.positions.length > 12);
    assert.equal(mesh.skinIndices!.length, mesh.positions.length / 3 * 4);
    assert.equal(mesh.morphTargets![0].positions.length, mesh.positions.length);
    const doc = createDocument('3d', 'Refined skinned mesh');
    doc.pages[0].nodes = [{ id: 'mesh', type: 'model3d', name: 'Mesh', x: 0, y: 0, width: 400, height: 400, scene: { mesh, bones: [{ name: 'root', parent: -1, position: [0, 0, 0], rotation: [0, 0, 30] }], morphWeights: { raise: .5 }, position: [0, 0, 0], scale: [1, 1, 1] } }];
    assert(documentSchema.safeParse(doc).success);
    const built = await buildScene(doc);
    try {
      const skin = built.objects.get('mesh') as T.SkinnedMesh;
      built.scene.updateMatrixWorld(true); skin.skeleton.update();
      assert.equal(skin.geometry.getAttribute('normal').count, mesh.positions.length / 3);
      assert.equal(skin.geometry.getAttribute('tangent').count, mesh.positions.length / 3);
      assert.equal(skin.morphTargetInfluences![0], .5);
      const vertex = skin.getVertexPosition(2, new T.Vector3());
      assert(vertex.x < -.4 && vertex.z > .2, 'Refined mesh must still apply bone rotation and morph displacement');
    } finally { disposeScene(built.scene); }
  }
});

test('UV atlas seams preserve authored normals and regenerate tangents for the new islands', () => {
  const mesh = convertedMesh();
  const custom = new T.Vector3(.2, .1, 1).normalize();
  mesh.normals = Array.from({ length: 4 }, () => custom.toArray()).flat();
  const packed = packUV(mesh, []);
  validShading(packed);
  assert.equal(packed.positions.length / 3, 6);
  for (let index = 0; index < 6; index++) assert.deepEqual(packed.normals!.slice(index * 3, index * 3 + 3), custom.toArray());
  const originalUV = structuredClone(mesh.uv);
  const remapped = editMesh(mesh, { op: 'uv-sphere', selection: [] });
  validShading(remapped);
  assert.deepEqual(remapped.normals, mesh.normals);
  assert.notDeepEqual(remapped.uv, originalUV);
  const geometry = geometryFor({ id: 'packed', type: 'model3d', name: 'Packed', x: 0, y: 0, width: 400, height: 400, scene: { mesh: packed } });
  try { assert.equal(geometry.getAttribute('normal').count, geometry.getAttribute('position').count); }
  finally { geometry.dispose(); }
});

test('baked nonuniform mirrored transforms preserve orthogonal normals and tangent handedness', () => {
  const mesh = convertedMesh(), original = [...mesh.tangents!];
  const matrix = new T.Matrix4().makeRotationX(.4).multiply(new T.Matrix4().makeScale(-2, 3, 1));
  transformMeshShading(mesh, matrix);
  validShading(mesh);
  const expectedNormal = new T.Vector3(0, -Math.sin(.4), Math.cos(.4));
  assert(new T.Vector3().fromArray(mesh.normals!).distanceTo(expectedNormal) < 1e-5);
  assert.equal(mesh.tangents![3], -original[3]);
  assert(mesh.tangents![0] < -.99);
});
