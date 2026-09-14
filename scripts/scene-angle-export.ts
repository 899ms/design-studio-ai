import JSZip from 'jszip';
import { Box3, Frustum, InstancedMesh, Matrix4, Mesh, PerspectiveCamera, SkinnedMesh, Vector3, type Object3D } from 'three';
import type { DesignDocument } from '../src/shared/schema';
import { animateScene, buildScene, defaultScene, disposeScene } from '../src/shared/scene-runtime';
import { captureExportPage } from '../src/app/export-page';

const angles = [['front', 0], ['right', Math.PI / 2], ['back', Math.PI], ['left', -Math.PI / 2]] as const;

function visible(object: Object3D) {
  for (let current: Object3D | null = object; current; current = current.parent) if (!current.visible) return false;
  return true;
}

/** Inspect posed vertices, including imported skins/morphs, rather than cached rest bounds. */
function geometryReport(object: Object3D | undefined, camera: PerspectiveCamera, frustum: Frustum) {
  const bounds = new Box3(), point = new Vector3(), local = new Vector3(), instance = new Matrix4();
  let vertices = 0, triangles = 0, meshes = 0, clippedVertices = 0, invalidVertices = 0;
  const skeletons = new Set<SkinnedMesh['skeleton']>();
  if (object) object.traverse(child => {
    if (!(child instanceof Mesh) || !visible(child) || child.userData.nodeId !== object!.userData.nodeId) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    if (materials.every(material => !material.visible || material.opacity <= 0)) return;
    const position = child.geometry.getAttribute('position');
    if (!position) return;
    if (child instanceof SkinnedMesh) { child.skeleton.update(); skeletons.add(child.skeleton); }
    const count = child instanceof InstancedMesh ? child.count : 1;
    meshes += count; triangles += (child.geometry.index?.count ?? position.count) / 3 * count;
    for (let copy = 0; copy < count; copy++) {
      if (child instanceof InstancedMesh) child.getMatrixAt(copy, instance);
      for (let i = 0; i < position.count; i++) {
        child.getVertexPosition(i, point);
        if (child instanceof InstancedMesh) point.applyMatrix4(instance);
        point.applyMatrix4(child.matrixWorld); vertices++;
        if (![point.x, point.y, point.z].every(Number.isFinite)) { invalidVertices++; continue; }
        bounds.expandByPoint(point);
        local.copy(point).applyMatrix4(camera.matrixWorldInverse);
        point.project(camera);
        if (local.z > -camera.near || local.z < -camera.far || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) clippedVertices++;
      }
    }
  });
  const status = object && !visible(object) ? 'hidden' : !vertices || bounds.isEmpty() ? 'missing-geometry' : !frustum.intersectsBox(bounds) ? 'outside-camera' : clippedVertices ? 'partially-clipped' : 'inside-camera';
  return { status, meshes, vertices, triangles, bones: [...skeletons].reduce((sum, skeleton) => sum + skeleton.bones.length, 0), clippedVertices, invalidVertices, worldBounds: bounds.isEmpty() ? null : { min: bounds.min.toArray(), max: bounds.max.toArray() } };
}

