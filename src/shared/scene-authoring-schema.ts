import { z } from 'zod';
import { cameraKeySchema, sceneEmitterSchema, sceneObjectSchema, sceneSchema, vectorSchema } from './design-capabilities';
import { emitterPresetNames } from './scene-presets';
import { responseModeSchema } from './document-change-summary';
export const clipPresetNames = ['idle', 'wag', 'walk', 'wing-flap', 'roar', 'breath-attack', 'tail-swipe'] as const;
const id = z.string().min(1).max(120);
const finite = z.number().finite();
const quadrupedLandmarksSchema = z.object({ hips: vectorSchema, chest: vectorSchema, head: vectorSchema, frontLeft: vectorSchema, frontRight: vectorSchema, backLeft: vectorSchema, backRight: vectorSchema, tail: vectorSchema });
const wingLandmarksSchema = z.object({ shoulder: vectorSchema, elbow: vectorSchema, wrist: vectorSchema, fingers: z.array(z.object({ base: vectorSchema, tip: vectorSchema })).min(3).max(5) });
export const wingedLandmarksSchema = quadrupedLandmarksSchema.extend({ jaw: vectorSchema, jawTip: vectorSchema, wingLeft: wingLandmarksSchema, wingRight: wingLandmarksSchema });
const materialPatchSchema = sceneObjectSchema.shape.material.unwrap().pick({ color: true, metalness: true, roughness: true, emissive: true, emissiveIntensity: true, transmission: true, thickness: true, ior: true, clearcoat: true, clearcoatRoughness: true, bloom: true, fog: true, transparent: true, doubleSided: true, wireframe: true });
/** Every material field also accepts null, which removes it so the renderer default applies again. */
const nullablePatch = <S extends z.ZodRawShape>(shape: S) => Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, (schema instanceof z.ZodOptional ? schema.unwrap() as z.ZodType : schema as z.ZodType).nullable().optional()])) as unknown as { [K in keyof S]: z.ZodOptional<z.ZodNullable<S[K] extends z.ZodOptional<infer Inner> ? Inner : S[K]>> };
/** Partial page-level settings: a key set to null removes that setting. */
const settingsPatch = z.record(z.string().max(40), z.unknown());
const lightShape = sceneSchema.shape.lights.unwrap().element.shape;
export const sceneCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('camera'), position: vectorSchema.optional(), target: vectorSchema.optional(), fov: finite.min(10).max(120).optional(), safeFrame: finite.min(0).max(.3).optional() }),
  z.object({ action: z.literal('camera-key'), time: finite.min(0).max(3600), position: vectorSchema.optional(), target: vectorSchema.optional(), fov: cameraKeySchema.shape.fov, ease: cameraKeySchema.shape.ease, remove: z.boolean().default(false) }),
  z.object({ action: z.literal('environment'), ambient: finite.min(0).max(10).optional(), light: z.object({ position: vectorSchema.optional(), intensity: finite.min(0).max(20).optional(), color: z.string().max(80).optional() }).optional(), atmosphere: settingsPatch.nullable().optional(), rendering: settingsPatch.nullable().optional() }),
  z.object({ action: z.literal('emitter'), id, preset: z.enum(emitterPresetNames).optional(), ...sceneEmitterSchema.omit({ id: true }).partial().shape }),
  z.object({ action: z.literal('remove-emitter'), id }),
  z.object({ action: z.literal('light'), id, type: lightShape.type.optional(), position: vectorSchema.optional(), target: vectorSchema.nullable().optional(), color: lightShape.color.optional(), intensity: lightShape.intensity.optional(), distance: lightShape.distance.unwrap().nullable().optional(), angle: lightShape.angle.unwrap().nullable().optional(), shadow: z.boolean().nullable().optional(), remove: z.boolean().default(false) }),
  z.object({ action: z.literal('remove-node'), nodeId: id }),
  z.object({ action: z.literal('terrain'), outputId: id, shape: z.enum(['plane', 'mountain', 'ridges']).default('mountain'), size: z.tuple([finite.min(.1).max(10000), finite.min(.1).max(10000)]).default([20, 20]), resolution: z.number().int().min(4).max(128).default(64), height: finite.min(0).max(1000).default(4), seed: z.number().int().min(0).max(2147483647).default(1), octaves: z.number().int().min(1).max(6).default(4), roughness: finite.min(.1).max(.9).default(.5), position: vectorSchema.default([0, 0, 0]), color: z.string().max(80).default('#DDE7F0'), snowLine: finite.min(0).max(1).optional(), snowColor: z.string().max(80).optional() }),
  z.object({ action: z.literal('material'), nodeId: id, opacity: finite.min(0).max(1).optional(), ...nullablePatch(materialPatchSchema.shape) }),
  z.object({action:z.literal('checkpoint'),nodeId:id,outputId:id}),
  z.object({action:z.literal('restore-mesh'),nodeId:id,sourceId:id}),
  z.object({action:z.literal('insert-loop'),nodeId:id,axis:z.enum(['x','y','z']),offset:finite}),
  z.object({action:z.literal('clear-paint'),nodeId:id,layerId:id.optional()}),
  z.object({action:z.literal('joint'),nodeId:id,bone:id,mode:z.enum(['rest','pose']),value:vectorSchema}),
  z.object({action:z.literal('joint-limits'),nodeId:id,bone:id,min:vectorSchema,max:vectorSchema,mirrorBone:id.optional()}),
  z.object({action:z.literal('mirror-pose'),nodeId:id,bone:id}),
  z.object({action:z.literal('texture-layer'),nodeId:id,id:id,name:z.string().min(1).max(80),map:z.enum(['color','normal','roughness']),opacity:finite.min(0).max(1).default(1),visible:z.boolean().default(true),resolution:z.union([z.literal(256),z.literal(512),z.literal(1024),z.literal(2048)]).default(512)}),
  z.object({action:z.literal('contact'),nodeId:id,id:id,endBone:id,target:vectorSchema,pole:vectorSchema,start:finite.min(0).max(3600),end:finite.min(0).max(3600),maxAngle:finite.min(1).max(180).default(120),groundHeight:finite.optional(),enabled:z.boolean().default(true)}),
  z.object({action:z.literal('weight-brush'),nodeId:id,bone:id,center:vectorSchema,radius:finite.positive().max(1000),strength:finite.min(0).max(1).default(.2),mode:z.enum(['add','subtract','smooth']),mirrorBone:id.optional(),lockedBones:z.array(id).max(256).default([]),lockedVertices:z.array(z.number().int().min(0)).max(300000).default([])}),
  z.object({action:z.literal('sculpt'),nodeId:id,center:vectorSchema,radius:finite.positive().max(1000),strength:finite.min(0).max(1).default(.2),mode:z.enum(['smooth','inflate','move','crease','flatten','pinch']),delta:vectorSchema.default([0,0,0]),path:z.array(vectorSchema).max(64).default([]),symmetry:z.boolean().default(false)}),
  z.object({action:z.literal('split-edges'),nodeId:id,edges:z.array(z.tuple([z.number().int().min(0),z.number().int().min(0)])).min(1).max(1000)}),
  z.object({ action:z.literal('edit-clip'),nodeId:id,name:id,speed:finite.min(.1).max(4).default(1),amplitude:finite.min(0).max(2).default(1),repeat:z.number().int().min(1).max(20).default(1),blend:finite.min(0).max(5).default(0) }),
  z.object({ action:z.literal('rest-pose'),nodeId:id }),
  z.object({ action: z.literal('share-rig'), nodeId: id }),
  z.object({ action: z.literal('convert'), nodeId: id }),
  z.object({ action: z.literal('remesh'), nodeIds: z.array(id).min(1).max(64), outputId: id, resolution: z.number().int().min(12).max(48).default(28), symmetry: z.boolean().default(false), blend: finite.min(.001).max(2).default(.12) }),
  z.object({ action: z.literal('loft'), outputId: id, rings: z.array(z.object({ center: vectorSchema, radius: finite.min(.001).max(1000) })).min(2).max(64), segments: z.number().int().min(6).max(48).default(16), color: z.string().max(80).default('#D89B55') }),
  z.object({ action: z.literal('subdivide'), nodeId: id, iterations: z.number().int().min(1).max(3).default(1), smooth: z.boolean().default(true) }),
  z.object({ action: z.literal('relax'), nodeId: id, iterations: z.number().int().min(1).max(20).default(3), strength: finite.min(0).max(.5).default(.2) }),
  z.object({ action: z.literal('rig-quadruped'), nodeId: id, landmarks: quadrupedLandmarksSchema.optional() }),
  z.object({ action: z.literal('rig-winged-quadruped'), nodeId: id, landmarks: wingedLandmarksSchema }),
  z.object({ action: z.literal('attach'), nodeId: id, rigNodeId: id, bone: id }),
  z.object({ action: z.literal('bind'), nodeId: id, rigidBone: id.optional(), smooth: z.number().int().min(0).max(10).default(2) }),
  z.object({ action: z.literal('weights'), nodeId: id, mode: z.enum(['normalize', 'smooth', 'mirror']), iterations: z.number().int().min(1).max(10).default(2) }),
  z.object({ action: z.literal('pose'), nodeId: id, bone: id, rotation: vectorSchema }),
  z.object({ action: z.literal('ik'), nodeId: id, endBone: id, target: vectorSchema, chainLength: z.number().int().min(1).max(4).default(2), maxAngle: finite.min(1).max(180).default(120) }),
  z.object({ action: z.literal('clip'), nodeId: id, preset: z.enum(clipPresetNames), start: finite.min(0).max(3500).default(0), duration: finite.min(.2).max(30).default(2), strength: finite.min(0).max(2).default(1), wristLag: finite.min(0).max(.5).default(.15) }),
  z.object({ action: z.literal('morph'), nodeId: id, name: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(60), vertices: z.array(z.number().int().min(0)).min(1).max(300000), delta: vectorSchema, weight: finite.min(0).max(1).default(0) }),
  z.object({ action: z.literal('uv-pack'), nodeId: id, seams: z.array(z.tuple([z.number().int().min(0), z.number().int().min(0)])).max(20000).default([]) }),
  z.object({ action: z.literal('paint'), nodeId: id, layerId:id.optional(), uv: z.tuple([finite.min(0).max(1), finite.min(0).max(1)]), radius: finite.min(.001).max(1), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }),
]);
export type SceneCommand = z.infer<typeof sceneCommandSchema>;
export const sceneRequestSchema = z.object({ pageId: id, command: sceneCommandSchema, expectedRevision: z.number().int().positive(), preview: z.boolean().default(true), responseMode: responseModeSchema });
