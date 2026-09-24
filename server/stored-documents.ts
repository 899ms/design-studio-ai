import type { Bindings } from './types';
import { fail } from './security';

/**
 * D1 caps a row at 2 MB, so a document above this size (dense sculpted meshes) is gzip-compressed into R2
 * and the row keeps a small pointer. The margin leaves room for the save receipt that echoes the project.
 */
export const INLINE_DOCUMENT_BYTES = 900_000;
/** Tables that still embed a document inline (publications, Community snapshots) stay under D1's row cap. */
const ROW_BYTES = 1_900_000;
const POINTER_PREFIX = '{"storedDocument":';
type Storage = Pick<Bindings, 'ASSETS_BUCKET'>;

/** The R2 key a stored column value points at, or undefined for an inline document. */
export const storedDocumentKey = (value: string) => value.startsWith(POINTER_PREFIX) ? (JSON.parse(value) as { storedDocument: string }).storedDocument : undefined;

// UTF-8 uses at most three bytes per UTF-16 unit, so short strings skip the byte count.
const fits = (json: string, limit: number, blob?: Blob) => json.length * 3 <= limit || (blob ?? new Blob([json])).size <= limit;

/** Returns the value to write into a document column: the JSON itself when it fits, otherwise a pointer to a new R2 object. */
export async function encodeDocument(env: Storage, projectId: string, json: string) {
  if (json.length * 3 <= INLINE_DOCUMENT_BYTES) return json;
  const blob = new Blob([json]);
  if (fits(json, INLINE_DOCUMENT_BYTES, blob)) return json;
  const key = `documents/${projectId}/${crypto.randomUUID()}`;
  const compressed = await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  await env.ASSETS_BUCKET.put(key, compressed, { httpMetadata: { contentType: 'application/gzip' } });
  return JSON.stringify({ storedDocument: key });
}

/** Resolves a document column value to its JSON; undefined when the pointed-at object no longer exists. */
export async function decodeDocument(env: Storage, value: string) {
  const key = storedDocumentKey(value);
  if (!key) return value;
  const object = await env.ASSETS_BUCKET.get(key);
  return object ? new Response(object.body.pipeThrough(new DecompressionStream('gzip'))).text() : undefined;
}

/** Like decodeDocument, but a missing object is a server fault rather than a malformed document. */
export async function loadDocument(env: Storage, value: string) {
  const json = await decodeDocument(env, value);
  if (json === undefined) fail(500, 'document_unavailable', 'The stored project document could not be read.');
  return json!;
}

/** Deletes the R2 object behind a column value, if any. Cleanup is best-effort: a failed delete only leaves an orphan. */
export async function discardDocument(env: Storage, value: string | undefined) {
  const key = value && storedDocumentKey(value);
  if (!key) return;
  try { await env.ASSETS_BUCKET.delete(key); } catch (error) { console.warn('Stored document cleanup failed', key, error); }
}

/**
 * After a write threw, D1 may still have committed it, so the object is discarded only when the row provably
 * does not reference it; if the row cannot be read the object is kept. Returns whether the write provably committed.
 */
export async function discardUnlessReferenced(env: Storage & Pick<Bindings, 'DB'>, projectId: string, value: string) {
  try {
    const row = await env.DB.prepare('SELECT document FROM projects WHERE id=?').bind(projectId).first<{ document: string }>();
    if (row?.document === value) return true;
    await discardDocument(env, value);
  } catch { /* keep the object: a leaked object is recoverable, a deleted committed one is not */ }
  return false;
}

/** Rejects a document that must be embedded in a D1 row but would exceed its size cap. */
export function assertEmbeddable(json: string, action: string) {
  if (!fits(json, ROW_BYTES)) fail(413, 'document_too_large', `This project is too large to ${action}; its document exceeds 2 MB. Reduce mesh detail and try again.`);
}
