import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import JSZip from 'jszip';
import { createDocument } from '../src/shared/catalog';
import { sceneAngles } from '../scripts/scene-angle-export';

function fixture() {
  const doc = createDocument('3d', 'Animated angle review'), page = doc.pages[0];
  page.width = 160; page.height = 120;
  page.scene = { camera: { position: [0, 0, 6], target: [0, 0, 0], fov: 45 }, ambient: 1.5, light: { position: [3, 4, 6], intensity: 3, color: '#ffffff' } };
  page.nodes = [{ id: 'moving', type: 'model3d', name: 'Moving geometry', x: 0, y: 0, width: 100, height: 100, scene: { position: [0, 0, 0], scale: [1, 1, 1], material: { color: '#ff7a32' } }, data: { geometry: 'box' } }, { id: 'hidden', type: 'model3d', name: 'Hidden geometry', x: 0, y: 0, width: 100, height: 100, visible: false, scene: { position: [0, 0, 0] } }];
  doc.timeline = { duration: 2, fps: 30, tracks: [{ id: 'move', nodeId: 'moving', keyframes: [{ time: 0, values: { 'scene.position.x': 0, 'scene.rotation.z': 0 } }, { time: 2, values: { 'scene.position.x': 8, 'scene.rotation.z': 90 } }] }] };
  return doc;
}

test('range review renders real per-time PNGs, a contact sheet and posed camera diagnostics', { timeout: 90000 }, async () => {
  const doc = fixture(), saved = JSON.stringify(doc), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); await page.setContent('<html><body></body></html>');
    await page.addScriptTag({ content: await readFile('public/studio-renderer.js', 'utf8') });
    const encoded = await page.evaluate(doc => (globalThis as any).studioRenderer.sceneAngles(doc, 0, 0, 2, 3), doc), zip = await JSZip.loadAsync(Buffer.from(encoded, 'base64'));
    const report = JSON.parse(await zip.file('views.json')!.async('string'));
    assert.equal(report.samples, 3); assert.equal(report.views.length, 12); assert.equal(report.pageId, doc.pages[0].id);
    assert.deepEqual([...new Set(report.views.map((view: any) => view.time))], [0, 1, 2]);
    for (const view of report.views) {
      const bytes = Buffer.from(await zip.file(view.file)!.async('uint8array'));
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(bytes.readUInt32BE(16), 160); assert.equal(bytes.readUInt32BE(20), 120);
      assert.equal(bytes.length, view.encodedBytes); assert(view.captureMilliseconds >= 0); assert(view.analysisMilliseconds >= 0);
      assert.equal(view.nodes[0].nodeId, 'moving'); assert.equal(view.nodes[0].time, view.time); assert.equal(view.nodes[0].cameraId, view.angle);
      assert.equal(view.nodes[0].triangles, 12); assert.equal(view.nodes[1].status, 'hidden');
    }
    const first = report.views.find((view: any) => view.angle === 'front' && view.time === 0), last = report.views.find((view: any) => view.angle === 'front' && view.time === 2);
    assert.equal(first.nodes[0].status, 'inside-camera'); assert.equal(last.nodes[0].status, 'outside-camera');
    assert(last.nodes[0].clippedVertices > 0); assert(last.nodes[0].worldBounds.min[0] > first.nodes[0].worldBounds.max[0]);
    assert.notDeepEqual(await zip.file(first.file)!.async('uint8array'), await zip.file(last.file)!.async('uint8array'));
    const sheet = Buffer.from(await zip.file('contact-sheet.png')!.async('uint8array'));
    assert.equal(sheet.readUInt32BE(16), report.contactSheet.width); assert.equal(sheet.readUInt32BE(20), report.contactSheet.height);
    const staticEncoded = await page.evaluate(doc => (globalThis as any).studioRenderer.sceneAngles(doc, 0, 0), doc), staticZip = await JSZip.loadAsync(Buffer.from(staticEncoded, 'base64'));
    assert.deepEqual(Object.keys(staticZip.files).sort(), ['back.png', 'front.png', 'left.png', 'right.png', 'views.json']);
    // A later range seek must not contaminate an earlier static capture.
    assert.deepEqual(await staticZip.file('front.png')!.async('uint8array'), await zip.file(first.file)!.async('uint8array'));
    assert.equal(await page.locator('body > section').count(), 0); assert.equal(await page.locator('body canvas').count(), 0);
    assert.equal(JSON.stringify(doc), saved);
  } finally { await browser.close(); }
});

test('review rejects invalid ranges and image budgets before allocating render resources', async () => {
  const doc = fixture();
  for (const [end, samples] of [[0, 5], [2, 1], [2, 26], [2, 2.5], [Infinity, 5]]) await assert.rejects(sceneAngles(doc, 0, 0, end, samples), /2–25 samples/);
  await assert.rejects(sceneAngles(doc, 0, -1), /start time/);
  await assert.rejects(sceneAngles(doc, 99, 0), /Unknown page/);
  doc.pages[0].width = 1920; doc.pages[0].height = 1080;
  await assert.rejects(sceneAngles(doc, 0, 0, 2, 25), /64 megapixels/);
});
