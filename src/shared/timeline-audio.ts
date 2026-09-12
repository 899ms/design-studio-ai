import type { DesignNode } from './schema';

export type AudioCue = { id: string; name: string; src: string; start: number; end: number; offset: number; gain: number; muted: boolean; loop: boolean; event: string; video: boolean };
const number = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Media uses document seconds; source offsets are measured in the original file. */
export function timelineAudioCues(nodes: DesignNode[], duration: number): AudioCue[] {
  return nodes.filter(n => (n.type === 'audio' || n.type === 'video') && n.src && n.visible !== false).map(n => ({
    id: n.id, name: n.name, src: n.src!, start: Math.max(0, number(n.data?.audioStart, 0)),
    end: Math.min(duration, number(n.data?.audioEnd, duration)), offset: Math.max(0, number(n.data?.audioOffset, 0)),
    gain: Math.max(0, Math.min(4, number(n.data?.audioGain, 1))), muted: n.data?.audioMuted === true,
    loop: n.data?.audioLoop === true, event: typeof n.data?.audioEvent === 'string' ? n.data.audioEvent : '', video: n.type === 'video',
  }));
}

export function audioCuePosition(cue: AudioCue, time: number, sourceDuration: number): number | undefined {
  if (time < cue.start || time >= cue.end || sourceDuration <= cue.offset) return undefined;
  const elapsed = time - cue.start, available = sourceDuration - cue.offset;
  if (!cue.loop && elapsed >= available) return undefined;
  return cue.offset + (cue.loop ? elapsed % available : elapsed);
}

export function waveformPeaks(channels: readonly Float32Array[], count = 120): number[] {
  if (!channels.length || !channels[0].length || count < 1) return [];
  const length = channels[0].length;
  return Array.from({ length: Math.floor(count) }, (_, i) => {
    const start = Math.floor(i * length / count), end = Math.min(length, Math.max(start + 1, Math.floor((i + 1) * length / count)));
    let peak = 0;
    for (const channel of channels) for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(channel[j] ?? 0));
    return Math.min(1, peak);
  });
}

/** Project decoded source peaks onto the cue, including its trim, repeats and silence. */
export function cueWaveformPeaks(source: number[], sourceDuration: number, cue: AudioCue, count = 120): number[] {
  return Array.from({ length: count }, (_, i) => {
    let peak = 0;
    for (let sample = 0; sample < 8; sample++) {
      const time = cue.start + (i + sample / 8) / count * (cue.end - cue.start);
      const position = audioCuePosition(cue, time, sourceDuration);
      if (position !== undefined) peak = Math.max(peak, source[Math.min(source.length - 1, Math.floor(position / sourceDuration * source.length))] ?? 0);
    }
    return peak;
  });
}

type LoadedCue = { cue: AudioCue; buffer?: AudioBuffer; element?: HTMLVideoElement; gain: GainNode; source?: AudioBufferSourceNode; mediaSource?: MediaElementAudioSourceNode };
export type TimelineAudioEngine = {
  context: AudioContext; stream: MediaStream; media: Map<string, HTMLMediaElement>; waveforms: Map<string, number[]>;
  play(time: number, end?: number): Promise<void>; pause(time?: number): void; seek(time: number): void; currentTime(): number; dispose(): Promise<void>;
};

