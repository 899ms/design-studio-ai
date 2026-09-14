import type { Bindings } from './types';
import type { DesignDocument } from '../src/shared/schema';
import { renderSnapshotExport, type SnapshotAssetResolver } from './exports';
import { exportOptionsSchema } from '../src/shared/export-contract';

/** Internal Community worker entry. Authorization and admission happen before rendering. */
export async function renderCommunitySnapshot(env: Bindings, document: DesignDocument, input: unknown, assetResolver: SnapshotAssetResolver, thumbnail = false, cover?:{pageIndex:number;time?:number;focalX:number;focalY:number}) {
  const selection=cover?{...cover,time:cover.time??0}:undefined;
  const options=exportOptionsSchema.parse(input);
  // Owned media becomes embedded bytes only inside the produced artifact. The canonical document is
  // validated first, because a portable JSON download may legitimately exceed the stored string limits.
  const response = await renderSnapshotExport(env, document.name, document, options, assetResolver, {thumbnail,thumbnailSelection:selection,jsonAssetsAsDataUrls:options.format==='json'});
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: response.headers.get('Content-Type') ?? 'application/octet-stream',
    filename: /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'design',
  };
}
