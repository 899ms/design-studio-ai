import { documentSchema, type DesignDocument } from './schema';
import { duplicateCreativeEmbeds } from './creative-duplication';

/** Duplicate a shot without copying its immutable media assets or breaking local rig references. */
export function duplicateSceneShot(input: DesignDocument, pageId: string, aspect: 'portrait' | 'square', nextId: () => ReturnType<Crypto['randomUUID']> = () => crypto.randomUUID()) {
  const document = structuredClone(input), index = document.pages.findIndex(page => page.id === pageId), original = document.pages[index];
  if (!original) throw new Error('Choose an existing scene page.');
  const copy = structuredClone(original), ids = new Map(original.nodes.map(node => [node.id, nextId()]));
  copy.id = nextId(); copy.name = `${original.name.slice(0, 180)} · ${aspect === 'portrait' ? '9:16' : '1:1'}`;
  copy.width = 1080; copy.height = aspect === 'portrait' ? 1920 : 1080;
  const dx = (copy.width - original.width) / 2, dy = (copy.height - original.height) / 2;
  for (const node of copy.nodes) {
    node.id = ids.get(node.id)!;
    if (node.parentId) node.parentId = ids.get(node.parentId);
    if (node.scene?.rigId) node.scene.rigId = ids.get(node.scene.rigId) ?? node.scene.rigId;
    if (typeof node.data?.rigSourceId === 'string') node.data.rigSourceId = ids.get(node.data.rigSourceId) ?? node.data.rigSourceId;
    // Scene fallback coordinates are relative to the page center, even under 3D parents.
    if (!node.parentId || node.type === 'model3d' || node.type === 'group') { node.x += dx; node.y += dy; }
    node.interactions = node.interactions?.map(action => ({ ...action, target: action.action === 'toggle' ? ids.get(action.target) ?? action.target : action.action === 'navigate' && action.target === original.id ? copy.id : action.target }));
  }
  duplicateCreativeEmbeds(document, copy.nodes, nextId);
  document.pages.splice(index + 1, 0, copy);
  if (document.timeline) document.timeline.tracks.push(...document.timeline.tracks.filter(track => ids.has(track.nodeId)).map(track => {
    const cloned = structuredClone(track), originalNode = original.nodes.find(node => node.id === track.nodeId)!;
    cloned.id = nextId(); cloned.nodeId = ids.get(track.nodeId)!;
    if (!originalNode.parentId || originalNode.type === 'model3d' || originalNode.type === 'group') for (const key of cloned.keyframes) {
      if (typeof key.values.x === 'number') key.values.x += dx;
      if (typeof key.values.y === 'number') key.values.y += dy;
    }
    return cloned;
  }));
  return { document: documentSchema.parse(document), pageId: copy.id, nodeIds: Object.fromEntries(ids) };
}
