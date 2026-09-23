import { useState } from 'react';
import { Clapperboard, CloudFog, Sparkles, Sun, Trash2 } from 'lucide-react';
import type { DesignDocument, DesignPage } from '../shared/schema';
import { emitterPresetNames, emitterPresets, presetSeed } from '../shared/scene-presets';
import { defaultScene } from '../shared/scene-runtime';
import { sceneSchema } from '../shared/design-capabilities';
import { Field } from './ui';

type Settings = NonNullable<DesignPage['scene']>;
type Light = NonNullable<Settings['lights']>[number];
type Emitter = NonNullable<Settings['emitters']>[number];
type Rendering = NonNullable<Settings['rendering']>;
type CameraKey = NonNullable<Settings['camera']['keys']>[number];

export function SceneNumber({ label, value, change, min = 0, max = 1000, step = .1 }: { label: string; value: number; change: (value: number) => void; min?: number; max?: number; step?: number }) {
  return <Field label={label}><input aria-label={label} type="number" min={min} max={max} step={step} value={Number(value.toFixed(4))} onChange={e => { const value = e.currentTarget.valueAsNumber; if (Number.isFinite(value) && value >= min && value <= max && (step !== 1 || Number.isInteger(value))) change(value); }}/></Field>;
}
export function SceneVector({ label, value, change, min = -100000 }: { label: string; value: [number, number, number]; change: (value: [number, number, number]) => void; min?: number }) {
  return <Field label={label}><div className="vector-fields">{value.map((v, axis) => <label key={axis}><span>{'XYZ'[axis]}</span><input aria-label={`${label} ${'XYZ'[axis]}`} type="number" min={min} max={100000} step={.1} value={Number(v.toFixed(4))} onChange={e => { const number = e.currentTarget.valueAsNumber; if (!Number.isFinite(number) || number < min || number > 100000) return; const next = [...value] as [number, number, number]; next[axis] = number; change(next); }}/></label>)}</div></Field>;
}
function Color({ label, value, change }: { label: string; value: string; change: (value: string) => void }) {
  return <Field label={label}><input aria-label={label} type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'} onChange={e => change(e.target.value)}/></Field>;
}

