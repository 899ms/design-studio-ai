import type { MeshData } from './design-capabilities';

export interface TerrainOptions { shape: 'plane' | 'mountain'; size: [number, number]; resolution: number; height: number; seed: number; octaves: number; roughness: number }

function hash(x: number, y: number, seed: number) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x: number, y: number, seed: number) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const top = hash(ix, iy, seed) + (hash(ix + 1, iy, seed) - hash(ix, iy, seed)) * sx;
  const bottom = hash(ix, iy + 1, seed) + (hash(ix + 1, iy + 1, seed) - hash(ix, iy + 1, seed)) * sx;
  return top + (bottom - top) * sy;
}
/** Deterministic fractal heightfield. Triangles wind counter-clockwise from above, so normals face up. */
export function terrainMesh(options: TerrainOptions): MeshData {
  const { shape, size: [width, depth], resolution: n, height, seed, octaves, roughness } = options;
  const positions: number[] = [], uv: number[] = [], indices: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const u = i / n, v = j / n, x = (u - .5) * width, z = (v - .5) * depth;
    let amplitude = 1, frequency = 4, sum = 0, total = 0;
    for (let octave = 0; octave < octaves; octave++) { sum += valueNoise(u * frequency, v * frequency, seed + octave * 101) * amplitude; total += amplitude; amplitude *= roughness; frequency *= 2; }
    const noise = sum / total;
    // Mountains fall to zero at the footprint edge so they sit flush on a ground plane.
    const y = shape === 'mountain' ? height * Math.max(0, 1 - Math.hypot(u * 2 - 1, v * 2 - 1)) ** 1.5 * (.55 + .45 * noise) : height * (noise - .5);
    positions.push(x, y, z); uv.push(u, v);
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { positions, indices, uv };
}
