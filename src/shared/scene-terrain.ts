import { Color } from 'three';
import type { MeshData } from './design-capabilities';

export interface TerrainOptions { shape: 'plane' | 'mountain' | 'ridges'; size: [number, number]; resolution: number; height: number; seed: number; octaves: number; roughness: number; color?: string; snowLine?: number; snowColor?: string }

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
  const { shape, size: [width, depth], resolution: n, height, seed, octaves, roughness, snowLine } = options;
  const positions: number[] = [], uv: number[] = [], indices: number[] = [], colors: number[] = [];
  const rock = new Color(options.color ?? '#DDE7F0'), snow = new Color(options.snowColor ?? '#F4F8FF'), tint = new Color();
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const u = i / n, v = j / n, x = (u - .5) * width, z = (v - .5) * depth;
    let amplitude = 1, frequency = 4, sum = 0, total = 0;
    for (let octave = 0; octave < octaves; octave++) {
      const value = valueNoise(u * frequency, v * frequency, seed + octave * 101);
      // Ridged noise folds each octave at its midpoint so crests become sharp ridgelines.
      sum += (shape === 'ridges' ? (1 - Math.abs(value * 2 - 1)) ** 2 : value) * amplitude; total += amplitude; amplitude *= roughness; frequency *= 2;
    }
    const noise = sum / total;
    // Mountains fall to zero at the footprint edge so they sit flush on a ground plane.
    const falloff = Math.max(0, 1 - Math.hypot(u * 2 - 1, v * 2 - 1)) ** 1.5;
    const y = shape === 'mountain' ? height * falloff * (.55 + .45 * noise) : shape === 'ridges' ? height * falloff * (.25 + .75 * noise) : height * (noise - .5);
    positions.push(x, y, z); uv.push(u, v);
    // Snow blends in over a band above the snow line, broken up by the next octave of noise.
    if (snowLine !== undefined) { const level = (shape === 'plane' ? noise : y / Math.max(height, 1e-9)) + (valueNoise(u * 32, v * 32, seed + 977) - .5) * .12; tint.copy(rock).lerp(snow, Math.min(1, Math.max(0, (level - snowLine) / .08))); colors.push(tint.r, tint.g, tint.b); }
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return snowLine === undefined ? { positions, indices, uv } : { positions, indices, uv, colors };
}
