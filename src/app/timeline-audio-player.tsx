import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesignNode } from '../shared/schema';
import { createTimelineAudioEngine, timelineAudioCues, type TimelineAudioEngine } from '../shared/timeline-audio';

type Props = {
  nodes: DesignNode[]; duration: number; time: number; playing: boolean;
  onSeek: (time: number) => void; onTime: (time: number) => void; onEnded: () => void;
  onChangeNode: (id: string, patch: Record<string, unknown>) => void;
};

export function TimelineAudioPlayer(props: Props) {
  const cues = useMemo(() => timelineAudioCues(props.nodes, props.duration), [props.nodes, props.duration]);
  const signature = useMemo(() => JSON.stringify(cues.map(({ event, ...cue }) => cue)), [cues]);
  const latest = useRef(props); latest.current = props;
  const engine = useRef<TimelineAudioEngine | undefined>(undefined);
  const [ready, setReady] = useState(0), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [waveforms, setWaveforms] = useState(new Map<string, number[]>());
  useEffect(() => {
    const abort = new AbortController(); setError(''); setWaveforms(new Map());
    if (!cues.length) { setLoading(false); return; }
    setLoading(true);
    void createTimelineAudioEngine(cues, { signal: abort.signal, onError: e => { if (!abort.signal.aborted) { setError(e.message); latest.current.onEnded(); } } }).then(player => {
      if (abort.signal.aborted) { void player.dispose(); return; }
      engine.current = player; setWaveforms(player.waveforms); setLoading(false); setReady(value => value + 1);
    }).catch(e => { if (!abort.signal.aborted) { setLoading(false); setError((e as Error).message); latest.current.onEnded(); } });
    return () => { abort.abort(); engine.current = undefined; };
  }, [signature]);
  useEffect(() => {
    const player = engine.current;
    if (!player) return;
    if (!props.playing) { player.pause(props.time); return; }
    let stopped = false, frame = 0;
    void player.play(props.time, props.duration).then(() => {
      if (stopped) { player.pause(); return; }
      const tick = () => {
        const time = player.currentTime(); latest.current.onTime(time);
        if (time >= latest.current.duration) { latest.current.onEnded(); return; }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }).catch(e => { if (!stopped) { setError((e as Error).message); latest.current.onEnded(); } });
    return () => { stopped = true; cancelAnimationFrame(frame); player.pause(); };
  }, [props.playing, props.duration, ready, signature]);
  useEffect(() => {
    const player = engine.current;
    if (player && (!props.playing || Math.abs(player.currentTime() - props.time) > .15)) player.seek(props.time);
  }, [props.time, props.playing]);
  if (!cues.length) return null;
  const enable = () => { const player = engine.current; if (player) void player.context.resume().then(() => setError('')).catch(e => setError((e as Error).message)); };
  return <section className="motion-editor" aria-label="Timeline audio">
    <div className="motion-heading" style={{ flexWrap: 'wrap' }}><strong>Audio timeline</strong><small>{loading ? 'Loading audio and waveform…' : 'Audio clock · source trim · event markers'}</small><button type="button" onClick={enable} disabled={loading || !engine.current}>Enable audio</button></div>
    {error && <p role="alert">{error}</p>}
    {cues.map(cue => <div key={cue.id} style={{ padding: '8px 12px', borderTop: '1px solid var(--border, #ddd)' }}>
      <strong>{cue.name}</strong>
      <div className="motion-toolbar" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {([['Start', 'audioStart', cue.start], ['End', 'audioEnd', cue.end], ['Source offset', 'audioOffset', cue.offset], ['Gain', 'audioGain', cue.gain]] as const).map(([label, key, value]) => <label key={key}>{label} <input type="number" aria-label={`${cue.name} ${label}`} style={{ width: 72 }} min={0} max={key === 'audioGain' ? 4 : key === 'audioOffset' ? 3600 : props.duration} step={key === 'audioGain' ? .1 : .01} value={value} onChange={e => { const value = e.currentTarget.valueAsNumber; if (Number.isFinite(value) && value >= 0 && value <= (key === 'audioGain' ? 4 : key === 'audioOffset' ? 3600 : props.duration) && (key !== 'audioStart' || value < cue.end) && (key !== 'audioEnd' || value > cue.start)) props.onChangeNode(cue.id, { [key]: value }); }}/></label>)}
        <label><input type="checkbox" checked={cue.muted} onChange={e => props.onChangeNode(cue.id, { audioMuted: e.target.checked })}/> Mute</label>
        <label><input type="checkbox" checked={cue.loop} onChange={e => props.onChangeNode(cue.id, { audioLoop: e.target.checked })}/> Loop source</label>
        <label>Event <input aria-label={`${cue.name} event marker`} maxLength={120} value={cue.event} placeholder="Wingbeat / roar" onChange={e => props.onChangeNode(cue.id, { audioEvent: e.target.value })}/></label>
      </div>
      <div style={{ position: 'relative', height: 48, overflow: 'hidden', background: 'var(--surface, #eee)', marginTop: 8 }}>
        <div style={{ position: 'absolute', left: `${cue.start / props.duration * 100}%`, width: `${Math.max(0, cue.end - cue.start) / props.duration * 100}%`, height: '100%', opacity: cue.muted ? .35 : 1, background: 'color-mix(in srgb, var(--accent, #7160cf) 18%, transparent)' }}>
          {waveforms.has(cue.id) ? <svg role="img" aria-label={`${cue.name} source waveform`} viewBox="0 0 120 40" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>{waveforms.get(cue.id)!.map((peak, i) => <line key={i} x1={i + .5} x2={i + .5} y1={20 - peak * 19} y2={20 + peak * 19} stroke="currentColor" strokeWidth=".6"/>)}</svg> : <small>{cue.video ? 'Video soundtrack' : loading ? 'Decoding waveform…' : 'Waveform unavailable'}</small>}
        </div>
        <button type="button" title={`Seek to ${cue.start}s`} aria-label={`${cue.event || cue.name} event at ${cue.start} seconds`} onClick={() => props.onSeek(cue.start)} style={{ position: 'absolute', left: `${Math.min(95, cue.start / props.duration * 100)}%`, top: 0, fontSize: 11 }}>◆ {cue.event || cue.name}</button>
        <span aria-hidden="true" style={{ position: 'absolute', left: `${props.time / props.duration * 100}%`, top: 0, bottom: 0, width: 2, background: 'var(--accent, #7160cf)' }}/>
      </div>
    </div>)}
  </section>;
}
