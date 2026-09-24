import type { MeshData } from './design-capabilities';
import { refreshMeshShading } from './mesh-shading';

/** Five decimals keep sub-millimetre detail without bloating stored documents with float noise. */
const round = (value: number) => Math.round(value * 1e5) / 1e5;

/** Blend two vertices' skin influences at the edge midpoint, keeping the four largest and renormalizing. */
function blendSkin(mesh: MeshData, a: number, b: number) {
  const values = new Map<number, number>();
  for (const v of [a, b]) for (let j = 0; j < 4; j++) values.set(mesh.skinIndices![v * 4 + j], (values.get(mesh.skinIndices![v * 4 + j]) ?? 0) + mesh.skinWeights![v * 4 + j] / 2);
  const top = [...values].filter(([, w]) => w > 0).sort((x, y) => y[1] - x[1]).slice(0, 4), sum = top.reduce((s, [, w]) => s + w, 0);
  if (sum <= 0) throw new Error('Normalize skin weights before subdividing');
  return Array.from({ length: 4 }, (_, j) => [top[j]?.[0] ?? 0, (top[j]?.[1] ?? 0) / sum]);
}

/**
 * One Loop subdivision step. Topology is read from welded positions so UV seams and split normals stay closed;
 * UVs, colors, morph deltas and skin weights interpolate per authored vertex.
 */
function subdivideOnce(mesh: MeshData, smooth: boolean) {
  const count = mesh.positions.length / 3, weld = new Int32Array(count), firstAt = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const key = [0, 1, 2].map(a => Math.round(mesh.positions[i * 3 + a] * 1e5)).join(',');
    const first = firstAt.get(key);
    if (first === undefined) { firstAt.set(key, i); weld[i] = i; } else weld[i] = first;
  }
  const pair = (a: number, b: number) => a < b ? a * count + b : b * count + a;
  const welded = new Map<number, { a: number; b: number; opposite: number[] }>(), authored = new Map<number, [number, number]>();
  for (let t = 0; t < mesh.indices.length; t += 3) for (let j = 0; j < 3; j++) {
    const x = mesh.indices[t + j], y = mesh.indices[t + (j + 1) % 3], z = mesh.indices[t + (j + 2) % 3];
    if (!authored.has(pair(x, y))) authored.set(pair(x, y), [x, y]);
    const key = pair(weld[x], weld[y]), edge = welded.get(key) ?? { a: weld[x], b: weld[y], opposite: [] };
    edge.opposite.push(weld[z]); welded.set(key, edge);
  }
  const added = authored.size, total = count + added;
  if (total > 300000 || mesh.indices.length * 4 > 1800000 || (mesh.morphTargets?.length ?? 0) * total * 3 > 2000000) throw new Error('Subdivision would exceed the mesh budget; subdivide fewer times or a smaller mesh');
  const at = (v: number, axis: number) => mesh.positions[v * 3 + axis];
  const moved = [...mesh.positions];
  if (smooth) {
    const neighbors = new Map<number, Set<number>>(), boundary = new Map<number, number[]>();
    for (const edge of welded.values()) {
      for (const [v, other] of [[edge.a, edge.b], [edge.b, edge.a]]) {
        if (!neighbors.has(v)) neighbors.set(v, new Set());
        neighbors.get(v)!.add(other);
        if (edge.opposite.length !== 2) boundary.set(v, [...(boundary.get(v) ?? []), edge.opposite.length === 1 ? other : -1]);
      }
    }
    const smoothed = new Map<number, number[]>();
    for (const [v, ring] of neighbors) {
      const open = boundary.get(v);
      // Corners and non-manifold vertices stay fixed; a boundary curve smooths only along itself.
      if (open && (open.length !== 2 || open.includes(-1))) continue;
      if (open) smoothed.set(v, [0, 1, 2].map(axis => at(v, axis) * .75 + (at(open[0], axis) + at(open[1], axis)) * .125));
      else {
        const n = ring.size, beta = n === 3 ? 3 / 16 : 3 / (8 * n);
        smoothed.set(v, [0, 1, 2].map(axis => at(v, axis) * (1 - n * beta) + [...ring].reduce((sum, u) => sum + at(u, axis), 0) * beta));
      }
    }
    for (let i = 0; i < count; i++) { const next = smoothed.get(weld[i]); if (next) moved.splice(i * 3, 3, ...next); }
  }
  const midpoint = new Map<number, number>();
  for (const [key, [a, b]] of authored) {
    const index = count + midpoint.size, edge = welded.get(pair(weld[a], weld[b]))!;
    midpoint.set(key, index);
    for (let axis = 0; axis < 3; axis++) moved.push(smooth && edge.opposite.length === 2
      ? (at(a, axis) + at(b, axis)) * .375 + (at(edge.opposite[0], axis) + at(edge.opposite[1], axis)) * .125
      : (at(a, axis) + at(b, axis)) / 2);
    for (const [buffer, width] of [[mesh.uv, 2], [mesh.colors, 3], ...(mesh.morphTargets ?? []).map(target => [target.positions, 3])] as [number[] | undefined, number][])
      if (buffer) for (let j = 0; j < width; j++) buffer.push(round((buffer[a * width + j] + buffer[b * width + j]) / 2));
    if (mesh.skinIndices && mesh.skinWeights) for (const [bone, weight] of blendSkin(mesh, a, b)) { mesh.skinIndices.push(bone); mesh.skinWeights.push(weight); }
  }
  const indices: number[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = mesh.indices.slice(t, t + 3), ab = midpoint.get(pair(a, b))!, bc = midpoint.get(pair(b, c))!, ca = midpoint.get(pair(c, a))!;
    indices.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  mesh.positions = moved.map(round);
  mesh.indices = indices;
  if (mesh.normals) mesh.normals = Array(total * 3).fill(0);
  if (mesh.tangents) mesh.tangents = Array(total * 4).fill(0);
}

/** Refine a mesh into four triangles per face per iteration; smooth applies Loop rules, otherwise the shape is kept. */
export function subdivide(mesh: MeshData, iterations: number, smooth: boolean) {
  for (let step = 0; step < iterations; step++) subdivideOnce(mesh, smooth);
  // A smoothed surface gets welded normals; otherwise the renderer would shade each UV seam as a crease.
  if (smooth) mesh.normals ??= [];
  refreshMeshShading(mesh, false, smooth ? 'all' : 'none');
}
