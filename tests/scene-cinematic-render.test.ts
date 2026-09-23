import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { createDocument } from '../src/shared/catalog';

test('cinematic environment, post effects and styled particles render in real WebGL', { timeout: 90000 }, async () => {
  const bundle = await build({ stdin: { contents: `import {captureExportPage} from './src/app/export-page';globalThis.cinematicCapture=captureExportPage;`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const doc = createDocument('3d', 'Cinematic fidelity');
  doc.pages = [{ id: 'page', name: 'Scene', width: 160, height: 120, background: '#050505', nodes: [
    { id: 'underlay', type: 'shape', name: 'Red underlay', x: 0, y: 0, width: 160, height: 120, style: { fill: '#701020' } },
    { id: 'near', type: 'model3d', name: 'Near sphere', x: 0, y: 0, width: 300, height: 300, data: { geometry: 'sphere' }, scene: { position: [-.8, 0, 1.5], scale: [.6, .6, .6], material: { color: '#3070ff', roughness: .4, metalness: 0 } } },
    { id: 'sun', type: 'model3d', name: 'Glowing sphere', x: 0, y: 0, width: 300, height: 300, data: { geometry: 'sphere' }, scene: { position: [1, .6, -3], scale: [.5, .5, .5], material: { color: '#ffffff', emissive: '#ffeecc', emissiveIntensity: 6 } } },
  ], scene: { camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45 }, ambient: .6, light: { position: [3, 4, 4], intensity: 2, color: '#ffffff' }, rendering: { exposure: 1 } } }];
  doc.timeline = { duration: 1, fps: 10, tracks: [] };
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } }), errors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ content: 'globalThis.__name = fn => fn;' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(async input => {
      const capture = async (doc: typeof input, time = 0) => {
        const rendered = await (globalThis as any).cinematicCapture(doc, 0, time), canvas = document.createElement('canvas');
        canvas.width = 160; canvas.height = 120; canvas.getContext('2d')!.drawImage(rendered, 0, 0);
        return canvas.getContext('2d')!.getImageData(0, 0, 160, 120).data;
      };
      const changed = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let count = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 15) count++; return count; };
      const pixel = (pixels: Uint8ClampedArray, x: number, y: number) => [...pixels.slice((y * 160 + x) * 4, (y * 160 + x) * 4 + 4)];
      const luminance = (p: number[]) => p[0] * .2126 + p[1] * .7152 + p[2] * .0722;
      const withRendering = (rendering: object, extra: (doc: typeof input) => void = () => {}) => { const next = structuredClone(input); next.pages[0].scene!.rendering = { exposure: 1, ...rendering } as never; extra(next); return next; };
      const sky = { environment: 'sky', environmentBackground: true, sky: { elevation: 10, azimuth: 180 } };
      const base = await capture(input), skyPixels = await capture(withRendering(sky));
      const vignette = await capture(withRendering({ ...sky, vignette: 1 }));
      const gray = await capture(withRendering({ ...sky, grading: { saturation: 0 } }));
      const dof = await capture(withRendering({ ...sky, depthOfField: { focus: 8, aperture: 1, maxBlur: .03 } }));
      const shafts = await capture(withRendering({ ...sky, lightShafts: { position: [1, .6, -3], intensity: 2, threshold: .5 } }));
      const grainDoc = withRendering({ ...sky, grain: .6 }), grainA = await capture(grainDoc, .3), grainB = await capture(grainDoc, .3);
      const panorama = document.createElement('canvas'); panorama.width = 64; panorama.height = 32; const context = panorama.getContext('2d')!;
      context.fillStyle = '#20e040'; context.fillRect(0, 0, 64, 16); context.fillStyle = '#e02040'; context.fillRect(0, 16, 64, 16);
      const panoramaPixels = await capture(withRendering({ environment: 'panorama', environmentAssetId: 'pano', environmentBackground: true }, doc => { doc.assets = [{ id: 'pano', name: 'Panorama', mimeType: 'image/png', url: panorama.toDataURL('image/png') } as never]; }));
      const snow = await capture(withRendering({}, doc => { doc.pages[0].scene!.emitters = [{ id: 'snow', position: [0, 0, 1], spread: [4, 3, 1], velocity: [0, -.4, 0], count: 400, size: .12, color: '#ffffff', lifetime: 4, seed: 3, sprite: 'flake', blending: 'normal', opacity: 1, fadeIn: .1, fadeOut: .1, sizeVariance: .4, turbulence: .3 }]; }), .5);
      const glowOff = await capture(withRendering({ bloom: 1.5, bloomThreshold: .2 }, doc => { doc.pages[0].nodes[2].scene!.material!.bloom = false; }));
      const glowOn = await capture(withRendering({ bloom: 1.5, bloomThreshold: .2 }));
      const skyBloom = await capture(withRendering({ ...sky, bloom: 1, bloomThreshold: 1 }));
      const grayCenter = pixel(gray, 20, 60);
      return {
        sky: changed(base, skyPixels), skyCorner: pixel(skyPixels, 2, 2), baseCorner: pixel(base, 2, 2), vignetteCorner: luminance(pixel(vignette, 1, 1)), skyCornerLuma: luminance(pixel(skyPixels, 1, 1)),
        graySpread: Math.max(...grayCenter.slice(0, 3)) - Math.min(...grayCenter.slice(0, 3)), dof: changed(skyPixels, dof), shafts: changed(skyPixels, shafts),
        grain: changed(skyPixels, grainA), grainRepeat: changed(grainA, grainB), panorama: changed(base, panoramaPixels), snow: changed(base, snow), bloomMask: changed(glowOff, glowOn), skyBloom: changed(skyPixels, skyBloom),
      };
    }, doc);
    const shaderErrors = errors.filter(message => /shader|WebGLProgram|GL_INVALID/i.test(message));
    assert.deepEqual(shaderErrors, []);
    assert.deepEqual(result.baseCorner, [112, 16, 32, 255], 'Without a background the page underlay remains visible');
    assert.ok(result.sky > 1000 && result.skyCorner[3] === 255, `The sky background must cover the frame: ${JSON.stringify(result)}`);
    assert.ok(result.vignetteCorner < result.skyCornerLuma * .6, `Vignette must darken corners: ${JSON.stringify(result)}`);
    assert.ok(result.graySpread <= 4, `Zero saturation must render gray: ${JSON.stringify(result)}`);
    for (const effect of ['dof', 'shafts', 'grain', 'panorama', 'snow', 'bloomMask'] as const) assert.ok(result[effect] > 30, `${effect}: ${JSON.stringify(result)}`);
    assert.ok(result.skyBloom < 160 * 120 * .25, `An HDR sky background must not bloom the whole frame: ${JSON.stringify(result)}`);
    assert.equal(result.grainRepeat, 0, 'Grain is seeded by timeline time so exports are repeatable');
  } finally { await browser.close(); }
});
