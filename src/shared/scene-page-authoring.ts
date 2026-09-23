import { sceneEmitterSchema, sceneRenderingSchema, sceneSchema } from './design-capabilities';
import type { SceneCommand } from './scene-authoring-schema';
import { emitterPresets, presetSeed } from './scene-presets';
import { defaultScene } from './scene-runtime';
import type { DesignDocument } from './schema';

type PageCommand = Extract<SceneCommand, { action: 'camera' | 'camera-key' | 'environment' | 'emitter' | 'remove-emitter' }>;
const defined = <V extends object>(value: V) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
/** Merge a settings patch where null removes a key; unknown keys are rejected instead of silently dropped. */
function mergeSettings(current: Record<string, unknown> | undefined, patch: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(patch).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unknown ${label} setting: ${unknown.join(', ')}`);
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) if (value === null) delete next[key]; else next[key] = value;
  return Object.keys(next).length ? next : undefined;
}
/** Page-level camera, lighting, rendering and particle edits that merge into the existing scene. */
export function applyPageCommand(doc: DesignDocument, pageId: string, command: PageCommand) {
  const page = doc.pages.find(p => p.id === pageId);
  if (!page) throw new Error('Unknown page');
  // Creating page.scene moves a page onto the 3D export path, so a 2D page never gains one implicitly.
  if (!page.scene && doc.kind !== '3d' && !page.nodes.some(node => node.type === 'model3d')) throw new Error('Page scene commands need a 3D project page or a page with 3D objects');
  const scene: Record<string, any> = structuredClone(page.scene ?? defaultScene);
  if (command.action === 'camera') { const { action, ...patch } = command; Object.assign(scene.camera, defined(patch)); }
  if (command.action === 'camera-key') {
    const keys: any[] = scene.camera.keys ?? [], index = keys.findIndex(key => Math.abs(key.time - command.time) < 1e-6);
    if (command.remove) { if (index < 0) throw new Error('No camera key at this time'); keys.splice(index, 1); }
    else {
      const { action, remove, ...patch } = command, key = { ...keys[index], ...defined(patch) };
      if (!key.position || !key.target) throw new Error('A new camera key needs position and target');
      if (index < 0) keys.push(key); else keys[index] = key;
      doc.timeline ??= { duration: Math.max(.1, command.time), fps: 30, tracks: [] };
      doc.timeline.duration = Math.max(doc.timeline.duration, command.time);
    }
    keys.sort((a, b) => a.time - b.time);
    if (keys.length) scene.camera.keys = keys; else delete scene.camera.keys;
  }
  if (command.action === 'environment') {
    if (command.ambient !== undefined) scene.ambient = command.ambient;
    if (command.light) Object.assign(scene.light, defined(command.light));
    if (command.atmosphere === null) delete scene.atmosphere;
    else if (command.atmosphere) scene.atmosphere = mergeSettings(scene.atmosphere ?? { fogColor: '#c8d6e5', fogDensity: .02 }, command.atmosphere, ['fogColor', 'fogDensity'], 'atmosphere');
    if (command.rendering === null) delete scene.rendering;
    else if (command.rendering) scene.rendering = mergeSettings(scene.rendering, command.rendering, Object.keys(sceneRenderingSchema.shape), 'rendering');
    if (!scene.atmosphere) delete scene.atmosphere;
    if (!scene.rendering) delete scene.rendering;
  }
  if (command.action === 'emitter') {
    const { action, preset, id, ...patch } = command, emitters: any[] = scene.emitters ?? [], index = emitters.findIndex(e => e.id === id);
    if (index < 0 && emitters.length >= 8) throw new Error('A page holds at most 8 emitters');
    const merged = { ...emitters[index], ...(preset ? emitterPresets[preset] : {}), ...defined(patch), id };
    merged.seed ??= presetSeed(id);
    const emitter = sceneEmitterSchema.parse(merged);
    if (index < 0) emitters.push(emitter); else emitters[index] = emitter;
    scene.emitters = emitters;
  }
  if (command.action === 'remove-emitter') {
    const emitters: any[] = scene.emitters ?? [], next = emitters.filter(e => e.id !== command.id);
    if (next.length === emitters.length) throw new Error('Unknown emitter');
    if (next.length) scene.emitters = next; else delete scene.emitters;
  }
  page.scene = sceneSchema.parse(scene);
}
