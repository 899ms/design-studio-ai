import { z } from 'zod';
import type { DesignDocument } from './schema';
import type { inspectScene } from './scene-inspection';

/** summary omits the full document or mesh diagnostics so large 3D edits fit in agent tool responses. */
/** Optional so existing callers and published input schemas keep their required fields; omitted means full. */
export const responseModeSchema = z.enum(['full', 'summary']).optional();
export type ResponseMode = z.infer<typeof responseModeSchema>;

/** Page and node IDs whose serialized content differs, including additions and removals. */
export function documentChanges(before: DesignDocument, after: DesignDocument) {
  const pageIds = new Set<string>(), nodeIds = new Set<string>();
  const pages = (doc: DesignDocument) => new Map(doc.pages.map(page => [page.id, page]));
  const previous = pages(before), next = pages(after);
  for (const id of new Set([...previous.keys(), ...next.keys()])) {
    const a = previous.get(id), b = next.get(id);
    const nodesA = new Map(a?.nodes.map(node => [node.id, JSON.stringify(node)]) ?? []), nodesB = new Map(b?.nodes.map(node => [node.id, JSON.stringify(node)]) ?? []);
    for (const nodeId of new Set([...nodesA.keys(), ...nodesB.keys()])) if (nodesA.get(nodeId) !== nodesB.get(nodeId)) { nodeIds.add(nodeId); pageIds.add(id); }
    const { nodes: _a, ...pageA } = a ?? { nodes: [] }, { nodes: _b, ...pageB } = b ?? { nodes: [] };
    if (!a || !b || JSON.stringify(pageA) !== JSON.stringify(pageB)) pageIds.add(id);
  }
  // Every save stamps metadata.updatedAt, so metadata is not a settings change.
  const { pages: _p, metadata: _m, ...restA } = before, { pages: _q, metadata: _n, ...restB } = after;
  return { changedPageIds: [...pageIds], changedNodeIds: [...nodeIds], documentSettingsChanged: JSON.stringify(restA) !== JSON.stringify(restB) };
}

/** Project metadata without the document body. */
export function projectSummary<P extends { document: unknown }>(project: P) {
  const { document: _document, ...summary } = project;
  return summary;
}

/** Scene report reduced to counts, bounds and issue text; bone positions and diagnostics are dropped. */
export function summarizeScene(report: ReturnType<typeof inspectScene>, doc: DesignDocument) {
  return {
    time: report.time,
    pages: report.pages.map(page => {
      const scene = doc.pages.find(p => p.id === page.id)?.scene;
      return {
        id: page.id,
        scene: scene && { cameraKeys: scene.camera.keys?.length ?? 0, emitters: scene.emitters?.map(e => e.id) ?? [], lights: scene.lights?.length ?? 0, rendering: Object.keys(scene.rendering ?? {}), atmosphere: !!scene.atmosphere },
        nodes: page.nodes.map(node => 'vertices' in node
          ? { id: node.id, name: node.name, editableMesh: true, vertices: node.vertices, triangles: node.triangles, bones: node.bones?.length ?? 0, skinned: node.skinned, morphTargets: node.morphTargets?.length ?? 0, bounds: node.bounds, poseBounds: node.poseBounds, maxEdgeStretch: node.maxEdgeStretch, issues: node.issues }
          : node),
      };
    }),
  };
}
