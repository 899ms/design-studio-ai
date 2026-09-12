import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createDocument } from '../src/shared/catalog';
import { audioCuePosition, timelineAudioCues, waveformPeaks, cueWaveformPeaks } from '../src/shared/timeline-audio';

const node = { id: 'sound', type: 'audio' as const, name: 'Roar', src: 'https://example.com/roar.wav', x: 0, y: 0, width: 100, height: 30 };
test('audio cues keep legacy defaults, source trim, loop boundaries and visible media', () => {
  const [legacy] = timelineAudioCues([node], 5);
  assert.deepEqual([legacy.start, legacy.end, legacy.offset, legacy.gain, legacy.muted, legacy.loop], [0, 5, 0, 1, false, false]);
  const [cue] = timelineAudioCues([{ ...node, data: { audioStart: 1, audioEnd: 4, audioOffset: .5, audioGain: .25, audioLoop: true, audioEvent: 'Wingbeat' } }], 5);
  assert.equal(audioCuePosition(cue, .9, 2), undefined);
  assert.equal(audioCuePosition(cue, 1, 2), .5);
  assert.equal(audioCuePosition(cue, 2.5, 2), .5);
  assert.equal(audioCuePosition(cue, 4, 2), undefined);
  assert.equal(audioCuePosition({ ...cue, loop: false }, 2.5, 2), undefined);
  assert.equal(audioCuePosition(cue, 2, .5), undefined);
  assert.equal(timelineAudioCues([{ ...node, visible: false }, { ...node, src: undefined }], 5).length, 0);
  assert.deepEqual(waveformPeaks([new Float32Array([0, -.5, .1, .2]), new Float32Array([.8, 0, -.3, 0])], 2).map(n => Math.round(n * 10) / 10), [.8, .3]);
  assert.deepEqual(cueWaveformPeaks([0, 0, 1, 1], 1, { ...legacy, offset: .5, end: 1 }, 2), [1, 0]);
});

// An actual PCM test signal: silence then a tone makes incorrect source offsets observable.
function toneWav() {
  const rate = 16000, samples = rate, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = rate / 2; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i / rate * 440 * 2 * Math.PI) * 12000), 44 + i * 2);
  return `data:audio/wav;base64,${bytes.toString('base64')}`;
}

