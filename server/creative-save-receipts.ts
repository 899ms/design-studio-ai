import type { Context } from 'hono';
import type { Env } from './types';
import type { DesignDocument, Project } from '../src/shared/schema';
import { paintHash } from '../src/shared/paint-png';
import { fail, owner } from './security';
import { decodeDocument } from './stored-documents';

export async function creativeSaveIdentity(document: DesignDocument, expectedRevision: number, operationId?: string, expectedBriefRevision?: number) {
  if (!operationId && (document.schemaVersion !== 2 || !document.paintings.length)) return undefined;
  const hash = await paintHash(new TextEncoder().encode(JSON.stringify({ document, expectedRevision, expectedBriefRevision })));
  return { key: operationId ?? hash, hash };
}
export async function readCreativeReceipt(c: Context<Env>, projectId: string, identity: { key: string; hash: string }) {
  const receipt = await c.env.DB.prepare('SELECT payload_hash,response FROM creative_save_receipts WHERE project_id=? AND user_id=? AND operation_id=?')
    .bind(projectId, owner(c), identity.key).first<{ payload_hash: string; response: string }>();
  if (!receipt) return undefined;
  if (receipt.payload_hash !== identity.hash) fail(409, 'operation_id_conflict', 'This operation ID already committed a different payload. Read its result before starting a new operation.');
  // receiptDetails holds caller data recorded at commit, such as a scene job's change summary.
  const project = JSON.parse(receipt.response) as Project & { receiptDetails?: Record<string, unknown>; storedDocument?: string; documentSuperseded?: true };
  if (project.storedDocument) {
    // A later save deletes the object its revision replaced, yet the operation did commit.
    const json = await decodeDocument(c.env, JSON.stringify({ storedDocument: project.storedDocument }));
    if (json !== undefined) project.document = JSON.parse(json);
    // Durable jobs need only the committed revision; a caller that consumes the document must re-read the project.
    else if (identity.key.startsWith('job-')) project.documentSuperseded = true;
    else fail(409, 'receipt_superseded', 'This operation committed, but a later save replaced its document. Read the project for the current state.');
    delete project.storedDocument;
  }
  return project;
}
