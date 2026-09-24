import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from '../server/index';
import { processOperation } from '../server/operation-worker';
import { FileBucket, SqliteDatabase } from '../server/node-adapters';
import { secret } from '../server/security';
import { INLINE_DOCUMENT_BYTES } from '../server/stored-documents';
import type { Bindings } from '../server/types';
import { createDocument } from '../src/shared/catalog';
import type { DesignDocument, Project } from '../src/shared/schema';

/** A dense sculpted mesh whose JSON alone exceeds D1's 2 MB row limit. */
function denseDocument(name: string, seed: number) {
  const doc = createDocument('3d', name), triangles = 40000, positions: number[] = [];
  for (let i = 0; i < triangles * 9; i++) positions.push(Math.round(Math.sin(i * 12.9898 + seed) * 43758.5453 % 1 * 1e5) / 1e5 || 0);
  doc.pages[0].nodes = [{ id: 'dense', name: 'Dense mesh', type: 'model3d', x: 0, y: 0, width: 400, height: 400, data: {}, scene: { position: [0, 0, 0], scale: [1, 1, 1], mesh: { positions, indices: positions.map((_, i) => i).slice(0, triangles * 3) } } }];
  return doc;
}

test('documents above the inline limit are stored compressed outside the database row and cleaned up', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-large-document-'));
  const db = new SqliteDatabase(join(directory, 'studio.sqlite'));
  const origin = 'https://studio.example';
  const env: Bindings = { DB: db, ASSETS_BUCKET: new FileBucket(join(directory, 'assets')), APP_URL: origin, ENCRYPTION_KEY: secret(), ALLOW_REGISTRATION: 'true' };
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  let cookie = '';
  const request = (path: string, method = 'GET', body?: unknown) => app.request(origin + path, {
    method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  const projectFrom = async (response: Response, status = 200) => {
    assert.equal(response.status, status, await response.clone().text());
    return ((await response.json()) as { project: Project }).project;
  };
  for (const file of (await readdir(new URL('../migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  const registered = await request('/api/auth/register', 'POST', { email: 'large@example.com', password: secret() });
  assert.equal(registered.status, 201, await registered.clone().text());
  cookie = registered.headers.get('set-cookie')!.split(';')[0];
  const storedObjects = async () => (await readdir(join(directory, 'assets', 'documents'), { recursive: true }).catch(() => [] as string[])).filter(name => /^[\w-]+[\\/][\w-]+$/.test(name));
  const column = (id: string) => db.prepare('SELECT document FROM projects WHERE id=?').bind(id).first<{ document: string }>().then(row => row!.document);

  const first = denseDocument('Dense', 1);
  assert.ok(JSON.stringify(first).length > 2_000_000);
  const created = await projectFrom(await request('/api/projects', 'POST', { name: 'Dense', kind: '3d', document: first }), 201);
  assert.ok((await column(created.id)).length < 200, 'the row keeps only a pointer');
  assert.equal((await storedObjects()).length, 1);
  assert.deepEqual((created.document.pages[0].nodes[0].scene as { mesh: { positions: number[] } }).mesh.positions, (first.pages[0].nodes[0].scene as { mesh: { positions: number[] } }).mesh.positions);

  // A save replaces the stored object; a stale save leaves the committed one in place.
  const second = { ...denseDocument('Dense', 2), id: created.id } as DesignDocument;
  const saved = await projectFrom(await request(`/api/projects/${created.id}/document`, 'PUT', { document: second, expectedRevision: created.revision }));
  assert.equal(saved.revision, created.revision + 1);
  assert.equal((await storedObjects()).length, 1);
  assert.equal((await request(`/api/projects/${created.id}/document`, 'PUT', { document: second, expectedRevision: created.revision })).status, 409);
  assert.equal((await storedObjects()).length, 1);
  const read = await projectFrom(await request(`/api/projects/${created.id}`));
  assert.deepEqual((read.document.pages[0].nodes[0].scene as { mesh: { positions: number[] } }).mesh.positions, (second.pages[0].nodes[0].scene as { mesh: { positions: number[] } }).mesh.positions);

  // Renaming rewrites the document; shrinking it back under the limit returns it inline.
  const renamed = await projectFrom(await request(`/api/projects/${created.id}`, 'PATCH', { name: 'Dense renamed' }));
  assert.equal(renamed.document.name, 'Dense renamed');
  assert.equal((await storedObjects()).length, 1);
  const small = { ...renamed.document, pages: renamed.document.pages.map(page => ({ ...page, nodes: [] })) };
  assert.ok(JSON.stringify(small).length < INLINE_DOCUMENT_BYTES);
  await projectFrom(await request(`/api/projects/${created.id}/document`, 'PUT', { document: small, expectedRevision: renamed.revision }));
  assert.equal(JSON.parse(await column(created.id)).id, created.id, 'a small document is stored inline again');
  assert.equal((await storedObjects()).length, 0);

  // A later save replaces the object a receipt shares, so replaying it asks the caller to re-read the project.
  const replayed = { ...denseDocument('Dense', 4), id: created.id } as DesignDocument;
  const current = await projectFrom(await request(`/api/projects/${created.id}`));
  const committed = await projectFrom(await request(`/api/projects/${created.id}/document`, 'PUT', { document: replayed, expectedRevision: current.revision, operationId: 'dense-op' }));
  const replay = async () => projectFrom(await request(`/api/projects/${created.id}/document`, 'PUT', { document: replayed, expectedRevision: current.revision, operationId: 'dense-op' }));
  assert.equal((await replay()).document.name, 'Dense');
  await projectFrom(await request(`/api/projects/${created.id}/document`, 'PUT', { document: { ...second, name: 'Dense later' }, expectedRevision: committed.revision }));
  const superseded = await request(`/api/projects/${created.id}/document`, 'PUT', { document: replayed, expectedRevision: current.revision, operationId: 'dense-op' });
  assert.equal(superseded.status, 409);
  assert.match(await superseded.text(), /receipt_superseded/);

  // A durable export pins the loaded document, not the pointer, so later saves cannot change or break it.
  const pinned = await projectFrom(await request(`/api/projects/${created.id}`));
  const queued = await request(`/api/projects/${created.id}/operations`, 'POST', { kind: 'export', operationId: 'dense-export', input: { format: 'json', expectedRevision: pinned.revision } });
  assert.equal(queued.status, 202, await queued.text());
  const job = (await db.prepare('SELECT id FROM operation_jobs WHERE operation_id=?').bind('dense-export').first<{ id: string }>())!;
  await projectFrom(await request(`/api/projects/${created.id}/document`, 'PUT', { document: { ...second, name: 'Dense after export' }, expectedRevision: pinned.revision }));
  await processOperation(env, job.id);
  const exported = await request(`/api/projects/${created.id}/operations/dense-export/result`);
  assert.equal(exported.status, 200, await exported.clone().text());
  assert.equal(((await exported.json()) as DesignDocument).name, 'Dense later');

  // Publishing embeds the document in a D1 row, so an oversized one is refused plainly.
  const published = await request(`/api/projects/${created.id}/publish`, 'POST', {});
  assert.equal(published.status, 413, await published.clone().text());

  // When D1 reports a failure after committing, the object the row now references survives.
  const latest = await projectFrom(await request(`/api/projects/${created.id}`));
  const flaky: Bindings = { ...env, DB: { prepare: sql => db.prepare(sql), exec: sql => db.exec(sql), batch: async statements => { await db.batch(statements); throw new Error('Network connection lost'); } } };
  const ambiguous = await app.request(`${origin}/api/projects/${created.id}/document`, { method: 'PUT', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ document: { ...second, name: 'Dense ambiguous' }, expectedRevision: latest.revision }) }, flaky);
  assert.equal(ambiguous.status, 500);
  assert.equal((await projectFrom(await request(`/api/projects/${created.id}`))).document.name, 'Dense ambiguous');
  await projectFrom(await request(`/api/projects/${created.id}/document`, 'PUT', { document: small, expectedRevision: latest.revision + 1 }));
  assert.equal((await storedObjects()).length, 0);

  // Deleting a project removes its stored document.
  const other = await projectFrom(await request('/api/projects', 'POST', { name: 'Dense two', kind: '3d', document: denseDocument('Dense two', 3) }), 201);
  assert.equal((await storedObjects()).length, 1);
  assert.equal((await request(`/api/projects/${other.id}`, 'DELETE')).status, 200);
  assert.equal((await storedObjects()).length, 0);
});