export async function sceneAngles(input: DesignDocument, index: number, time: number, end?: number, samples = 5) {
  const doc = structuredClone(input), page = doc.pages[index];
  if (!page) throw new Error('Unknown page');
  if (!Number.isFinite(time) || time < 0 || time > 3600) throw new Error('Choose a valid review start time');
  if (end !== undefined && (!Number.isFinite(end) || end <= time || end > 3600 || !Number.isInteger(samples) || samples < 2 || samples > 25)) throw new Error('Choose 2–25 samples with an end time after the start');
  if (!page.nodes.some(node => node.type === 'model3d')) throw new Error('Multi-angle export requires a 3D page');
  const times = end === undefined ? [time] : Array.from({ length: samples }, (_, i) => time + (end - time) * i / (samples - 1));
  const scale = Math.min(240 / page.width, 240 / page.height, 1), thumbWidth = Math.max(1, Math.round(page.width * scale)), thumbHeight = Math.max(1, Math.round(page.height * scale));
  const sheetPixels = end === undefined ? 0 : thumbWidth * 4 * (thumbHeight + 24) * times.length;
  if (page.width * page.height * 4 * times.length + sheetPixels > 67108864) throw new Error('Angle review images exceed 64 megapixels; reduce page size or samples');
  const config = page.scene ?? defaultScene, target = new Vector3(...config.camera.target), offset = new Vector3(...config.camera.position).sub(target);
  const zip = new JSZip(), views = [], started = performance.now();
  const sheet = end === undefined ? undefined : document.createElement('canvas');
  if (sheet) { sheet.width = thumbWidth * 4; sheet.height = (thumbHeight + 24) * times.length; }
  const sheetContext = sheet?.getContext('2d');
  if (sheet && !sheetContext) throw new Error('Cannot create the review contact sheet');
  const built = await buildScene(doc, index, time);
  try {
    for (const [frame, sampleTime] of times.entries()) {
      animateScene(built.scene, doc, index, sampleTime); built.scene.updateMatrixWorld(true);
      for (const [column, [name, angle]] of angles.entries()) {
        const position = offset.clone().applyAxisAngle(new Vector3(0, 1, 0), angle).add(target).toArray();
        page.scene = { ...config, camera: { ...config.camera, position } };
        built.camera.position.fromArray(position); built.camera.lookAt(target); built.camera.updateMatrixWorld(true);
        const analysisStart = performance.now(), frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(built.camera.projectionMatrix, built.camera.matrixWorldInverse));
        const nodes = page.nodes.filter(node => node.type === 'model3d').map(node => ({ nodeId: node.id, name: node.name, time: sampleTime, cameraId: name, ...geometryReport(built.objects.get(node.id), built.camera, frustum) }));
        const analysisMilliseconds = performance.now() - analysisStart;
        const captureStart = performance.now(), canvas = await captureExportPage(doc, index, sampleTime);
        try {
          const file = end === undefined ? `${name}.png` : `frame-${String(frame).padStart(3, '0')}/${name}.png`;
          const encoded = canvas.toDataURL('image/png').split(',')[1];
          zip.file(file, encoded, { base64: true });
          views.push({ file, frame, angle: name, time: sampleTime, camera: page.scene.camera, nodes, geometry: { meshes: nodes.reduce((sum, node) => sum + node.meshes, 0), vertices: nodes.reduce((sum, node) => sum + node.vertices, 0), triangles: nodes.reduce((sum, node) => sum + node.triangles, 0) }, analysisMilliseconds, captureMilliseconds: performance.now() - captureStart, encodedBytes: Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0) });
          if (sheetContext) {
            const x = column * thumbWidth, y = frame * (thumbHeight + 24);
            sheetContext.fillStyle = '#16202b'; sheetContext.fillRect(x, y, thumbWidth, thumbHeight + 24);
            sheetContext.drawImage(canvas, x, y + 24, thumbWidth, thumbHeight);
            sheetContext.fillStyle = '#ffffff'; sheetContext.font = '12px sans-serif'; sheetContext.fillText(`${name} · ${sampleTime.toFixed(3)}s`, x + 6, y + 16, thumbWidth - 12);
          }
        } finally { canvas.width = 0; canvas.height = 0; }
      }
    }
    if (sheet) zip.file('contact-sheet.png', sheet.toDataURL('image/png').split(',')[1], { base64: true });
    zip.file('views.json', JSON.stringify({ pageId: page.id, width: page.width, height: page.height, start: time, end: end ?? time, samples: times.length, reference: 'front is the saved camera; other angles orbit its target', clippingMethod: 'Posed geometry projected into each camera. Outside-camera uses world bounds; clipping does not measure occlusion or guarantee pixel visibility.', ...(sheet ? { contactSheet: { file: 'contact-sheet.png', columns: 4, rows: times.length, width: sheet.width, height: sheet.height } } : {}), totalMilliseconds: performance.now() - started, views }, null, 2));
    return await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
  } finally { disposeScene(built.scene); if (sheet) { sheet.width = 0; sheet.height = 0; } }
}
