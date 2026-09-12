import * as T from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { registerImportedScene, animateImportedScene, disposeImportedScene } from './scene-import';
import { uid, type DesignDocument, type DesignNode, type AssetRef } from './schema';
import type { MeshData } from './design-capabilities';

function transform(matrix: T.Matrix4) {
  const p = new T.Vector3(),
    q = new T.Quaternion(),
    s = new T.Vector3();
  matrix.decompose(p, q, s);
  const e = new T.Euler().setFromQuaternion(q);
  return {
    position: p.toArray(),
    rotation: [e.x, e.y, e.z].map((v) => (v * 180) / Math.PI) as [number, number, number],
    scale: s.toArray(),
  };
}
function boneData(mesh: T.SkinnedMesh) {
  const bones = mesh.skeleton.bones;
  if (bones.length > 256)
    throw new Error('Editable import supports at most 256 joints per skin. Keep this model as a source asset.');
  const rest = mesh.skeleton.boneInverses.map((m) => m.clone().invert());
  const order: number[] = [];
  const oldToNew = new Map<number, number>();
  function visit(index: number) {
    if (oldToNew.has(index)) return;
    const parent = bones.indexOf(bones[index].parent as T.Bone);
    if (parent >= 0) visit(parent);
    oldToNew.set(index, order.length);
    order.push(index);
  }
  bones.forEach((_, index) => visit(index));
  const nativeBones = order.map((i) => {
    const bone = bones[i];
    const parent = bones.indexOf(bone.parent as T.Bone);
    const local = parent < 0 ? rest[i] : rest[parent].clone().invert().multiply(rest[i]);
    const value = transform(local);
    if (value.scale.some((v) => Math.abs(v - 1) > 0.0001))
      throw new Error(
        'Editable import needs unit bone scale. Apply armature scale in Blender; the original GLB can still play without conversion.',
      );
    return {
      name: bone.name || `joint-${i}`,
      parent: parent < 0 ? -1 : oldToNew.get(parent)!,
      position: value.position,
      bindRotation: value.rotation,
      rotation: value.rotation,
    };
  });
  return { bones: nativeBones, sourceBones: order.map((i) => bones[i]), oldToNew };
}
function imageAsset(texture: T.Texture, id: string, name: string): AssetRef {
  const source = texture.image as CanvasImageSource & { width: number; height: number };
  if (!source?.width || !source.height || source.width * source.height > 16777216)
    throw new Error('Texture cannot be converted or exceeds 16 megapixels.');
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext('2d')!.drawImage(source, 0, 0);
  const url = canvas.toDataURL('image/png');
  if (url.length > 2000000)
    throw new Error(
      'Converted texture exceeds the document data URL limit. Reduce texture resolution before editable import.',
    );
  return { id, name, type: 'image', mimeType: 'image/png', url };
}

