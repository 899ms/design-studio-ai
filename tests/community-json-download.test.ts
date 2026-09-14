import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { z } from 'zod';
import { app } from '../server/index';
import { communityFailureMessage, processCommunityJob } from '../server/community-worker';
import { renderCommunitySnapshot } from '../server/snapshot-export';
import { SqliteDatabase, FileBucket } from '../server/node-adapters';
import { ApiError, secret } from '../server/security';
import { createDocument } from '../src/shared/catalog';
import { PORTABLE_JSON_MEDIA_BUDGET, RENDER_MEDIA_BUDGET } from '../src/shared/export-contract';
import { encodePaintPng } from '../src/shared/paint-png';
import { documentSchema } from '../src/shared/schema';
import { builtStaticAssets } from './built-static-assets';
import type { Bindings } from '../server/types';

/** The production asset that failed job 9cfc8710 was a 2,887,058-byte PNG. */
const PRODUCTION_ASSET_BYTES = 2887058;
const JSON_MEDIA_BUDGET = PORTABLE_JSON_MEDIA_BUDGET;

function portableDocument(size: number) {
  const document = createDocument('slides', 'Portable JSON');
  document.pages[0].nodes.push({ id: 'photo-node', type: 'image', name: 'Photo', x: 0, y: 0, width: 640, height: 480, src: '/api/assets/photo-asset' });
  document.assets.push({ id: 'photo-asset', name: 'Photo', type: 'image', mimeType: 'image/png', url: '/api/assets/photo-asset', size });
  return documentSchema.parse(document);
}

/** Deterministic noise keeps the fixture genuinely uncompressible, like the production photo. */
async function largePng(size = 800) {
  const pixels = new Uint8Array(size * size * 4);
  let state = 0x2f6e2b1;
  for (let index = 0; index < pixels.length; index++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; pixels[index] = state & 255; }
  const png = await encodePaintPng(size, size, pixels);
  assert.ok(png.byteLength > 1.5 * 1024 * 1024, `The fixture must exceed the 2,000,000-character data URL limit, got ${png.byteLength} bytes`);
  return png;
}