export function SceneEnvironmentControls({ page, assets = [], duration, pageUpdate }: { page: DesignPage; assets?: DesignDocument['assets']; duration?: number; pageUpdate: (patch: Partial<DesignPage>) => void }) {
  const settings: Settings = page.scene ?? defaultScene, rendering = settings.rendering ?? {};
  const [error, setError] = useState('');
  const save = (patch: Partial<Settings>) => {
    try { pageUpdate({ scene: sceneSchema.parse({ ...settings, ...patch }) }); setError(''); }
    catch (error) { setError(error instanceof Error ? error.message : 'Scene settings could not be saved.'); }
  };
  const lightUpdate = (id: string, patch: Partial<Light>) => save({ lights: settings.lights?.map(light => light.id === id ? { ...light, ...patch } : light) });
  const emitterUpdate = (id: string, patch: Partial<Emitter>) => save({ emitters: settings.emitters?.map(emitter => emitter.id === id ? { ...emitter, ...patch } : emitter) });
  const renderingUpdate = (patch: Partial<Rendering>) => save({ rendering: { ...rendering, ...patch } });
  const keys = settings.camera.keys ?? [];
  const keysUpdate = (next: CameraKey[]) => save({ camera: { ...settings.camera, keys: next.length ? [...next].sort((a, b) => a.time - b.time) : undefined } });
  const keyUpdate = (index: number, patch: Partial<CameraKey>) => keysUpdate(keys.map((key, i) => i === index ? { ...key, ...patch } : key));
  const images = assets.filter(asset => ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType));
  return <>
    {error && <p role="alert">{error}</p>}
    <details><summary><Clapperboard size={16}/>Camera moves</summary><div className="scene-section">
      <p className="small-copy">Keys interpolate the camera over the timeline and override the static camera while present.</p>
      {keys.map((key, index) => <fieldset key={index} style={{ minWidth: 0 }}><legend>Camera key {index + 1}</legend>
        <SceneNumber label={`Camera key ${index + 1} time (s)`} max={3600} step={.01} value={key.time} change={time => keyUpdate(index, { time })}/>
        <SceneVector label={`Camera key ${index + 1} position`} value={key.position} change={position => keyUpdate(index, { position })}/>
        <SceneVector label={`Camera key ${index + 1} look at`} value={key.target} change={target => keyUpdate(index, { target })}/>
        <SceneNumber label={`Camera key ${index + 1} field of view`} min={10} max={120} step={1} value={key.fov ?? settings.camera.fov} change={fov => keyUpdate(index, { fov })}/>
        <Field label={`Camera key ${index + 1} easing`}><select aria-label={`Camera key ${index + 1} easing`} value={key.ease ?? 'ease-in-out'} onChange={e => keyUpdate(index, { ease: e.target.value as CameraKey['ease'] })}><option value="linear">Linear</option><option value="ease-in">Ease in</option><option value="ease-out">Ease out</option><option value="ease-in-out">Ease in-out</option></select></Field>
        <button type="button" className="button small" aria-label={`Remove camera key ${index + 1}`} onClick={() => keysUpdate(keys.filter((_, i) => i !== index))}><Trash2 size={14}/>Remove key</button>
      </fieldset>)}
      <button type="button" className="button small" disabled={keys.length >= 64} onClick={() => { const time = keys.length ? Math.min(3600, keys[keys.length - 1].time + 1) : 0; if (duration !== undefined && time > duration) { setError('Extend the timeline before adding a later camera key.'); return; } keysUpdate([...keys, { time, position: settings.camera.position, target: settings.camera.target, fov: settings.camera.fov }]); }}>Add key from camera</button>
    </div></details>
    <details><summary><Sun size={16}/>Additional lights</summary><div className="scene-section">
      <p className="small-copy">Add up to eight lights alongside the main light.</p>
      {(settings.lights ?? []).map((light, index) => <fieldset key={light.id} style={{ minWidth: 0 }}><legend>Light {index + 1}</legend>
        <Field label="Light type"><select aria-label={`Light ${index + 1} type`} value={light.type} onChange={e => lightUpdate(light.id, { type: e.target.value as Light['type'] })}><option value="point">Point</option><option value="spot">Spot</option><option value="directional">Directional</option></select></Field>
        <Color label={`Light ${index + 1} color`} value={light.color} change={color => lightUpdate(light.id, { color })}/>
        <SceneNumber label={`Light ${index + 1} intensity`} value={light.intensity} change={intensity => lightUpdate(light.id, { intensity })}/>
        <SceneVector label={`Light ${index + 1} position`} value={light.position} change={position => lightUpdate(light.id, { position })}/>
        {light.type !== 'point' && <SceneVector label={`Light ${index + 1} target`} value={light.target ?? [0, 0, 0]} change={target => lightUpdate(light.id, { target })}/>}
        {light.type !== 'directional' && <SceneNumber label={`Light ${index + 1} distance (0 = unlimited)`} max={10000} value={light.distance ?? 0} change={distance => lightUpdate(light.id, { distance })}/>}
        {light.type === 'spot' && <SceneNumber label={`Light ${index + 1} cone angle (radians)`} min={.01} max={1.57} step={.01} value={light.angle ?? .6} change={angle => lightUpdate(light.id, { angle })}/>}
        <label className="component-check"><input type="checkbox" checked={light.shadow ?? false} onChange={e => lightUpdate(light.id, { shadow: e.target.checked })}/>Cast shadows</label>
        <button type="button" className="button small" aria-label={`Remove light ${index + 1}`} onClick={() => save({ lights: settings.lights?.filter(item => item.id !== light.id) })}><Trash2 size={14}/>Remove light</button>
      </fieldset>)}
      <button type="button" className="button small" disabled={(settings.lights?.length ?? 0) >= 8} onClick={() => save({ lights: [...settings.lights ?? [], { id: crypto.randomUUID(), type: 'point', position: [3, 3, 3], color: '#ffffff', intensity: 4 }] })}>Add light</button>
    </div></details>
    <details><summary><CloudFog size={16}/>Atmosphere and rendering</summary><div className="scene-section">
      <label className="component-check"><input type="checkbox" checked={!!settings.atmosphere} onChange={e => save({ atmosphere: e.target.checked ? { fogColor: '#b9c4d4', fogDensity: .02 } : undefined })}/>Fog</label>
      {settings.atmosphere && <><Color label="Fog color" value={settings.atmosphere.fogColor} change={fogColor => save({ atmosphere: { ...settings.atmosphere!, fogColor } })}/><SceneNumber label="Fog density" max={1} step={.001} value={settings.atmosphere.fogDensity} change={fogDensity => save({ atmosphere: { ...settings.atmosphere!, fogDensity } })}/></>}
      <label className="component-check"><input type="checkbox" checked={!!settings.rendering} onChange={e => save({ rendering: e.target.checked ? { exposure: 1, shadows: true } : undefined })}/>Enhanced rendering</label>
      {settings.rendering && <>
        <SceneNumber label="Exposure" min={.1} max={5} value={rendering.exposure ?? 1} change={exposure => save({ rendering: { ...rendering, exposure } })}/>
        <SceneNumber label="Environment light" max={5} value={rendering.environmentIntensity ?? 0} change={environmentIntensity => save({ rendering: { ...rendering, environmentIntensity } })}/>
        <SceneNumber label="Bloom strength" max={3} value={rendering.bloom ?? 0} change={bloom => save({ rendering: { ...rendering, bloom } })}/>
        <SceneNumber label="Bloom threshold" max={10} value={rendering.bloomThreshold ?? 1} change={bloomThreshold => save({ rendering: { ...rendering, bloomThreshold } })}/>
        <label className="component-check"><input type="checkbox" checked={rendering.shadows ?? true} onChange={e => save({ rendering: { ...rendering, shadows: e.target.checked } })}/>Render shadows</label>
        <Field label="Environment"><select aria-label="Environment" value={rendering.environment ?? ''} onChange={e => { const environment = (e.target.value || undefined) as Rendering['environment']; renderingUpdate({ environment, ...(environment === 'sky' && !rendering.sky ? { sky: { elevation: 12, azimuth: 180 } } : {}), ...(environment === 'panorama' && !rendering.environmentAssetId && images[0] ? { environmentAssetId: images[0].id } : {}) }); }}><option value="">Studio probe (environment light)</option><option value="room">Room</option><option value="sky">Procedural sky</option><option value="panorama" disabled={!images.length}>Panorama image</option></select></Field>
        {rendering.environment === 'panorama' && <Field label="Panorama image"><select aria-label="Panorama image" value={rendering.environmentAssetId ?? ''} onChange={e => renderingUpdate({ environmentAssetId: e.target.value })}>{images.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></Field>}
        {rendering.environment === 'sky' && rendering.sky && <>
          <SceneNumber label="Sun elevation (degrees)" min={-10} max={90} step={1} value={rendering.sky.elevation} change={elevation => renderingUpdate({ sky: { ...rendering.sky!, elevation } })}/>
          <SceneNumber label="Sun azimuth (degrees)" min={-180} max={180} step={1} value={rendering.sky.azimuth} change={azimuth => renderingUpdate({ sky: { ...rendering.sky!, azimuth } })}/>
          <SceneNumber label="Sky turbidity" max={20} value={rendering.sky.turbidity ?? 2} change={turbidity => renderingUpdate({ sky: { ...rendering.sky!, turbidity } })}/>
          <SceneNumber label="Sky rayleigh" max={4} step={.05} value={rendering.sky.rayleigh ?? 1} change={rayleigh => renderingUpdate({ sky: { ...rendering.sky!, rayleigh } })}/>
        </>}
        {(rendering.environment === 'sky' || rendering.environment === 'panorama') && <label className="component-check"><input type="checkbox" checked={rendering.environmentBackground ?? false} onChange={e => renderingUpdate({ environmentBackground: e.target.checked })}/>Show environment as background</label>}
        <SceneNumber label="Vignette" max={1} step={.01} value={rendering.vignette ?? 0} change={vignette => renderingUpdate({ vignette })}/>
        <SceneNumber label="Film grain" max={1} step={.01} value={rendering.grain ?? 0} change={grain => renderingUpdate({ grain })}/>
        <SceneNumber label="Contrast" max={2} step={.01} value={rendering.grading?.contrast ?? 1} change={contrast => renderingUpdate({ grading: { ...rendering.grading, contrast } })}/>
        <SceneNumber label="Saturation" max={2} step={.01} value={rendering.grading?.saturation ?? 1} change={saturation => renderingUpdate({ grading: { ...rendering.grading, saturation } })}/>
        <Color label="Color grade tint" value={rendering.grading?.tint ?? '#ffffff'} change={tint => renderingUpdate({ grading: { ...rendering.grading, tint } })}/>
        <SceneNumber label="Tint strength" max={1} step={.01} value={rendering.grading?.tintStrength ?? 0} change={tintStrength => renderingUpdate({ grading: { ...rendering.grading, tintStrength } })}/>
        <label className="component-check"><input type="checkbox" checked={!!rendering.depthOfField} onChange={e => renderingUpdate({ depthOfField: e.target.checked ? { focus: 8, aperture: .3, maxBlur: .01 } : undefined })}/>Depth of field</label>
        {rendering.depthOfField && <>
          <SceneNumber label="Focus distance" min={.01} max={10000} value={rendering.depthOfField.focus} change={focus => renderingUpdate({ depthOfField: { ...rendering.depthOfField!, focus } })}/>
          <SceneNumber label="Aperture" max={1} step={.01} value={rendering.depthOfField.aperture} change={aperture => renderingUpdate({ depthOfField: { ...rendering.depthOfField!, aperture } })}/>
          <SceneNumber label="Maximum blur" max={.05} step={.001} value={rendering.depthOfField.maxBlur} change={maxBlur => renderingUpdate({ depthOfField: { ...rendering.depthOfField!, maxBlur } })}/>
        </>}
        <label className="component-check"><input type="checkbox" checked={!!rendering.lightShafts} onChange={e => renderingUpdate({ lightShafts: e.target.checked ? { position: settings.light.position, intensity: .6 } : undefined })}/>Light shafts</label>
        {rendering.lightShafts && <>
          <SceneVector label="Light shaft source" value={rendering.lightShafts.position} change={position => renderingUpdate({ lightShafts: { ...rendering.lightShafts!, position } })}/>
          <SceneNumber label="Light shaft intensity" max={5} step={.05} value={rendering.lightShafts.intensity} change={intensity => renderingUpdate({ lightShafts: { ...rendering.lightShafts!, intensity } })}/>
          <SceneNumber label="Light shaft decay" min={.8} max={1} step={.005} value={rendering.lightShafts.decay ?? .96} change={decay => renderingUpdate({ lightShafts: { ...rendering.lightShafts!, decay } })}/>
          <SceneNumber label="Light shaft threshold" max={10} step={.05} value={rendering.lightShafts.threshold ?? .8} change={threshold => renderingUpdate({ lightShafts: { ...rendering.lightShafts!, threshold } })}/>
        </>}
      </>}
    </div></details>
    <details><summary><Sparkles size={16}/>Particle emitters</summary><div className="scene-section">
      <p className="small-copy">Seeded particles seek with the timeline and render in exported video.</p>
      {(settings.emitters ?? []).map((emitter, index) => <fieldset key={emitter.id} style={{ minWidth: 0 }}><legend>Emitter {index + 1}</legend>
        <Color label={`Emitter ${index + 1} color`} value={emitter.color} change={color => emitterUpdate(emitter.id, { color })}/>
        <SceneVector label={`Emitter ${index + 1} position`} value={emitter.position} change={position => emitterUpdate(emitter.id, { position })}/>
        <SceneVector label={`Emitter ${index + 1} spread`} min={0} value={emitter.spread} change={spread => emitterUpdate(emitter.id, { spread })}/>
        <SceneVector label={`Emitter ${index + 1} velocity`} value={emitter.velocity} change={velocity => emitterUpdate(emitter.id, { velocity })}/>
        <SceneNumber label={`Emitter ${index + 1} particle count`} min={1} max={3000} step={1} value={emitter.count} change={count => emitterUpdate(emitter.id, { count })}/>
        <SceneNumber label={`Emitter ${index + 1} size`} min={.001} max={10} step={.01} value={emitter.size} change={size => emitterUpdate(emitter.id, { size })}/>
        <SceneNumber label={`Emitter ${index + 1} lifetime (s)`} min={.1} max={60} value={emitter.lifetime} change={lifetime => emitterUpdate(emitter.id, { lifetime })}/>
        <SceneNumber label={`Emitter ${index + 1} seed`} max={2147483647} step={1} value={emitter.seed} change={seed => emitterUpdate(emitter.id, { seed })}/>
        <Field label={`Emitter ${index + 1} sprite`}><select aria-label={`Emitter ${index + 1} sprite`} value={emitter.sprite ?? 'square'} onChange={e => emitterUpdate(emitter.id, { sprite: e.target.value as Emitter['sprite'] })}><option value="square">Square</option><option value="soft">Soft dot</option><option value="flake">Snowflake</option><option value="mist">Mist puff</option></select></Field>
        <Field label={`Emitter ${index + 1} blending`}><select aria-label={`Emitter ${index + 1} blending`} value={emitter.blending ?? 'additive'} onChange={e => emitterUpdate(emitter.id, { blending: e.target.value as Emitter['blending'] })}><option value="additive">Additive glow</option><option value="normal">Normal</option></select></Field>
        <SceneNumber label={`Emitter ${index + 1} opacity`} max={1} step={.01} value={emitter.opacity ?? .8} change={opacity => emitterUpdate(emitter.id, { opacity })}/>
        <SceneNumber label={`Emitter ${index + 1} fade in (lifetime fraction)`} max={1} step={.01} value={emitter.fadeIn ?? 0} change={fadeIn => emitterUpdate(emitter.id, { fadeIn })}/>
        <SceneNumber label={`Emitter ${index + 1} fade out (lifetime fraction)`} max={1} step={.01} value={emitter.fadeOut ?? 0} change={fadeOut => emitterUpdate(emitter.id, { fadeOut })}/>
        <SceneNumber label={`Emitter ${index + 1} size variance`} max={1} step={.01} value={emitter.sizeVariance ?? 0} change={sizeVariance => emitterUpdate(emitter.id, { sizeVariance })}/>
        <SceneVector label={`Emitter ${index + 1} gravity`} value={emitter.gravity ?? [0, 0, 0]} change={gravity => emitterUpdate(emitter.id, { gravity })}/>
        <SceneNumber label={`Emitter ${index + 1} turbulence`} max={100} step={.05} value={emitter.turbulence ?? 0} change={turbulence => emitterUpdate(emitter.id, { turbulence })}/>
        <SceneNumber label={`Emitter ${index + 1} swirl (rad/s)`} min={-20} max={20} step={.05} value={emitter.swirl ?? 0} change={swirl => emitterUpdate(emitter.id, { swirl })}/>
        <SceneNumber label={`Emitter ${index + 1} start (s)`} max={3600} step={.01} value={emitter.start ?? 0} change={start => { if (start <= (emitter.end ?? duration ?? 3600)) emitterUpdate(emitter.id, { start }); else setError('Emitter start must not follow its end.'); }}/>
        <SceneNumber label={`Emitter ${index + 1} end (s)`} max={3600} step={.01} value={emitter.end ?? duration ?? 3600} change={end => { if (end >= (emitter.start ?? 0)) emitterUpdate(emitter.id, { end }); else setError('Emitter end must not precede its start.'); }}/>
        <button type="button" className="button small" aria-label={`Remove emitter ${index + 1}`} onClick={() => save({ emitters: settings.emitters?.filter(item => item.id !== emitter.id) })}><Trash2 size={14}/>Remove emitter</button>
      </fieldset>)}
      <button type="button" className="button small" disabled={(settings.emitters?.length ?? 0) >= 8} onClick={() => save({ emitters: [...settings.emitters ?? [], { id: crypto.randomUUID(), position: [0, 0, 0], spread: [2, 1, 2], velocity: [0, .5, 0], count: 120, size: .035, color: '#ffd9a0', lifetime: 3, seed: 1, start: 0, ...(duration ? { end: duration } : {}) }] })}>Add emitter</button>
      <Field label="Add preset emitter"><select aria-label="Add preset emitter" value="" disabled={(settings.emitters?.length ?? 0) >= 8} onChange={e => { const preset = e.target.value as typeof emitterPresetNames[number]; if (!preset) return; const id = crypto.randomUUID(); save({ emitters: [...settings.emitters ?? [], { ...emitterPresets[preset], id, seed: presetSeed(id), start: 0, ...(duration ? { end: duration } : {}) }] }); }}><option value="">Choose a preset…</option>{emitterPresetNames.map(name => <option key={name} value={name}>{name}</option>)}</select></Field>
    </div></details>
  </>;
}
