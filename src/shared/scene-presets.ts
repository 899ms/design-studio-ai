import type { z } from 'zod';
import type { sceneEmitterSchema } from './design-capabilities';

type Emitter = z.infer<typeof sceneEmitterSchema>;
export const emitterPresetNames = ['snowfall', 'snow-burst', 'frost-breath', 'ground-mist'] as const;
export type EmitterPreset = typeof emitterPresetNames[number];

/** Starting points for common weather and breath effects; explicit command fields override every value. */
export const emitterPresets: Record<EmitterPreset, Omit<Emitter, 'id' | 'seed'>> = {
  snowfall: { position: [0, 6, 0], spread: [16, 4, 16], velocity: [0, -.8, 0], count: 1500, size: .2, color: '#ffffff', lifetime: 8, sprite: 'flake', blending: 'normal', opacity: .9, fadeIn: .1, fadeOut: .2, sizeVariance: .6, turbulence: .4 },
  'snow-burst': { position: [0, .3, 0], spread: [1, .2, 1], velocity: [0, 2.5, 0], count: 600, size: .16, color: '#f4fbff', lifetime: 2.4, sprite: 'soft', blending: 'additive', opacity: .9, fadeOut: .6, sizeVariance: .5, gravity: [0, -2.2, 0], turbulence: .6, swirl: 1.2 },
  'frost-breath': { position: [0, 2, 2], spread: [.3, .3, .3], velocity: [0, 0, 4], count: 900, size: .35, color: '#bfe9ff', lifetime: 1.4, sprite: 'mist', blending: 'additive', opacity: .55, fadeIn: .1, fadeOut: .5, sizeVariance: .5, gravity: [0, -.3, 0], turbulence: .5 },
  'ground-mist': { position: [0, .25, 0], spread: [18, .4, 18], velocity: [.15, 0, 0], count: 180, size: 3.2, color: '#d6e8ff', lifetime: 12, sprite: 'mist', blending: 'normal', opacity: .22, fadeIn: .3, fadeOut: .3, sizeVariance: .5, turbulence: .6 },
};
/** Stable per-ID seed so two preset emitters do not repeat the same particle pattern. */
export function presetSeed(id: string) { let hash = 2166136261; for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return (hash >>> 0) % 2147483647; }