/** A real signed-in app instance backed by SQLite and file storage, like the Community worker sees. */
async function harness(name: string) {
  const directory = await mkdtemp(join(tmpdir(), `${name}-`)), db = new SqliteDatabase(':memory:'), origin = `https://${name}.test`;
  const env: Bindings = { DB: db, ASSETS_BUCKET: new FileBucket(join(directory, 'assets')), ASSETS: builtStaticAssets, APP_URL: origin, ENCRYPTION_KEY: secret(), ALLOW_REGISTRATION: 'true', COMMUNITY_ENABLED: 'true', EXPORT_BROWSER: () => chromium.launch({ headless: true }) };
  const request = (path: string, method = 'GET', body?: unknown, auth = '') => app.request(origin + path, { method, headers: { Origin: origin, Cookie: auth, ...(body instanceof FormData || body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) }, env);
  const json = async (response: Response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response.json() as Promise<any>; };
  for (const file of (await readdir('migrations')).filter(entry => entry.endsWith('.sql')).sort()) await db.exec(await readFile('migrations/' + file, 'utf8'));
  const registration = await request('/api/auth/register', 'POST', { email: `author@${name}.test`, password: secret() });
  assert.equal(registration.status, 201);
  const registered = await registration.json() as { user: { id: string } };
  const cookie = registration.headers.get('set-cookie')!.split(';')[0];
  await json(await request('/api/community/me/profile', 'PUT', { handle: `${name}-creator`, displayName: 'Fixture Creator', expectedProfileRevision: 0 }, cookie));
  return { env, request, json, registered, cookie, close: async () => { db.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('the Community JSON download embeds media above the stored-document string limit', async () => {
  const document = portableDocument(PRODUCTION_ASSET_BYTES);
  const artifact = await renderCommunitySnapshot({} as Bindings, document, { format: 'json', pageIndex: 0 }, async () => ({ bytes: new Uint8Array(PRODUCTION_ASSET_BYTES), mimeType: 'image/png' }));
  const portable = JSON.parse(new TextDecoder().decode(artifact.bytes)) as typeof document;
  const inline = portable.assets[0].url;
  assert.ok(inline.startsWith('data:image/png;base64,'), 'The portable JSON download embeds owned media');
  assert.ok(inline.length > 2000000, `Embedded media exceeds the stored-document limit, got ${inline.length} characters`);
  assert.equal(portable.pages[0].nodes.at(-1)!.src, inline, 'Node media resolves to the same embedded bytes');
  assert.equal(document.assets[0].url, '/api/assets/photo-asset', 'The caller document is not mutated');
});

test('the Community JSON download refuses media above its portable budget', async () => {
  const document = portableDocument(JSON_MEDIA_BUDGET + 1);
  await assert.rejects(
    renderCommunitySnapshot({} as Bindings, document, { format: 'json', pageIndex: 0 }, async () => ({ bytes: new Uint8Array(JSON_MEDIA_BUDGET + 1), mimeType: 'image/png' })),
    (error: unknown) => error instanceof ApiError && error.status === 413 && error.code === 'export_too_large',
    'Oversized portable JSON media returns an actionable export error instead of a validation dump',
  );
});

test('the Community JSON download inlines node media without a registry entry', async () => {
  const document = portableDocument(0);
  document.pages[0].nodes.push({ id: 'stray-node', type: 'image', name: 'Stray', x: 0, y: 0, width: 10, height: 10, src: '/api/assets/unregistered-media' });
  const artifact = await renderCommunitySnapshot({} as Bindings, document, { format: 'json', pageIndex: 0 }, async () => ({ bytes: new Uint8Array(16), mimeType: 'image/png' }));
  const portable = JSON.parse(new TextDecoder().decode(artifact.bytes)) as typeof document;
  assert.ok(portable.pages[0].nodes.at(-1)!.src!.startsWith('data:image/png;base64,'), 'Direct node media is embedded even without a registry entry');
});

test('the Community JSON budget accumulates across media and honors its boundary', async () => {
  const half = JSON_MEDIA_BUDGET / 2, document = portableDocument(half);
  document.assets.push({ id: 'second-asset', name: 'Second', type: 'image/png', mimeType: 'image/png', url: '/api/assets/second-asset', size: half });
  const artifact = await renderCommunitySnapshot({} as Bindings, document, { format: 'json', pageIndex: 0 }, async () => ({ bytes: new Uint8Array(half), mimeType: 'image/png' }));
  const portable = JSON.parse(new TextDecoder().decode(artifact.bytes)) as typeof document;
  assert.equal(portable.assets.length, 2);
  assert.ok(portable.assets.every(asset => asset.url.startsWith('data:image/png;base64,')), 'Exactly the budget still embeds every asset');
  document.assets.push({ id: 'third-asset', name: 'Third', type: 'image/png', mimeType: 'image/png', url: '/api/assets/third-asset', size: 1 });
  await assert.rejects(
    renderCommunitySnapshot({} as Bindings, document, { format: 'json', pageIndex: 0 }, async url => ({ bytes: new Uint8Array(url.endsWith('third-asset') ? 1 : half), mimeType: 'image/png' })),
    (error: unknown) => error instanceof ApiError && error.status === 413 && error.code === 'export_too_large',
    'One byte past the cumulative budget is refused',
  );
});

test('the render media budget refuses oversized embedded media before rendering', async () => {
  const document = portableDocument(RENDER_MEDIA_BUDGET + 1);
  await assert.rejects(
    renderCommunitySnapshot({} as Bindings, document, { format: 'png', pageIndex: 0 }, async () => ({ bytes: new Uint8Array(RENDER_MEDIA_BUDGET + 1), mimeType: 'image/png' })),
    (error: unknown) => error instanceof ApiError && error.status === 413 && error.code === 'export_too_large',
    'Every rendered format embeds media within the shared render budget',
  );
});

test('a final validation failure reports an actionable Community job message', () => {
  const parsed = z.object({ assets: z.array(z.object({ url: z.string().max(2) })) }).safeParse({ assets: [{ url: 'abcd' }] });
  assert.equal(parsed.success, false);
  const message = communityFailureMessage(parsed.error);
  assert.equal(message, 'The public design failed final validation (assets.0.url): Too big: expected string to have <=2 characters.');
  assert.ok(!message.includes('origin'), 'The raw issue dump never reaches the dialog');
  const two = z.object({ assets: z.array(z.object({ url: z.string().max(2) })), pages: z.array(z.string().max(2)) }).safeParse({ assets: [{ url: 'abcd' }], pages: ['abcd'] });
  assert.equal(two.success, false);
  assert.equal(communityFailureMessage(two.error), 'The public design failed final validation (assets.0.url): Too big: expected string to have <=2 characters and 1 more issue.');
  assert.equal(communityFailureMessage(new z.ZodError([])), 'The public design failed final validation.');
  assert.equal(communityFailureMessage(new ApiError(413, 'export_too_large', 'Media exceeds the budget.')), 'Media exceeds the budget.');
  assert.equal(communityFailureMessage(new Error('Renderer unavailable.')), 'Renderer unavailable.');
});

test('preflight reports the portable JSON media budget before a build starts', { timeout: 120000 }, async () => {
  const instance = await harness('community-json-budget');
  try {
    const { request, json, registered, cookie } = instance;
    const project = (await json(await request('/api/projects', 'POST', { name: 'Budget design', kind: 'slides', document: createDocument('slides', 'Budget design') }, cookie), 201)).project;
    const document = project.document as ReturnType<typeof createDocument>;
    await instance.env.DB.prepare('INSERT INTO assets(id,user_id,project_id,name,mime_type,size,storage_key,created_at) VALUES(?,?,?,?,?,?,?,?)').bind('oversized-asset', registered.user.id, project.id, 'Oversized media', 'image/png', JSON_MEDIA_BUDGET + 1, 'test-only-oversized', new Date().toISOString()).run();
    document.pages[0].nodes.push({ id: 'oversized-node', type: 'image', name: 'Oversized', x: 0, y: 0, width: 640, height: 480, src: '/api/assets/oversized-asset' });
    const saved = (await json(await request(`/api/projects/${project.id}/document`, 'PUT', { document, expectedRevision: project.revision }, cookie))).project;
    const metadata = { projectId: project.id, expectedProjectRevision: saved.revision, title: 'Budget design', description: 'Portable JSON budget', tags: ['budget'], cover: { pageIndex: 0, time: 0, focalX: .5, focalY: .5 } };
    const jsonPreflight = (await json(await request('/api/community/preflight', 'POST', { ...metadata, formats: [{ format: 'json', pageIndex: 0 }] }, cookie))).preflight;
    assert.deepEqual(jsonPreflight.issues.map((issue: { code: string }) => issue.code), ['json_media_budget']);
    assert.match(jsonPreflight.issues[0].message, /Studio project package/);
    const blocked = await json(await request('/api/community/listings', 'POST', { ...metadata, formats: [{ format: 'json', pageIndex: 0 }], operationId: 'blocked-json-publish', digest: jsonPreflight.digest, license: 'CC-BY-4.0', acceptLicense: true, confirmPublic: true }, cookie), 413);
    assert.equal(blocked.error.code, 'json_media_budget', 'A preflight issue blocks the build for API clients too, not only the dialog');
    const htmlPreflight = (await json(await request('/api/community/preflight', 'POST', { ...metadata, formats: [{ format: 'html', pageIndex: 0 }] }, cookie))).preflight;
    assert.ok(!htmlPreflight.issues.some((issue: { code: string }) => issue.code === 'json_media_budget'), 'Other downloads keep the media budget they can honor');
    await instance.env.DB.prepare('UPDATE assets SET size=? WHERE id=?').bind(RENDER_MEDIA_BUDGET + 1, 'oversized-asset').run();
    const renderPreflight = (await json(await request('/api/community/preflight', 'POST', { ...metadata, formats: [{ format: 'html', pageIndex: 0 }] }, cookie))).preflight;
    assert.deepEqual(renderPreflight.issues.map((issue: { code: string }) => issue.code), ['render_media_budget'], 'Media the cover cannot embed is refused for every format');
  } finally { await instance.close(); }
});

test('a design with large media publishes and serves the embedded JSON download', { timeout: 180000 }, async () => {
  const instance = await harness('community-json-publish');
  try {
    const { env, request, json, cookie } = instance;
    const png = await largePng();
    let project = (await json(await request('/api/projects', 'POST', { name: 'Large media deck', kind: 'slides', document: createDocument('slides', 'Large media deck') }, cookie), 201)).project;
    const upload = new FormData();
    upload.set('file', new File([new Uint8Array(png)], 'large-photo.png', { type: 'image/png' }));
    const asset = (await json(await request(`/api/projects/${project.id}/assets`, 'POST', upload, cookie), 201)).asset;
    const document = project.document as ReturnType<typeof createDocument>;
    document.assets.push(asset);
    document.pages[0].nodes.push({ id: 'large-photo', type: 'image', name: 'Large photo', x: 20, y: 20, width: 320, height: 320, src: asset.url });
    project = (await json(await request(`/api/projects/${project.id}/document`, 'PUT', { document, expectedRevision: project.revision }, cookie))).project;
    const metadata = { projectId: project.id, expectedProjectRevision: project.revision, title: 'Large media deck', description: 'A deck whose photo exceeds the stored string limit', tags: ['slides'], formats: [{ format: 'json', pageIndex: 0 }], cover: { pageIndex: 0, time: 0, focalX: .5, focalY: .5 } };
    const preflight = (await json(await request('/api/community/preflight', 'POST', metadata, cookie))).preflight;
    assert.deepEqual(preflight.issues, [], 'Media below the portable budget preflights cleanly');
    const accepted = (await json(await request('/api/community/listings', 'POST', { ...metadata, operationId: 'publish-large-json', digest: preflight.digest, license: 'CC-BY-4.0', acceptLicense: true, confirmPublic: true }, cookie), 202)).job;
    await processCommunityJob(env, accepted.id);
    const receipt = (await json(await request('/api/community/jobs/publish-large-json', 'GET', undefined, cookie))).job;
    assert.equal(receipt.status, 'succeeded', JSON.stringify(receipt.error));
    const listing = (await json(await request(`/api/community/listings/${receipt.listingId}`, 'GET', undefined, ''))).listing;
    const file = listing.files.find((entry: { format: string }) => entry.format === 'json');
    const download = await request(file.url, 'GET', undefined, '');
    assert.equal(download.status, 200);
    const portable = JSON.parse(await download.text()) as { assets: { url: string }[]; pages: { nodes: { id: string; src?: string }[] }[] };
    const inline = portable.assets[0].url;
    assert.ok(inline.startsWith('data:image/png;base64,'), 'The downloaded JSON is self-contained');
    assert.ok(inline.length > 2000000, `The downloaded JSON carries the large media, got ${inline.length} characters`);
    assert.equal(portable.pages[0].nodes.find(node => node.id === 'large-photo')!.src, inline, 'The node resolves to the embedded bytes a downloader can read');
  } finally { await instance.close(); }
});
