import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createDocument } from '../src/shared/catalog';
import { ApiError } from '../server/security';
import { withPreviewRenderTimeout } from '../server/exports';

test('a slow preview render becomes render_timeout while other failures keep their cause', async () => {
  assert.equal(await withPreviewRenderTimeout(Promise.resolve('ok'), 50), 'ok');
  await assert.rejects(withPreviewRenderTimeout(new Promise(() => {}), 20), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 504);
    assert.equal(error.code, 'render_timeout');
    assert.match(error.message, /maxDimension/);
    assert.match(error.message, /transmission/);
    return true;
  });
  await assert.rejects(withPreviewRenderTimeout(Promise.reject(new Error('context lost')), 50), /context lost/);
});

test('inspection and thumbnails render 3D scenes at output size, not page size', { timeout: 90000 }, async () => {
  const doc = createDocument('3d', 'Preview budget');
  doc.pages = [{ id: 'page', name: 'Scene', width: 1600, height: 900, background: '#050505', nodes: [
    { id: 'sphere', type: 'model3d', name: 'Sphere', x: 0, y: 0, width: 300, height: 300, data: { geometry: 'sphere' }, scene: { position: [0, 0, 0], material: { color: '#88ccff', emissive: '#ffffff', emissiveIntensity: 2, transmission: .6, clearcoat: 1 } } },
  ], scene: { camera: { position: [0, 0, 4], target: [0, 0, 0], fov: 40 }, ambient: .3, light: { position: [3, 4, 4], intensity: 1, color: '#ffffff' }, rendering: { exposure: 1, bloom: .8, bloomThreshold: .5 } } }];
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } }); await page.setContent('<html><body></body></html>');
    // Record every WebGL drawing buffer the renderer creates.
    await page.addScriptTag({ content: `globalThis.__name = fn => fn; globalThis.webglCanvases = []; const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (type, ...rest) { if (/webgl/.test(type)) globalThis.webglCanvases.push(this); return original.call(this, type, ...rest); };` });
    await page.addScriptTag({ content: await readFile('public/studio-renderer.js', 'utf8') });
    const result = await page.evaluate(async doc => {
      const g = globalThis as any;
      const measure = async (base64: string) => {
        const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, image.width, image.height).data; let lit = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 150) lit++;
        const buffers = g.webglCanvases.splice(0).map((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]);
        return { output: [image.width, image.height], buffers, lit };
      };
      const inspection = await measure(await g.studioRenderer.inspectVisual(doc, { pageIndices: [0], time: 0, mode: 'page', tileSize: 400, columns: 1, maxDimension: 400 }));
      const thumbnail = await measure(await g.studioRenderer.thumbnail(doc));
      return { inspection, thumbnail };
    }, doc);
    for (const [name, capture] of Object.entries(result)) {
      assert.ok(capture.output[0] < 1600, `${name} output is downscaled`);
      assert.ok(capture.buffers.length > 0, `${name} used WebGL`);
      for (const [width, height] of capture.buffers) {
        assert.ok(Math.abs(width - capture.output[0]) <= 1 && Math.abs(height - capture.output[1]) <= 1, `${name} renders ${width}x${height} for a ${capture.output.join('x')} output`);
      }
      assert.ok(capture.lit > 100, `${name} still shows the lit subject`);
    }
  } finally { await browser.close(); }
});
