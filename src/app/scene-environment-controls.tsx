import { useState } from 'react';
import { CloudFog, Sparkles, Sun, Trash2 } from 'lucide-react';
import type { DesignPage } from '../shared/schema';
import { defaultScene } from '../shared/scene-runtime';
import { sceneSchema } from '../shared/design-capabilities';
import { Field } from './ui';

type Settings = NonNullable<DesignPage['scene']>;
type Light = NonNullable<Settings['lights']>[number];
type Emitter = NonNullable<Settings['emitters']>[number];

export function SceneNumber({ label, value, change, min = 0, max = 1000, step = .1 }: { label: string; value: number; change: (value: number) => void; min?: number; max?: number; step?: number }) {
  return <Field label={label}><input aria-label={label} type="number" min={min} max={max} step={step} value={Number(value.toFixed(4))} onChange={e => { const value = e.currentTarget.valueAsNumber; if (Number.isFinite(value) && value >= min && value <= max && (step !== 1 || Number.isInteger(value))) change(value); }}/></Field>;
}
export function SceneVector({ label, value, change, min = -100000 }: { label: string; value: [number, number, number]; change: (value: [number, number, number]) => void; min?: number }) {
  return <Field label={label}><div className="vector-fields">{value.map((v, axis) => <label key={axis}><span>{'XYZ'[axis]}</span><input aria-label={`${label} ${'XYZ'[axis]}`} type="number" min={min} max={100000} step={.1} value={Number(v.toFixed(4))} onChange={e => { const number = e.currentTarget.valueAsNumber; if (!Number.isFinite(number) || number < min || number > 100000) return; const next = [...value] as [number, number, number]; next[axis] = number; change(next); }}/></label>)}</div></Field>;
}
function Color({ label, value, change }: { label: string; value: string; change: (value: string) => void }) {
  return <Field label={label}><input aria-label={label} type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'} onChange={e => change(e.target.value)}/></Field>;
}

export function SceneEnvironmentControls({ page, duration, pageUpdate }: { page: DesignPage; duration?: number; pageUpdate: (patch: Partial<DesignPage>) => void }) {
  const settings: Settings = page.scene ?? defaultScene, rendering = settings.rendering ?? {};
  const [error, setError] = useState('');
  const save = (patch: Partial<Settings>) => {
    try { pageUpdate({ scene: sceneSchema.parse({ ...settings, ...patch }) }); setError(''); }
    catch (error) { setError(error instanceof Error ? error.message : 'Scene settings could not be saved.'); }
  };
  const lightUpdate = (id: string, patch: Partial<Light>) => save({ lights: settings.lights?.map(light => light.id === id ? { ...light, ...patch } : light) });
  const emitterUpdate = (id: string, patch: Partial<Emitter>) => save({ emitters: settings.emitters?.map(emitter => emitter.id === id ? { ...emitter, ...patch } : emitter) });
  return <>
    {error && <p role="alert">{error}</p>}
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
        <SceneNumber label={`Emitter ${index + 1} start (s)`} max={3600} step={.01} value={emitter.start ?? 0} change={start => { if (start <= (emitter.end ?? duration ?? 3600)) emitterUpdate(emitter.id, { start }); else setError('Emitter start must not follow its end.'); }}/>
        <SceneNumber label={`Emitter ${index + 1} end (s)`} max={3600} step={.01} value={emitter.end ?? duration ?? 3600} change={end => { if (end >= (emitter.start ?? 0)) emitterUpdate(emitter.id, { end }); else setError('Emitter end must not precede its start.'); }}/>
        <button type="button" className="button small" aria-label={`Remove emitter ${index + 1}`} onClick={() => save({ emitters: settings.emitters?.filter(item => item.id !== emitter.id) })}><Trash2 size={14}/>Remove emitter</button>
      </fieldset>)}
      <button type="button" className="button small" disabled={(settings.emitters?.length ?? 0) >= 8} onClick={() => save({ emitters: [...settings.emitters ?? [], { id: crypto.randomUUID(), position: [0, 0, 0], spread: [2, 1, 2], velocity: [0, .5, 0], count: 120, size: .035, color: '#ffd9a0', lifetime: 3, seed: 1, start: 0, ...(duration ? { end: duration } : {}) }] })}>Add emitter</button>
    </div></details>
  </>;
}
