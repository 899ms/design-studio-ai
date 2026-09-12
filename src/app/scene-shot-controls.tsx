import { useEffect, useRef, useState } from 'react';
import { Scan, Copy } from 'lucide-react';
import type { DesignDocument, DesignPage } from '../shared/schema';
import { documentSchema } from '../shared/schema';
import { defaultScene } from '../shared/scene-runtime';
import { fitSceneCamera } from '../shared/scene-shot';
import { duplicateSceneShot } from '../shared/scene-shot-operations';
import { SceneNumber } from './scene-environment-controls';
import { Field } from './ui';

type Props = { doc: DesignDocument; page: DesignPage; pageUpdate: (patch: Partial<DesignPage>) => void; onDocument: (doc: DesignDocument) => void };
export function SceneShotControls({ doc, page, pageUpdate, onDocument }: Props) {
  const subjects = page.nodes.filter(node => node.type === 'model3d' && node.visible !== false);
  const [selected, setSelected] = useState(() => subjects.slice(0, 32).map(node => node.id));
  const [samples, setSamples] = useState(33), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const latest = useRef({ doc, pageId: page.id }); latest.current = { doc, pageId: page.id };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const settings: NonNullable<DesignPage['scene']> = page.scene ?? defaultScene;
  const selectedIds = selected.filter(id => subjects.some(node => node.id === id));
  const fit = async (aspect?: 'portrait' | 'square') => {
    setBusy(true); setError(''); setNotice('');
    try {
      const duplicate = aspect ? duplicateSceneShot(doc, page.id, aspect) : undefined;
      const next = duplicate?.document ?? doc, targetId = duplicate?.pageId ?? page.id;
      const ids = duplicate ? selectedIds.map(id => duplicate.nodeIds[id]) : selectedIds;
      const fitted = await fitSceneCamera(next, targetId, ids, samples);
      if (!mounted.current) return;
      if (latest.current.doc !== doc || latest.current.pageId !== page.id) throw new Error('The scene changed while framing. Fit again to include the latest changes.');
      const target = next.pages.find(page => page.id === targetId)!;
      const scene = { ...target.scene ?? defaultScene, camera: fitted.camera };
      if (duplicate) { target.scene = scene; onDocument(documentSchema.parse(next)); setNotice(`Created ${target.name}. Select its page to preview the shot. Assets remain shared.`); }
      else { pageUpdate({ scene }); setNotice(`Camera fitted to ${ids.length} subject${ids.length === 1 ? '' : 's'} using ${samples} timeline samples.`); }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Camera framing failed.'); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <details open><summary><Scan size={16}/>Shot framing</summary><div className="scene-section">
    <fieldset disabled={busy} style={{ minWidth: 0, padding: 0, border: 0 }}>
      <SceneNumber label="Safe frame margin (%)" max={30} step={1} value={(settings.camera.safeFrame ?? .08) * 100} change={margin => { try { pageUpdate({ scene: { ...settings, camera: { ...settings.camera, safeFrame: margin / 100 } } }); setError(''); } catch (error) { setError((error as Error).message); } }}/>
      <Field label="Motion samples"><select aria-label="Motion samples" value={samples} onChange={e => setSamples(Number(e.target.value))}><option value={17}>17 · Faster</option><option value={33}>33 · Balanced</option><option value={61}>61 · Finer motion</option></select></Field>
      <p className="small-copy">Fit selected geometry over the full timeline. Check fast motion between samples before exporting.</p>
      <div style={{ maxHeight: 160, overflow: 'auto' }} aria-label="Camera subjects">
        {subjects.map(subject => <label className="component-check" key={subject.id}><input aria-label={`Frame ${subject.name}`} type="checkbox" checked={selectedIds.includes(subject.id)} disabled={!selectedIds.includes(subject.id) && selectedIds.length >= 32} onChange={e => setSelected(e.target.checked ? [...selectedIds, subject.id] : selectedIds.filter(id => id !== subject.id))}/>{subject.name}</label>)}
      </div>
      {!subjects.length && <p className="small-copy">Add a visible 3D object to fit a shot.</p>}
      {subjects.length > 32 && <p className="small-copy">Select up to 32 subjects per camera fit.</p>}
      <button type="button" className="button small" disabled={!selectedIds.length} onClick={() => void fit()}><Scan size={14}/>{busy ? 'Fitting motion…' : 'Fit animation in frame'}</button>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        <button type="button" className="button small" disabled={!selectedIds.length} onClick={() => void fit('portrait')}><Copy size={14}/>Create 9:16 shot</button>
        <button type="button" className="button small" disabled={!selectedIds.length} onClick={() => void fit('square')}><Copy size={14}/>Create 1:1 shot</button>
      </div>
    </fieldset>
    {error && <p role="alert">{error}</p>}{notice && <p role="status" className="small-copy">{notice}</p>}
  </div></details>;
}
