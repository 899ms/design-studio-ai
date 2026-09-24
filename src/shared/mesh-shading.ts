import { BufferGeometry, Float32BufferAttribute, Matrix3, Matrix4, Vector3 } from 'three';
import type { MeshData } from './design-capabilities';

/**
 * Share recomputed normals across coincident vertices so UV seams do not shade as creases.
 * With previous normals, only copies that were already smooth are joined, keeping authored hard edges.
 */
function weldNormals(positions: number[], normals: ArrayLike<number>, previous?: number[]) {
  const groups = new Map<string, number[]>(), result = Array.from(normals), sum = new Vector3(), other = new Vector3();
  for (let i = 0; i < positions.length / 3; i++) { const key = [0, 1, 2].map(a => Math.round(positions[i * 3 + a] * 1e5)).join(','); const group = groups.get(key); if (group) group.push(i); else groups.set(key, [i]); }
  for (const group of groups.values()) if (group.length > 1) for (const i of group) {
    sum.set(0, 0, 0);
    for (const j of group) if (!previous || previous.length !== positions.length || other.fromArray(previous, j * 3).dot(new Vector3().fromArray(previous, i * 3)) > .5) sum.add(other.fromArray(normals, j * 3));
    if (sum.lengthSq() > 1e-24) sum.normalize().toArray(result, i * 3);
  }
  return result;
}

/** Refresh authored shading buffers after a geometry or UV edit; `weld` joins normals across seams ('smooth' keeps hard edges). */
export function refreshMeshShading(mesh: MeshData, preserveNormals = false, weld: 'none' | 'all' | 'smooth' = 'none') {
  if (!mesh.normals && !mesh.tangents) return;
  const previous = weld === 'smooth' ? mesh.normals : undefined;
  const geometry = new BufferGeometry();
  try {
    geometry.setAttribute('position', new Float32BufferAttribute(mesh.positions, 3));
    geometry.setIndex(mesh.indices);
    if (preserveNormals && mesh.normals) geometry.setAttribute('normal', new Float32BufferAttribute(mesh.normals, 3));
    else {
      geometry.computeVertexNormals();
      mesh.normals = weld === 'none' ? Array.from(geometry.getAttribute('normal').array) : weldNormals(mesh.positions, geometry.getAttribute('normal').array, previous);
      geometry.setAttribute('normal', new Float32BufferAttribute(mesh.normals, 3));
    }
    if (mesh.tangents) {
      if (!mesh.uv) { delete mesh.tangents; return; }
      geometry.setAttribute('uv', new Float32BufferAttribute(mesh.uv, 2));
      geometry.computeTangents();
      mesh.tangents = Array.from(geometry.getAttribute('tangent').array);
    }
  } finally { geometry.dispose(); }
}

/** Transform authored normals and tangent handedness along with baked positions. */
export function transformMeshShading(mesh: MeshData, matrix: Matrix4) {
  const normalMatrix = new Matrix3().getNormalMatrix(matrix), direction = new Vector3(), mirrored = matrix.determinant() < 0;
  if (mesh.normals) for (let i = 0; i < mesh.normals.length; i += 3) {
    direction.fromArray(mesh.normals, i).applyNormalMatrix(normalMatrix).toArray(mesh.normals, i);
  }
  if (mesh.tangents) for (let i = 0; i < mesh.tangents.length; i += 4) {
    direction.fromArray(mesh.tangents, i).transformDirection(matrix).toArray(mesh.tangents, i);
    if (mirrored) mesh.tangents[i + 3] *= -1;
  }
}
