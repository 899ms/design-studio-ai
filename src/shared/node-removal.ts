import type { DesignDocument, DesignPage } from './schema';

/** Remove a node with its descendants and hidden mesh checkpoints, plus the tracks and toggles that point at them. */
export function removeNodeTree(doc: DesignDocument, page: DesignPage, nodeId: string) {
  if (!page.nodes.some(n => n.id === nodeId)) throw new Error('Unknown node');
  const removed = new Set([nodeId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of page.nodes) if (!removed.has(node.id) && ((node.parentId && removed.has(node.parentId)) || removed.has(String(node.data?.checkpointOf ?? '')))) { removed.add(node.id); grew = true; }
  }
  // A mesh that still shares a removed skeleton would lose its bones, so it has to go first.
  const dependent = page.nodes.find(n => !removed.has(n.id) && (removed.has(n.scene?.rigId ?? '') || removed.has(String(n.data?.rigSourceId ?? ''))));
  if (dependent) throw new Error(`Remove ${dependent.id} first; it uses this rig`);
  page.nodes = page.nodes.filter(n => !removed.has(n.id));
  if (doc.timeline) doc.timeline.tracks = doc.timeline.tracks.filter(t => !removed.has(t.nodeId));
  for (const node of doc.pages.flatMap(p => p.nodes)) if (node.interactions?.some(i => i.action === 'toggle' && removed.has(i.target))) {
    const kept = node.interactions.filter(i => !(i.action === 'toggle' && removed.has(i.target)));
    if (kept.length) node.interactions = kept; else delete node.interactions;
  }
}