/** One audio clock and mixer for the editor, viewer and video renderer. */
export async function createTimelineAudioEngine(cues: AudioCue[], options: { audible?: boolean; signal?: AbortSignal; onError?: (error: Error) => void } = {}): Promise<TimelineAudioEngine> {
  if (typeof AudioContext === 'undefined') throw new Error('Timeline audio is unavailable in this browser. Use a browser with Web Audio support.');
  const context = new AudioContext(), destination = context.createMediaStreamDestination();
  const entries: LoadedCue[] = [], media = new Map<string, HTMLMediaElement>(), waveforms = new Map<string, number[]>();
  const abort = new AbortController();
  let disposed = false, playing = false, position = 0, clockStart = 0, rangeEnd = Infinity, timer: ReturnType<typeof setInterval> | undefined;
  const stopSources = () => {
    for (const entry of entries) {
      if (entry.source) { try { entry.source.stop(); } catch { /* A naturally ended source needs no stop. */ } entry.source.disconnect(); entry.source = undefined; }
      entry.element?.pause();
    }
  };
  const currentTime = () => playing ? Math.min(rangeEnd, position + context.currentTime - clockStart) : position;
  const pause = (time = currentTime()) => { position = time; playing = false; clearInterval(timer); stopSources(); };
  const dispose = async () => {
    if (disposed) return;
    disposed = true; abort.abort(); pause(); options.signal?.removeEventListener('abort', onAbort);
    for (const entry of entries) { entry.mediaSource?.disconnect(); entry.gain.disconnect(); if (entry.element) { entry.element.removeAttribute('src'); entry.element.load(); } }
    destination.disconnect(); destination.stream.getTracks().forEach(t => t.stop());
    if (context.state !== 'closed') await context.close();
  };
  const onAbort = () => { void dispose(); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const fail = (error: unknown) => { pause(); options.onError?.(error instanceof Error ? error : new Error(String(error))); };
  const syncVideo = () => {
    if (!playing) return;
    const time = currentTime();
    if (time >= rangeEnd) { pause(rangeEnd); return; }
    for (const { cue, element } of entries) if (element) {
      const at = audioCuePosition(cue, time, element.duration);
      if (at === undefined) { element.pause(); continue; }
      if (Math.abs(element.currentTime - at) > .08) element.currentTime = at;
      if (element.paused && !element.ended) void element.play().catch(fail);
      else if (element.ended && cue.loop) { element.currentTime = at; void element.play().catch(fail); }
    }
  };
  const schedule = () => {
    stopSources();
    for (const entry of entries) {
      const { cue, buffer } = entry;
      if (!buffer || cue.muted || !cue.gain || buffer.duration <= cue.offset) continue;
      const start = Math.max(position, cue.start), end = Math.min(rangeEnd, cue.end, cue.loop ? Infinity : cue.start + buffer.duration - cue.offset);
      if (end <= start) continue;
      const source = context.createBufferSource(); source.buffer = buffer; source.loop = cue.loop; source.loopStart = cue.offset; source.loopEnd = buffer.duration;
      source.connect(entry.gain); entry.source = source;
      source.start(clockStart + start - position, audioCuePosition(cue, start, buffer.duration)!, end - start);
    }
    syncVideo();
  };
  try {
    if (options.signal?.aborted) throw new DOMException('Audio loading cancelled.', 'AbortError');
    // Load sequentially to bound concurrent decoding memory for large imported files.
    for (const cue of cues) {
      const gain = context.createGain(); gain.gain.value = cue.muted ? 0 : cue.gain; gain.connect(destination);
      if (options.audible !== false) gain.connect(context.destination);
      const entry: LoadedCue = { cue, gain }; entries.push(entry);
      if (cue.video) {
        const element = document.createElement('video'); entry.element = element; element.crossOrigin = 'anonymous'; element.preload = 'auto'; element.playsInline = true;
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => done(new Error(`Loading media timed out: ${cue.name}`)), 30000);
          const cancelled = () => done(new DOMException('Audio loading cancelled.', 'AbortError'));
          const done = (error?: Error) => { clearTimeout(timeout); element.onloadeddata = element.onerror = null; abort.signal.removeEventListener('abort', cancelled); error ? reject(error) : resolve(); };
          element.onloadeddata = () => done(); element.onerror = () => done(new Error(`Could not decode media: ${cue.name}`)); abort.signal.addEventListener('abort', cancelled, { once: true }); element.src = cue.src;
        });
        entry.mediaSource = context.createMediaElementSource(element); entry.mediaSource.connect(gain); media.set(cue.id, element);
      } else {
        const response = await fetch(cue.src, { credentials: 'same-origin', signal: abort.signal });
        if (!response.ok) throw new Error(`Could not load audio “${cue.name}” (${response.status}). Re-import the file.`);
        try { entry.buffer = await context.decodeAudioData(await response.arrayBuffer()); }
        catch (error) { if (abort.signal.aborted) throw error; throw new Error(`Could not decode audio “${cue.name}”. Use a supported audio file.`); }
        waveforms.set(cue.id, cueWaveformPeaks(waveformPeaks(Array.from({ length: entry.buffer.numberOfChannels }, (_, i) => entry.buffer!.getChannelData(i)), 1024), entry.buffer.duration, cue));
      }
      if (abort.signal.aborted) throw new DOMException('Audio loading cancelled.', 'AbortError');
    }
    return {
      context, stream: destination.stream, media, waveforms, currentTime, pause, dispose,
      async play(time, end = Infinity) {
        if (disposed) throw new Error('Audio player is closed.');
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([context.resume(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Audio is blocked. Click Enable audio, then play again.')), 2500); })]); }
        finally { clearTimeout(timeout); }
        if (context.state !== 'running') throw new Error('Audio is blocked. Click Enable audio, then play again.');
        pause(time); rangeEnd = end; clockStart = context.currentTime; playing = true; schedule(); timer = setInterval(syncVideo, 16);
      },
      seek(time) { position = time; clockStart = context.currentTime; if (playing) schedule(); else for (const { cue, element } of entries) if (element) element.currentTime = audioCuePosition(cue, time, element.duration) ?? Math.min(cue.offset, element.duration); },
    };
  } catch (error) { await dispose(); throw error; }
}
