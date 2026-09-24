import type { Bindings } from './types';

/**
 * D1 caps a row at 2 MB, so a document above this size (dense sculpted meshes) is gzip-compressed into R2
 * and the row keeps a small pointer. The margin leaves room for the save receipt that echoes the project.
 */
export const INLINE_DOCUMENT_BYTES = 900_000;
const POINTER_PREFIX = '{"storedDocument":';

/** The R2 key a stored column value points at, or undefined for an inline document. */
export const storedDocumentKey = (value: string) => value.startsWith(POINTER_PREFIX) ? (JSON.parse(value) as { storedDocument: string }).storedDocument : undefined;

/** Returns the value to write into a document column: the JSON itself when it fits, otherwise a pointer to a new R2 object. */
export async function encodeDocument(env: Pick<Bindings, 'ASSETS_BUCKET'>, projectId: string, json: string) {
  // UTF-8 uses at most three bytes per UTF-16 unit, so short strings skip the byte count.
  if (json.length * 3 <= INLINE_DOCUMENT_BYTES || new TextEncoder().encode(json).length <= INLINE_DOCUMENT_BYTES) return json;
  const key = `documents/${projectId}/${crypto.randomUUID()}`;
  const compressed = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  await env.ASSETS_BUCKET.put(key, compressed, { httpMetadata: { contentType: 'application/gzip' } });
  return JSON.stringify({ storedDocument: key });
}

/** Resolves a document column value to its JSON; undefined when the pointed-at object no longer exists. */
export async function decodeDocument(env: Pick<Bindings, 'ASSETS_BUCKET'>, value: string) {
  const key = storedDocumentKey(value);
  if (!key) return value;
  const object = await env.ASSETS_BUCKET.get(key);
  return object ? new Response(object.body.pipeThrough(new DecompressionStream('gzip'))).text() : undefined;
}

/** Deletes the R2 object behind a column value, if any; inline values need no cleanup. */
export async function discardDocument(env: Pick<Bindings, 'ASSETS_BUCKET'>, value: string | undefined) {
  const key = value && storedDocumentKey(value);
  if (key) await env.ASSETS_BUCKET.delete(key);
}
