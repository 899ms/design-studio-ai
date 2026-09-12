import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { createDocument } from '../src/shared/catalog';

test('real scene effects preserve background layers in preview, PNG and decoded WebM', { timeout: 90000 }, async () => {
  const bundle = await build({ stdin: { contents: `
    import {captureExportPage,rasterizeExportPage} from './src/app/export-page';import {createElement} from 'react';import {createRoot} from 'react-dom/client';import {SceneView} from './src/app/scene-view';
    globalThis.effectsCapture={captureExportPage,rasterizeExportPage};globalThis.mountEffectsPreview=doc=>{const host=document.createElement('div');host.id='effects-preview';host.style.cssText='width:160px;height:120px;position:relative';document.body.append(host);const root=createRoot(host);root.render(createElement(SceneView,{doc,page:doc.pages[0],theme:doc.theme,selected:null,onSelect:()=>{}}));globalThis.unmountEffectsPreview=()=>{root.unmount();host.remove();};};`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const doc = createDocument('3d', 'Effects fidelity');
  doc.pages = [{ id: 'page', name: 'Scene', width: 160, height: 120, background: '#050505', nodes: [
    { id: 'underlay', type: 'shape', name: 'Red underlay', x: 0, y: 0, width: 160, height: 120, style: { fill: '#701020' } },
    { id: 'sphere', type: 'model3d', name: 'Sphere', x: 0, y: 0, width: 300, height: 300, data: { geometry: 'sphere' }, scene: { position: [0, 0, 0], material: { color: '#777777', roughness: .5, metalness: .1 } } },
  ], scene: { camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 40 }, ambient: .2, light: { position: [3, 4, 4], intensity: 1, color: '#ffffff' }, rendering: { exposure: 1 } } }];
  doc.timeline = { duration: .6, fps: 10, tracks: [] };
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } }); await page.setContent('<html><body></body></html>');
    await page.addStyleTag({ content: await readFile('src/styles.css', 'utf8') });
    await page.addScriptTag({ content: 'globalThis.__name = fn => fn;' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text }); await page.addScriptTag({ content: await readFile('public/studio-renderer.js', 'utf8') });
    const effects = await page.evaluate(async input => {
      const capture = async (doc: typeof input, time = 0) => {
        const rendered = await (globalThis as any).effectsCapture.captureExportPage(doc, 0, time);
        const png = rendered.toDataURL('image/png'), image = new Image(); image.src = png; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120; canvas.getContext('2d')!.drawImage(image, 0, 0);
        return { png, pixels: canvas.getContext('2d')!.getImageData(0, 0, 160, 120).data };
      };
      const changed = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let count = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 15) count++; return count; };
      const corner = (pixels: Uint8ClampedArray) => [...pixels.slice((2 * 160 + 2) * 4, (2 * 160 + 2) * 4 + 4)];
      const base = await capture(input), litDoc = structuredClone(input);
      litDoc.pages[0].scene!.lights = [{ id: 'red-light', type: 'point', position: [0, 1, 2], color: '#ff0000', intensity: 50 }];
      const lit = await capture(litDoc), fogDoc = structuredClone(input); fogDoc.pages[0].scene!.atmosphere = { fogColor: '#335588', fogDensity: .2 };
      const fog = await capture(fogDoc), environmentDoc = structuredClone(input); environmentDoc.pages[0].scene!.rendering!.environmentIntensity = 2;
      const environment = await capture(environmentDoc), glowDoc = structuredClone(input);
      glowDoc.pages[0].nodes[1].scene!.material = { ...glowDoc.pages[0].nodes[1].scene!.material, emissive: '#ffffff', emissiveIntensity: 3 };
      const noBloom = await capture(glowDoc); glowDoc.pages[0].scene!.rendering = { exposure: 1, bloom: 1, bloomThreshold: .3 };
      const bloom = await capture(glowDoc), particleDoc = structuredClone(input);
      const transparentDoc = structuredClone(input); transparentDoc.pages[0].scene!.rendering = { exposure: 1, bloom: 1, bloomThreshold: 10 };
      const transparentBloom = await capture(transparentDoc); (globalThis as any).effectsPreviewDocument = transparentDoc; (globalThis as any).effectsPreviewPixels = transparentBloom.pixels;
      particleDoc.pages[0].scene!.emitters = [{ id: 'particles', position: [-1, 0, 1], spread: [3, 1, 1], velocity: [1, .2, 0], count: 250, size: .06, color: '#00ffff', lifetime: 2, seed: 7, start: 0, end: 2 }];
      const particles = await capture(particleDoc), movedParticles = await capture(particleDoc, .5), soughtParticles = await capture(particleDoc);
      const combined = structuredClone(glowDoc); combined.pages[0].scene!.lights = litDoc.pages[0].scene!.lights; combined.pages[0].scene!.atmosphere = fogDoc.pages[0].scene!.atmosphere; combined.pages[0].scene!.emitters = particleDoc.pages[0].scene!.emitters; combined.pages[0].scene!.rendering!.environmentIntensity = 2;
      const combinedPng = await capture(combined); (globalThis as any).effectsDocument = combined; (globalThis as any).effectsPngPixels = combinedPng.pixels;
      return { light: changed(base.pixels, lit.pixels), fog: changed(base.pixels, fog.pixels), environment: changed(base.pixels, environment.pixels), bloom: changed(noBloom.pixels, bloom.pixels), particles: changed(base.pixels, particles.pixels), motion: changed(particles.pixels, movedParticles.pixels), seek: changed(particles.pixels, soughtParticles.pixels), baseCorner: corner(base.pixels), transparentBloomCorner: corner(transparentBloom.pixels), combinedCorner: corner(combinedPng.pixels), pngLength: combinedPng.png.length };
    }, doc);
    for (const effect of ['light', 'fog', 'environment', 'bloom', 'particles', 'motion'] as const) assert.ok(effects[effect] > 30, `${effect}: ${JSON.stringify(effects)}`);
    assert.equal(effects.seek, 0, 'Seeking back must produce the same seeded particles');
    assert.deepEqual(effects.baseCorner, [112, 16, 32, 255]);
    assert.deepEqual(effects.transparentBloomCorner, [112, 16, 32, 255], 'Bloom must keep the red layer where there is no glow');
    assert.ok(effects.pngLength > 1000);
    await page.evaluate(() => (globalThis as any).mountEffectsPreview((globalThis as any).effectsPreviewDocument));
    await expect(page.locator('#effects-preview [data-scene-layer="3d"]')).toBeVisible();
    await expect(page.locator('#effects-preview .scene-toolbar')).toHaveCount(0);
    await expect(page.locator('#effects-preview [data-scene-safe-frame]')).toHaveCount(0);
    await expect.poll(() => page.locator('#effects-preview [data-scene-frame]').evaluate(frame => { const box = frame.getBoundingClientRect(); return Math.round(box.width / box.height * 1000); })).toBe(1333);
    const frameBounds = await page.locator('#effects-preview [data-scene-frame]').boundingBox(), viewportBounds = await page.locator('#effects-preview [data-scene-viewport]').boundingBox();
    assert.ok(frameBounds && viewportBounds && frameBounds.height < viewportBounds.height, 'A tall workspace must letterbox the landscape page');
    const preview = await page.evaluate(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const host = document.querySelector<HTMLElement>('#effects-preview .scene-view')!;
      const canvas = await (globalThis as any).effectsCapture.rasterizeExportPage(host, 160, 120);
      const pixels = canvas.getContext('2d').getImageData(0, 0, 160, 120).data, expected = (globalThis as any).effectsPreviewPixels;
      let difference = 0; for (let i = 0; i < pixels.length; i++) difference += Math.abs(pixels[i] - expected[i]);
      const corner = [...canvas.getContext('2d').getImageData(2, 2, 1, 1).data]; (globalThis as any).unmountEffectsPreview(); return { corner, meanError: difference / pixels.length };
    });
    assert.ok(preview.corner[0] >= 100 && preview.corner[1] < 80 && preview.corner[2] < 100, `Preview obscured the red underlay: ${preview.corner}`);
    assert.ok(preview.meanError < 2.5, `Preview differs from PNG by ${preview.meanError} channel levels`);
    const video = await page.evaluate(async () => {
      const base64 = await (globalThis as any).studioRenderer.video((globalThis as any).effectsDocument, 0, 'webm');
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0)), blob = new Blob([bytes], { type: 'video/webm' }), url = URL.createObjectURL(blob), video = document.createElement('video');
      try {
        await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error('Could not decode the real effects WebM')); video.src = url; });
        video.muted = true;
        const presented = new Promise<void>(resolve => video.requestVideoFrameCallback(() => resolve()));
        await video.play(); await presented; video.pause();
        const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120; const context = canvas.getContext('2d')!; context.drawImage(video, 0, 0);
        const pixels = context.getImageData(0, 0, 160, 120).data, expected = (globalThis as any).effectsPngPixels;
        let difference = 0; for (let i = 0; i < pixels.length; i += 4) for (let channel = 0; channel < 3; channel++) difference += Math.abs(pixels[i + channel] - expected[i + channel]);
        return { bytes: bytes.length, width: video.videoWidth, height: video.videoHeight, corner: [...context.getImageData(2, 2, 1, 1).data], meanError: difference / (160 * 120 * 3) };
      } finally { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
    });
    assert.ok(video.bytes > 1000); assert.deepEqual([video.width, video.height], [160, 120]);
    assert.ok(video.corner.every((value, index) => Math.abs(value - effects.combinedCorner[index]) < 25), `WebM corner ${video.corner} differs from PNG ${effects.combinedCorner}`);
    assert.ok(video.meanError < 25, `Decoded WebM differs from the PNG by ${video.meanError} channel levels`);
  } finally { await browser.close(); }
});
