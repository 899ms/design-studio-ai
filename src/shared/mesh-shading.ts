import { BufferGeometry, Float32BufferAttribute, Matrix3, Matrix4, Vector3 } from 'three';
import type { MeshData } from './design-capabilities';

/** Refresh authored shading buffers after a geometry or UV edit. */
export function refreshMeshShading(mesh: MeshData, preserveNormals = false) {
  if (!mesh.normals && !mesh.tangents) return;
  const geometry = new BufferGeometry();
  try {
    geometry.setAttribute('position', new Float32BufferAttribute(mesh.positions, 3));
    geometry.setIndex(mesh.indices);
    if (preserveNormals && mesh.normals) geometry.setAttribute('normal', new Float32BufferAttribute(mesh.normals, 3));
    else { geometry.computeVertexNormals(); mesh.normals = Array.from(geometry.getAttribute('normal').array); }
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