/** Convert a loaded, trusted GLB into the existing editable mesh/rig document contract. */
export function editableImport(input: DesignDocument, pageId: string, nodeId: string, gltf: GLTF) {
  const doc = structuredClone(input),
    page = doc.pages.find((p) => p.id === pageId),
    source = page?.nodes.find((n) => n.id === nodeId);
  if (!page || !source?.src || source.type !== 'model3d') throw new Error('Select an imported model');
  const wrapper = registerImportedScene(gltf),
    created: DesignNode[] = [],
    pairs: { node: DesignNode; mesh: T.Mesh; sourceBones?: T.Bone[] }[] = [],
    textures = new Map<T.Texture, string>();
  try {
    gltf.scene.updateMatrixWorld(true);
    const meshes: T.Mesh[] = [];
    gltf.scene.traverse((o) => {
      if (o instanceof T.Mesh) meshes.push(o);
    });
    if (!meshes.length) throw new Error('The model has no triangle meshes');
    for (const [index, mesh] of meshes.entries()) {
      if (mesh instanceof T.InstancedMesh) throw new Error('Realize mesh instances before editable import');
      const geometry = mesh.geometry,
        position = geometry.getAttribute('position');
      if (
        geometry.morphAttributes.normal?.length ||
        (geometry.morphAttributes as Record<string, unknown[]>).tangent?.length
      )
        throw new Error(
          'Editable conversion cannot retain authored morph normals or tangents. Keep the source GLB to preserve their animation.',
        );
      if (!position || position.count > 300000) throw new Error('Editable mesh exceeds 300,000 vertices');
      const bind = mesh instanceof T.SkinnedMesh ? mesh.bindMatrix : new T.Matrix4();
      const rig = mesh instanceof T.SkinnedMesh ? boneData(mesh) : undefined;
      const data: MeshData = {
        positions: [],
        indices: geometry.index
          ? Array.from(geometry.index.array)
          : Array.from({ length: position.count }, (_, i) => i),
      };
      for (let i = 0; i < position.count; i++)
        data.positions.push(...new T.Vector3().fromBufferAttribute(position, i).applyMatrix4(bind).toArray());
      const normal = geometry.getAttribute('normal'),
        tangent = geometry.getAttribute('tangent');
      if (normal) {
        const normalMatrix = new T.Matrix3().getNormalMatrix(bind);
        data.normals = Array.from({ length: position.count }, (_, i) =>
          new T.Vector3().fromBufferAttribute(normal, i).applyNormalMatrix(normalMatrix).toArray(),
        ).flat();
      }
      if (tangent)
        data.tangents = Array.from({ length: position.count }, (_, i) => [
          ...new T.Vector3().fromBufferAttribute(tangent, i).transformDirection(bind).toArray(),
          tangent.getW(i),
        ]).flat();
      const uv = geometry.getAttribute('uv');
      if (uv) data.uv = Array.from(uv.array);
      const color = geometry.getAttribute('color');
      if (color)
        data.colors = Array.from({ length: position.count }, (_, i) => [
          color.getX(i),
          color.getY(i),
          color.getZ(i),
        ]).flat();
      if (mesh instanceof T.SkinnedMesh) {
        data.skinIndices = Array.from(geometry.getAttribute('skinIndex').array, (index) => rig!.oldToNew.get(index)!);
        data.skinWeights = Array.from(geometry.getAttribute('skinWeight').array);
      }
      const morphNames = Object.keys(mesh.morphTargetDictionary ?? {});
      const morphPositions = geometry.morphAttributes.position ?? [];
      const usedMorphNames = new Set<string>();
      if (morphPositions.length > 16) throw new Error('Editable meshes support at most 16 morph targets');
      if (morphPositions.length)
        data.morphTargets = morphPositions.map((attribute, i) => {
          const base = (morphNames.find((n) => mesh.morphTargetDictionary![n] === i) ?? `morph-${i}`)
              .replace(/[^a-zA-Z0-9_-]/g, '_')
              .slice(0, 60),
            positions: number[] = [];
          let name = base;
          for (let suffix = 2; usedMorphNames.has(name); suffix++) {
            const ending = `_${suffix}`;
            name = base.slice(0, 60 - ending.length) + ending;
          }
          usedMorphNames.add(name);
          for (let j = 0; j < position.count; j++) {
            const value = new T.Vector3().fromBufferAttribute(attribute, j);
            if (!geometry.morphTargetsRelative) value.sub(new T.Vector3().fromBufferAttribute(position, j));
            positions.push(...value.applyMatrix3(new T.Matrix3().setFromMatrix4(bind)).toArray());
          }
          return { name, positions };
        });
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const [materialIndex, material] of materials.entries()) {
        if (!(material instanceof T.MeshStandardMaterial))
          throw new Error('Convert non-PBR materials in the source application before editable import');
        if (
          material instanceof T.MeshPhysicalMaterial &&
          (material.clearcoat ||
            material.transmission ||
            material.thickness ||
            material.sheen ||
            material.iridescence ||
            material.anisotropy ||
            material.dispersion ||
            material.ior !== 1.5 ||
            material.specularIntensity !== 1 ||
            material.specularIntensityMap ||
            material.specularColorMap ||
            material.specularColor.getHex() !== 0xffffff)
        )
          throw new Error(
            'Editable conversion cannot retain these physical material extensions. Bake them in Blender or keep the original GLB.',
          );
        const id = uid(),
          part = structuredClone(data);
        if (materials.length > 1) {
          part.indices = geometry.groups
            .filter((g) => (g.materialIndex ?? 0) === materialIndex)
            .flatMap((g) => data.indices.slice(g.start, g.start + g.count));
          if (!part.indices.length) continue;
        }
        const appearance: NonNullable<NonNullable<DesignNode['scene']>['material']> = {
          transparent: material.transparent,
          normalScale: material.normalScale.toArray(),
          alphaTest: material.alphaTest,
          aoIntensity: material.aoMapIntensity,
          textureFlipY: false,
          color: '#' + material.color.getHexString(),
          metalness: material.metalness,
          roughness: material.roughness,
          doubleSided: material.side === T.DoubleSide,
          emissive: '#' + material.emissive.getHexString(),
          emissiveIntensity: material.emissiveIntensity,
        };
        for (const [map, key] of [
          [material.map, 'textureAssetId'],
          [material.normalMap, 'normalTextureAssetId'],
          [material.roughnessMap, 'roughnessTextureAssetId'],
          [material.metalnessMap, 'metalnessTextureAssetId'],
          [material.emissiveMap, 'emissiveTextureAssetId'],
          [material.aoMap, 'aoTextureAssetId'],
        ] as const) {
          if (!map) continue;
          if (map.channel !== 0)
            throw new Error(
              'Editable import currently needs texture UV channel 0. Bake alternate UV channels in Blender first.',
            );
          if (!textures.has(map)) {
            const assetId = uid();
            doc.assets.push(imageAsset(map, assetId, `${source.name} texture ${textures.size + 1}`));
            textures.set(map, assetId);
          }
          appearance[key] = textures.get(map);
          appearance.textureSettings ??= {} as NonNullable<typeof appearance.textureSettings>;
          appearance.textureSettings[key] = {
            offset: map.offset.toArray(),
            repeat: map.repeat.toArray(),
            center: map.center.toArray(),
            rotation: map.rotation,
            wrapS: map.wrapS,
            wrapT: map.wrapT,
          };
        }
        const local = mesh.matrixWorld.clone();
        if (mesh instanceof T.SkinnedMesh) local.multiply(mesh.bindMatrixInverse);
        const node: DesignNode = {
          id,
          type: 'model3d',
          name: `${source.name} / ${mesh.name || index + 1}${materials.length > 1 ? ' / ' + materialIndex : ''}`,
          parentId: source.id,
          x: 0,
          y: 0,
          width: 400,
          height: 400,
          opacity: material.opacity,
          scene: {
            ...transform(local),
            mesh: part,
            material: appearance,
            ...(rig ? { bones: structuredClone(rig.bones) } : {}),
            morphWeights: Object.fromEntries(
              (part.morphTargets ?? []).map((m, i) => [m.name, mesh.morphTargetInfluences?.[i] ?? 0]),
            ),
          },
        };
        created.push(node);
        pairs.push({ node, mesh, sourceBones: rig?.sourceBones });
      }
    }
    const clipEnd = Math.max(0, ...(source.scene?.importedClips ?? []).map((c) => c.end));
    const end = clipEnd ? Math.max(clipEnd, doc.timeline?.duration ?? 0) : 0;
    const fps = doc.timeline?.fps ?? 30,
      frames = Math.ceil(end * fps) + 1;
    if (frames > 2000)
      throw new Error(
        'Editable animation exceeds 2,000 keys per track. Reduce timeline duration or FPS before conversion.',
      );
    if (
      end &&
      pairs.reduce(
        (sum, p) => sum + 9 + (p.node.scene?.bones?.length ?? 0) * 6 + (p.node.scene?.mesh?.morphTargets?.length ?? 0),
        0,
      ) *
        frames >
        2000000
    )
      throw new Error('Editable animation exceeds two million sampled values');
    if (end) {
      doc.timeline ??= { duration: end, fps, tracks: [] };
      doc.timeline.duration = Math.max(doc.timeline.duration, end);
      const tracks = pairs.map((p) => ({
        id: uid(),
        nodeId: p.node.id,
        keyframes: [] as { time: number; values: Record<string, number> }[],
      }));
      for (let frame = 0; frame < frames; frame++) {
        const time = Math.min(end, frame / fps);
        animateImportedScene(wrapper, source, time);
        for (const [i, { node, mesh, sourceBones }] of pairs.entries()) {
          const values: Record<string, number> = {},
            matrix = mesh.matrixWorld.clone();
          if (mesh instanceof T.SkinnedMesh) matrix.multiply(mesh.bindMatrixInverse);
          const pose = transform(matrix);
          for (const property of ['position', 'rotation', 'scale'] as const)
            pose[property].forEach((v, a) => (values[`scene.${property}.${'xyz'[a]}`] = v));
          if (mesh instanceof T.SkinnedMesh)
            node.scene!.bones!.forEach((bone, j) => {
              const world = sourceBones![j].matrixWorld;
              const local =
                bone.parent < 0 ? world : sourceBones![bone.parent].matrixWorld.clone().invert().multiply(world);
              const pose = transform(local);
              if (pose.scale.some((v) => Math.abs(v - 1) > 0.0001))
                throw new Error(
                  'Animated bone scale cannot be converted without loss. Keep the original GLB animation.',
                );
              for (const property of ['position', 'rotation'] as const)
                pose[property].forEach((v, a) => (values[`scene.bones.${j}.${property}.${'xyz'[a]}`] = v));
            });
          node.scene!.mesh!.morphTargets?.forEach(
            (m, j) => (values[`scene.morphWeights.${m.name}`] = mesh.morphTargetInfluences?.[j] ?? 0),
          );
          const previous = tracks[i].keyframes.at(-1)?.values;
          if (previous) {
            for (const property of Object.keys(values)) {
              if (/^scene\.(?:bones\.\d+\.)?rotation\.[xyz]$/.test(property))
                values[property] += Math.round((previous[property] - values[property]) / 360) * 360;
            }
          }
          tracks[i].keyframes.push({ time, values });
        }
      }
      doc.timeline.tracks.push(...tracks);
    }
    const checkpoint = {
      ...structuredClone(source),
      id: uid(),
      name: `Source: ${source.name}`,
      visible: false,
      locked: true,
      data: { ...source.data, sceneSourceCheckpoint: true },
    };
    source.type = 'group';
    delete source.src;
    source.scene = { position: source.scene?.position, rotation: source.scene?.rotation, scale: source.scene?.scale };
    page.nodes.push(checkpoint, ...created);
    return {
      document: doc,
      report: {
        meshes: created.length,
        textures: textures.size,
        frames: end ? frames : 0,
        sourceCheckpointId: checkpoint.id,
        warnings: [
          'Review joint deformation and texture appearance before replacing your source. Original model retained as a hidden checkpoint.',
        ],
      },
    };
  } finally {
    disposeImportedScene(wrapper);
  }
}