test('audio controls expose real waveform, event seek and editable gain on desktop and mobile', { timeout: 60000 }, async () => {
  const bundle = await build({ stdin: { contents: `
    import {createElement,useState} from 'react'; import {createRoot} from 'react-dom/client'; import {TimelineAudioPlayer} from './src/app/timeline-audio-player';
    globalThis.mountPlayer = (initial) => {
      function Player() { const [nodes,setNodes]=useState(initial),[time,setTime]=useState(0),[playing,setPlaying]=useState(false); globalThis.observation={time,playing,nodes};
        return createElement('div',null,createElement('button',{onClick:()=>setPlaying(!playing)},'Test play'),createElement(TimelineAudioPlayer,{nodes,duration:1,time,playing,onTime:setTime,onEnded:()=>setPlaying(false),onSeek:value=>{setTime(value);setPlaying(false);},onChangeNode:(id,patch)=>setNodes(nodes.map(n=>n.id===id?{...n,data:{...n.data,...patch}}:n))})); }
      const root=createRoot(document.getElementById('root'));root.render(createElement(Player));globalThis.unmountPlayer=()=>root.unmount();
    };`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      await page.setContent('<html><body><div id="root"></div></body></html>');
      await page.addStyleTag({ content: await readFile('src/styles.css', 'utf8') });
      await page.addStyleTag({ content: await readFile('src/app/studio-feedback.css', 'utf8') });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate(nodes => (globalThis as any).mountPlayer(nodes), [{ ...node, src: toneWav(), data: { audioStart: .2, audioEnd: .8, audioOffset: .5, audioEvent: 'Roar onset' } }]);
      await expect(page.getByRole('img', { name: 'Roar source waveform' })).toBeVisible();
      await page.getByRole('button', { name: 'Roar onset event at 0.2 seconds' }).click();
      assert.equal(await page.evaluate(() => (globalThis as any).observation.time), .2);
      await page.getByRole('spinbutton', { name: 'Roar Gain', exact: true }).fill('0.3');
      await expect.poll(() => page.evaluate(() => (globalThis as any).observation.nodes[0].data.audioGain)).toBe(.3);
      await expect(page.getByRole('button', { name: 'Enable audio', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Test play', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (globalThis as any).observation.time)).toBeGreaterThan(.2);
      await page.getByRole('button', { name: 'Test play', exact: true }).click();
      assert.equal(await page.evaluate(() => (globalThis as any).observation.playing), false);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Audio controls overflow at ${width}px`);
      await page.evaluate(() => (globalThis as any).unmountPlayer()); await page.close();
    }
  } finally { await browser.close(); }
});

test('real Web Audio pauses and seeks its clock, then 3D video exports scheduled audio and overlays', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage(); await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ content: 'globalThis.__name = (fn) => fn;' });
    const bundle = await build({ stdin: { contents: "import {createTimelineAudioEngine,timelineAudioCues} from './src/shared/timeline-audio';globalThis.audioTools={createTimelineAudioEngine,timelineAudioCues};", resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const doc = createDocument('video', 'Audio schedule');
    doc.pages = [{ id: 'page', name: 'Page', width: 160, height: 90, background: '#ffffff', nodes: [
      { ...node, src: toneWav(), data: { audioStart: .2, audioEnd: .65, audioOffset: .5, audioGain: .5 } },
      { ...node, id: 'muted', src: toneWav(), data: { audioMuted: true, audioOffset: .5, audioLoop: true } },
    ] }];
    doc.timeline = { duration: 1, fps: 15, tracks: [] };
    const clock = await page.evaluate(async doc => {
      const tools = (globalThis as any).audioTools, player = await tools.createTimelineAudioEngine(tools.timelineAudioCues(doc.pages[0].nodes, 1), { audible: false });
      try {
        const waitForClock = async (start:number) => {const deadline=performance.now()+2000;while(player.currentTime()<=start&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));};
        await player.play(.1, 1); await waitForClock(.1);
        const advanced = player.currentTime(); player.pause(); const paused = player.currentTime();
        await new Promise(resolve => setTimeout(resolve, 60)); const after = player.currentTime();
        player.seek(.5); const sought = player.currentTime(); await player.play(.5, 1); await waitForClock(.5);
        return { advanced, paused, after, sought, resumed: player.currentTime(), peaks: player.waveforms.get('sound'), tracks: player.stream.getAudioTracks().length };
      } finally { await player.dispose(); if (player.context.state !== 'closed' || player.stream.getTracks().some((track: MediaStreamTrack) => track.readyState !== 'ended')) throw new Error('Audio resources leaked'); }
    }, doc);
    assert.ok(clock.advanced > .1); assert.equal(clock.paused, clock.after); assert.equal(clock.sought, .5); assert.ok(clock.resumed > .5); assert.equal(clock.tracks, 1); assert.ok(clock.peaks.some((n: number) => n > .2));
    doc.kind = '3d';
    doc.pages[0].nodes.push({ id: 'sphere', type: 'model3d', name: 'Sphere', x: 40, y: 20, width: 60, height: 60, data: { geometry: 'sphere' } });
    doc.pages[0].nodes.push({ id: 'overlay', type: 'shape', name: 'Overlay', x: 0, y: 0, width: 20, height: 20, style: { fill: '#ff0000' } });
    await page.addScriptTag({ content: await readFile('public/studio-renderer.js', 'utf8') });
    const levels = await page.evaluate(async doc => {
      const original = CanvasCaptureMediaStreamTrack.prototype.requestFrame; let first: number[] = [];
      CanvasCaptureMediaStreamTrack.prototype.requestFrame = function () { if (!first.length) first = [...document.querySelector('canvas')!.getContext('2d')!.getImageData(5, 5, 1, 1).data]; return original.call(this); };
      let encoded: string;
      try { encoded = await (globalThis as any).studioRenderer.video(doc, 0, 'webm'); }
      finally { CanvasCaptureMediaStreamTrack.prototype.requestFrame = original; }
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0)), length = bytes.length, context = new AudioContext();
      try {
        const decoded = await context.decodeAudioData(bytes.buffer), data = decoded.getChannelData(0);
        const rms = (start: number, end: number) => { let sum = 0, count = 0; for (let i = Math.floor(start * decoded.sampleRate); i < Math.min(data.length, end * decoded.sampleRate); i++) { sum += data[i] ** 2; count++; } return Math.sqrt(sum / Math.max(1, count)); };
        return { before: rms(.03, .13), during: rms(.3, .5), after: rms(.8, .95), length, first };
      } finally { await context.close(); }
    }, doc);
    assert.ok(levels.length > 500, JSON.stringify(levels)); assert.ok(levels.before < .005, JSON.stringify(levels)); assert.ok(levels.during > .04, JSON.stringify(levels)); assert.ok(levels.during < .2, 'Gain should attenuate the source'); assert.ok(levels.after < .005, JSON.stringify(levels));
    assert.deepEqual(levels.first, [255, 0, 0, 255], '3D video keeps the 2D overlay above its scene');
  } finally { await browser.close(); }
});
