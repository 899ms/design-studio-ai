import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from '../server/index';
import { FileBucket, SqliteDatabase } from '../server/node-adapters';
import { secret } from '../server/security';
import { PROJECT_ASSET_QUOTA } from '../server/asset-lifecycle';
import type { Bindings } from '../server/types';
import type { Project, AssetRef } from '../src/shared/schema';
import { upgradeDocument } from '../src/shared/document-upgrade';
import { paintingSchema } from '../src/shared/painting-schema';
import { encodePaintPng, paintHash } from '../src/shared/paint-png';
import { builtStaticAssets } from './built-static-assets';

function triangleGlb() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  }));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const bytes = new Uint8Array(12 + 8 + jsonLength + 8 + positions.byteLength), header = new DataView(bytes.buffer);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, bytes.length, true);
  header.setUint32(12, jsonLength, true); header.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + jsonLength); bytes.set(json, 20);
  header.setUint32(20 + jsonLength, positions.byteLength, true); header.setUint32(24 + jsonLength, 0x004e4942, true);
  bytes.set(new Uint8Array(positions.buffer), 28 + jsonLength);
  return bytes;
}

test('creative persistence validates real tile bytes, returns durable retry receipts and protects v2/publication boundaries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'creative-persistence-')), db = new SqliteDatabase(join(directory, 'db.sqlite'));
  const origin = 'https://studio.example';
  const env: Bindings = { DB: db, ASSETS_BUCKET: new FileBucket(join(directory, 'assets')), ASSETS: builtStaticAssets, APP_URL: origin, ENCRYPTION_KEY: secret(), ALLOW_REGISTRATION: 'true' };
  let cookie = '';
  const request = (path: string, method = 'GET', body?: unknown) => app.request(origin + path, { method, headers: { Origin: origin, Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, env);
  const projectFrom = async (response: Response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return (await response.json() as { project: Project }).project; };
  try {
    for (const file of (await readdir(new URL('../migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    const signup = await request('/api/auth/register', 'POST', { email: 'paint@studio.test', password: secret() }); assert.equal(signup.status, 201); cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const initial = await projectFrom(await request('/api/projects', 'POST', { name: 'Paint', kind: 'web' }), 201);
    const pixels = new Uint8Array(512 * 512 * 4); pixels.set([180, 60, 20, 255], (100 * 512 + 100) * 4);
    const png = await encodePaintPng(512, 512, pixels), form = new FormData(); form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'tile.png');
    const uploaded = await app.request(origin + `/api/projects/${initial.id}/assets`, { method: 'POST', headers: { Origin: origin, Cookie: cookie }, body: form }, env); assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const asset = (await uploaded.json() as { asset: AssetRef }).asset, doc = upgradeDocument(initial.document); doc.assets.push(asset);
    doc.paintings.push(paintingSchema.parse({ id: 'paint', name: 'Painting', width: 512, height: 512, generation: 0, colorSpace: 'srgb', algorithm: 'cpu-srgb-grain-v1', tileSize: 512, layers: [{ id: 'layer', name: 'Color', visible: true, locked: false, opacity: 1, blend: 'normal', tiles: [{ x: 0, y: 0, assetId: asset.id, hash: await paintHash(png), generation: 0 }] }] }));
    doc.pages[0].nodes.push({ id: 'art', name: 'Art', type: 'artwork', x: 0, y: 0, width: 512, height: 512, paintingId: 'paint' });
    const route = `/api/projects/${initial.id}/document`, payload = { document: doc, expectedRevision: initial.revision, operationId: 'stroke-save' };
    const saved = await projectFrom(await request(route, 'PUT', payload));
    assert.equal(saved.document.schemaVersion, 2); if (saved.document.schemaVersion !== 2) throw new Error('Missing v2');
    const composite = saved.document.paintings[0].composite!; assert.ok(composite); assert.notEqual(composite.assetId, asset.id);
    await t.test('retry resolves the committed receipt without another generation or composite', async () => {
      const retry = await projectFrom(await request(route, 'PUT', payload)); assert.deepEqual(retry, saved);
      const changed = structuredClone(payload); changed.document.name = 'Other payload'; const response = await request(route, 'PUT', changed); assert.equal(response.status, 409); assert.match(await response.text(), /operation_id_conflict/);
      assert.equal((await projectFrom(await request(`/api/projects/${initial.id}`))).revision, saved.revision);
    });
    await t.test('old clients and guessed future revisions cannot downgrade stored v2', async () => {
      const staleShape = await request(route, 'PUT', { document: { ...saved.document, schemaVersion: 1 }, expectedRevision: saved.revision }); assert.equal(staleShape.status, 409); assert.match(await staleShape.text(), /document_upgrade_required/);
      const downgrade = await request(route, 'PUT', { document: initial.document, expectedRevision: saved.revision }); assert.equal(downgrade.status, 409); assert.match(await downgrade.text(), /document_upgrade_required/);
      const future = await request(route, 'PUT', { document: initial.document, expectedRevision: saved.revision + 1 }); assert.equal(future.status, 409); assert.match(await future.text(), /revision_conflict/);
      const merge = await request(`/api/projects/${initial.id}/merge`, 'POST', { base: initial.document, document: initial.document, baseRevision: initial.revision }); assert.equal(merge.status, 409); assert.match(await merge.text(), /document_upgrade_required/);
    });
    await t.test('changed pixel hash and reused generation are rejected before a document write', async () => {
      const next = upgradeDocument(saved.document); next.paintings[0].generation++; delete next.paintings[0].composite; next.paintings[0].layers[0].tiles[0].hash = '0'.repeat(64);
      const bad = await request(route, 'PUT', { document: next, expectedRevision: saved.revision }); assert.equal(bad.status, 400); assert.match(await bad.text(), /paint_hash_mismatch/);
      next.paintings[0].generation--; next.paintings[0].layers[0].tiles[0].hash = await paintHash(png); next.paintings[0].layers[0].opacity = .5;
      const stale = await request(route, 'PUT', { document: next, expectedRevision: saved.revision }); assert.equal(stale.status, 409); assert.match(await stale.text(), /painting_generation_conflict/);
      assert.equal((await projectFrom(await request(`/api/projects/${initial.id}`))).revision, saved.revision);
    });
    await t.test('publication authorizes composite bytes but never tile source bytes', async () => {
      const publication = await request(`/api/projects/${initial.id}/publish`, 'POST', {}); assert.equal(publication.status, 200);
      const { url } = await publication.json() as { url: string }; const slug = url.split('/').pop()!;
      const snapshot = await db.prepare('SELECT document FROM publications WHERE slug=?').bind(slug).first<{ document: string }>(); assert.doesNotMatch(snapshot!.document, new RegExp(asset.id));
      assert.equal((await request(`/published/${slug}/assets/${asset.id}`)).status, 404);
      assert.equal((await request(`/published/${slug}/assets/${composite.assetId}`)).status, 200);
    });
    await t.test('publish preview and share exclude editable source checkpoints but preserve hidden toggle targets', async () => {
      const project = await projectFrom(await request('/api/projects', 'POST', { name: 'Editable model', kind: '3d' }), 201);
      const sourceBytes = triangleGlb(), uploadForm = new FormData();
      uploadForm.append('file', new Blob([sourceBytes], { type: 'model/gltf-binary' }), 'source.glb');
      const uploaded = await app.request(origin + `/api/projects/${project.id}/assets`, {
        method: 'POST', headers: { Origin: origin, Cookie: cookie }, body: uploadForm,
      }, env);
      assert.equal(uploaded.status, 201, await uploaded.clone().text());
      const source = (await uploaded.json() as { asset: AssetRef }).asset;
      const document = structuredClone(project.document);
      document.assets.push(source);
      document.pages[0].nodes = [
        { id: 'editable-model', name: 'Editable triangle', type: 'model3d', x: 0, y: 0, width: 100, height: 100,
          scene: { mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] } } },
        { id: 'source-checkpoint', name: 'Source checkpoint', type: 'model3d', x: 0, y: 0, width: 100, height: 100,
          visible: false, locked: true, src: source.url, data: { sceneSourceCheckpoint: true } },
        { id: 'checkpoint-child', name: 'Private descendant', type: 'model3d', parentId: 'source-checkpoint',
          x: 0, y: 0, width: 100, height: 100, src: source.url },
        { id: 'visible-checkpoint', name: 'Shown source checkpoint', type: 'model3d', x: 0, y: 0, width: 100, height: 100,
          visible: true, src: source.url, data: { sceneSourceCheckpoint: true } },
        { id: 'toggle-target', name: 'Hidden interactive panel', type: 'shape', visible: false, x: 0, y: 0, width: 100, height: 100 },
        { id: 'toggle-button', name: 'Show panel', type: 'shape', x: 0, y: 0, width: 100, height: 40,
          interactions: [{ trigger: 'click', action: 'toggle', target: 'toggle-target' }] },
      ];
      const saved = await projectFrom(await request(`/api/projects/${project.id}/document`, 'PUT', { document, expectedRevision: project.revision }));
      for (const action of ['publish', 'preview', 'share']) {
        const response = await request(`/api/projects/${project.id}/${action}`, 'POST', {});
        assert.equal(response.status, 200, await response.clone().text());
        const { url } = await response.json() as { url: string }, path = new URL(url).pathname, slug = path.split('/').pop()!;
        const row = await db.prepare('SELECT document FROM publications WHERE slug=?').bind(slug).first<{ document: string }>();
        const published = JSON.parse(row!.document) as Project['document'];
        assert(!published.pages[0].nodes.some(node => ['source-checkpoint', 'checkpoint-child', 'visible-checkpoint'].includes(node.id)), action);
        assert(!published.assets.some(asset => asset.id === source.id), action);
        assert(!row!.document.includes(source.id), `${action}: source reference must not appear in public JSON`);
        assert.equal(published.pages[0].nodes.find(node => node.id === 'toggle-target')?.visible, false);
        assert.deepEqual(published.pages[0].nodes.find(node => node.id === 'toggle-button')?.interactions,
          [{ trigger: 'click', action: 'toggle', target: 'toggle-target' }]);
        const registered = await db.prepare('SELECT asset_id FROM publication_assets WHERE slug=? AND asset_id=?').bind(slug, source.id).first();
        assert.equal(registered, null, `${action}: source bytes must not be registered publicly`);
        const anonymous = (suffix: string) => app.request(origin + path + suffix, {}, env);
        assert.equal((await anonymous(`/assets/${source.id}`)).status, 404, action);
        const html = await anonymous(''); assert.equal(html.status, 200, action);
        assert(!(await html.text()).includes(source.id), `${action}: public HTML must not embed the source reference`);
      }
      const owner = await projectFrom(await request(`/api/projects/${project.id}`));
      assert.equal(owner.revision, saved.revision);
      assert.deepEqual(owner.document, saved.document);
      const exported = await request(`/api/projects/${project.id}/export`, 'POST', { format: 'json' });
      assert.equal(exported.status, 200, await exported.clone().text());
      assert.deepEqual(await exported.json(), saved.document, 'Owner JSON export retains the checkpoint and source asset');
      const ownedBytes = await request(source.url); assert.equal(ownedBytes.status, 200);
      assert.deepEqual(new Uint8Array(await ownedBytes.arrayBuffer()), sourceBytes);
    });
    await t.test('aggregate painting budget rejects oversized saves before changing the project', async () => {
      const large = await projectFrom(await request('/api/projects', 'POST', { name: 'Huge paint batch', kind: 'web' }), 201);
      const next = upgradeDocument(large.document);
      for (let index = 0; index < 5; index++) next.paintings.push(paintingSchema.parse({
        id: `huge-paint-${index}`, name: `Huge ${index}`, width: 4096, height: 4096,
        generation: 0, colorSpace: 'srgb', algorithm: 'cpu-srgb-grain-v1', tileSize: 512,
        layers: [{ id: `huge-layer-${index}`, name: 'Empty', visible: true, locked: false, opacity: 1, blend: 'normal', tiles: [] }],
      }));
      const rejected = await request(`/api/projects/${large.id}/document`, 'PUT', { document: next, expectedRevision: large.revision, operationId: 'huge-batch' });
      assert.equal(rejected.status, 413); assert.match(await rejected.text(), /painting_work_budget_exceeded/);
      const current = await projectFrom(await request(`/api/projects/${large.id}`));
      assert.equal(current.revision, large.revision); assert.equal(current.document.schemaVersion, 1);
      const assets = await db.prepare('SELECT COUNT(*) AS count FROM assets WHERE project_id=?').bind(large.id).first<{ count: number }>();
      assert.equal(assets!.count, 0);
    });
    await t.test('concurrent uploads reserve project quota with the real database', async () => {
      const quota = await projectFrom(await request('/api/projects', 'POST', { name: 'Quota race', kind: 'web' }), 201);
      const user = await db.prepare('SELECT user_id FROM projects WHERE id=?').bind(quota.id).first<{ user_id: string }>();
      await db.prepare('INSERT INTO assets(id,user_id,project_id,name,mime_type,size,storage_key,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .bind('quota-prefill', user!.user_id, quota.id, 'prefill.png', 'image/png', PROJECT_ASSET_QUOTA - png.byteLength, `${user!.user_id}/${quota.id}/quota-prefill`, new Date().toISOString()).run();
      const upload = () => {
        const quotaForm = new FormData();
        quotaForm.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'quota-tile.png');
        return app.request(origin + `/api/projects/${quota.id}/assets`, { method: 'POST', headers: { Origin: origin, Cookie: cookie }, body: quotaForm }, env);
      };
      const responses = await Promise.all([upload(), upload()]);
      assert.deepEqual(responses.map(response => response.status).sort((a, b) => a - b), [201, 413]);
      const stored = await db.prepare('SELECT COUNT(*) AS count FROM assets WHERE project_id=?').bind(quota.id).first<{ count: number }>();
      assert.equal(stored!.count, 2);
      const reservations = await db.prepare('SELECT COUNT(*) AS count FROM asset_reservations WHERE project_id=?').bind(quota.id).first<{ count: number }>();
      assert.equal(reservations!.count, 0);
    });
    const reservations = await db.prepare('SELECT COUNT(*) AS count FROM asset_reservations').first<{ count: number }>(); assert.equal(reservations!.count, 0);
    const jobs = await db.prepare('SELECT COUNT(*) AS count FROM creative_work_leases').first<{ count: number }>(); assert.equal(jobs!.count, 0);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
