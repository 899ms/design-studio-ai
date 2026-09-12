import { Vector3 } from 'three';
import type { MeshData } from './design-capabilities';
import type { SceneCommand } from './scene-authoring-schema';
import { boneWorld, quadruped } from './scene-rigging';

type Landmarks = Extract<SceneCommand, { action: 'rig-winged-quadruped' }>['landmarks'];
type Vector = [number, number, number];

/** Landmarks are mesh-local joint locations supplied by the author. */
export function wingedQuadruped(mesh: MeshData, landmarks: Landmarks) {
  const template = quadruped(mesh, landmarks);
  // The old quadruped's bounds-derived ears would use the entire wingspan.
  // A winged preset has no ear landmarks, so those optional joints are omitted.
  const kept = template.flatMap((bone, i) => bone.name.startsWith('ear') ? [] : [i]);
  const bones = kept.map(i => ({ ...template[i], parent: template[i].parent < 0 ? -1 : kept.indexOf(template[i].parent) }));
  const positions = boneWorld(bones, true).map(matrix => new Vector3().setFromMatrixPosition(matrix));
  const index = (name: string) => bones.findIndex(bone => bone.name === name);
  const add = (name: string, parent: number, point: Vector, min: Vector, max: Vector) => {
    const world = new Vector3(...point), local = world.clone().sub(positions[parent]);
    if (local.lengthSq() < 1e-10) throw new Error(`Landmark ${name} must differ from its parent joint`);
    bones.push({ name, parent, position: local.toArray(), bindRotation: [0, 0, 0], rotation: [0, 0, 0], rotationLimits: { min, max } });
    positions.push(world);
    return bones.length - 1;
  };
  const jaw = add('jaw', index('head'), landmarks.jaw, [0, -10, -10], [55, 10, 10]);
  add('jawTip', jaw, landmarks.jawTip, [0, 0, 0], [0, 0, 0]);
  for (const side of ['Left', 'Right'] as const) {
    const wing = landmarks[`wing${side}`];
    const shoulder = add(`wing${side}Shoulder`, index('chest'), wing.shoulder, [-60, -60, -85], [60, 60, 85]);
    const elbow = add(`wing${side}Elbow`, shoulder, wing.elbow, [-70, -80, -70], [70, 80, 70]);
    const wrist = add(`wing${side}Wrist`, elbow, wing.wrist, [-65, -65, -65], [65, 65, 65]);
    wing.fingers.forEach((finger, i) => {
      const base = add(`wing${side}Finger${i + 1}`, wrist, finger.base, [-45, -45, -45], [45, 45, 45]);
      add(`wing${side}Finger${i + 1}Tip`, base, finger.tip, [0, 0, 0], [0, 0, 0]);
    });
  }
  for (const bone of bones) {
    const opposite = bone.name.replace(/Left|Right/, side => side === 'Left' ? 'Right' : 'Left');
    if (opposite !== bone.name && index(opposite) >= 0) bone.mirrorBone = opposite;
    if (bone.name.startsWith('tail')) bone.rotationLimits = { min: [-45, -60, -60], max: [45, 60, 60] };
  }
  return bones;
}
