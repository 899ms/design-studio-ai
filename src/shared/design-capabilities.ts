import { z } from 'zod';

const number = z.number().finite();
const length = number.min(0).max(20000);
export const layoutSchema = z.object({
  mode: z.enum(['absolute', 'flex', 'grid']), direction: z.enum(['row', 'column']).optional(),
  gap: length.optional(), padding: length.optional(), columns: z.number().int().min(1).max(24).optional(),
  align: z.enum(['start', 'center', 'end', 'stretch']).optional(),
  justify: z.enum(['start', 'center', 'end', 'space-between']).optional(), wrap: z.boolean().optional(),
});
export const sizingSchema = z.object({
  width: z.enum(['fixed', 'hug', 'fill']).optional(), height: z.enum(['fixed', 'hug', 'fill']).optional(),
  minWidth: length.optional(), maxWidth: length.optional(), minHeight: length.optional(), maxHeight: length.optional(),
});
export const componentNames = ['Button', 'Checkbox', 'Input', 'InputNumber', 'Slider', 'Image', 'Avatar', 'List', 'Statistics', 'Chart', 'Table', 'Select', 'Switch', 'Textarea', 'Card', 'Badge', 'Progress', 'Tabs', 'Dialog', 'Radio'] as const;
export const componentSchema = z.object({
  name: z.enum(componentNames), system: z.enum(['shadcn', 'antd']).default('shadcn'),
  variant: z.string().max(80).optional(), props: z.record(z.string().max(80), z.union([z.string().max(10000), number, z.boolean(), z.array(z.string().max(2000)).max(1000)])).optional(),
});
export const interactionSchema = z.object({ trigger: z.enum(['click', 'hover']), action: z.enum(['navigate', 'toggle', 'url']), target: z.string().max(2000) });
export const easingSchema = z.union([
  z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'bounce', 'spring', 'step']),
  z.tuple([number.min(0).max(1), number.min(-5).max(5), number.min(0).max(1), number.min(-5).max(5)]),
]);
export const keyframeSchema = z.object({ time: number.min(0).max(3600), values: z.record(z.string().max(80), z.union([z.string().max(2000), number])), easing: easingSchema.optional() });
export const trackSchema = z.object({ clipName: z.string().min(1).max(80).optional(), id: z.string().min(1).max(120), nodeId: z.string().min(1).max(120), keyframes: z.array(keyframeSchema).max(2000), muted: z.boolean().optional(), locked: z.boolean().optional() });
export const timelineSchema = z.object({ duration: number.min(.1).max(3600), fps: number.min(1).max(60), tracks: z.array(trackSchema).max(2000) });
export const vectorSchema = z.tuple([number.min(-100000).max(100000), number.min(-100000).max(100000), number.min(-100000).max(100000)]);
export const meshSchema = z.object({
  positions: z.array(number.min(-100000).max(100000)).min(9).max(900000),
  normals:z.array(number.min(-1).max(1)).max(900000).optional(),
  tangents:z.array(number.min(-1).max(1)).max(1200000).optional(),
  indices: z.array(z.number().int().min(0).max(299999)).min(3).max(1800000),
  uv: z.array(number.min(-100).max(100)).max(600000).optional(),
  colors: z.array(number.min(0).max(1)).max(900000).optional(),
  morphTargets: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(60), positions: z.array(number.min(-100000).max(100000)).max(900000) })).max(16).optional(),
  skinIndices: z.array(z.number().int().min(0).max(255)).max(1200000).optional(),
  skinWeights: z.array(number.min(0).max(1)).max(1200000).optional(),
}).superRefine((mesh, ctx) => {
  const count = mesh.positions.length / 3;
  if(mesh.normals&&mesh.normals.length!==count*3)ctx.addIssue({code:'custom',message:'Normals need three values per vertex'});
  if(mesh.tangents&&mesh.tangents.length!==count*4)ctx.addIssue({code:'custom',message:'Tangents need four values per vertex'});
  if (mesh.morphTargets && mesh.morphTargets.reduce((sum,t)=>sum+t.positions.length,0)>2000000) ctx.addIssue({code:'custom',message:'Morph targets exceed two million scalar values'});
  if (!Number.isInteger(count) || mesh.indices.length % 3 || mesh.indices.some(i => i >= count)) ctx.addIssue({ code: 'custom', message: 'Mesh triangles must reference existing vertices' });
  if (mesh.colors && mesh.colors.length !== count * 3) ctx.addIssue({ code: 'custom', message: 'Vertex colors require RGB per vertex' });
  if (mesh.morphTargets?.some(t => t.positions.length !== mesh.positions.length) || new Set(mesh.morphTargets?.map(t => t.name)).size !== (mesh.morphTargets?.length ?? 0)) ctx.addIssue({ code: 'custom', message: 'Morph targets need unique names and one delta per vertex' });
  if (mesh.uv && mesh.uv.length !== count * 2) ctx.addIssue({ code: 'custom', message: 'UV requires two coordinates per vertex' });
  if (!!mesh.skinIndices !== !!mesh.skinWeights || (mesh.skinIndices && (mesh.skinIndices.length !== count * 4 || mesh.skinWeights!.length !== count * 4))) ctx.addIssue({ code: 'custom', message: 'Skinning requires four indices and weights per vertex' });
});
export const sceneObjectSchema = z.object({
  importedClips: z.array(z.object({name:z.string().min(1).max(160),start:number.min(0).max(3600),end:number.min(0).max(3600),speed:number.min(.1).max(4).optional(),weight:number.min(0).max(1).optional(),loop:z.boolean().optional()}).refine(c=>c.end>c.start,'Clip end must follow start')).max(64).optional(),
  position: vectorSchema.optional(), rotation: vectorSchema.optional(), scale: vectorSchema.optional(),
  mesh: meshSchema.optional(),
  constraints:z.array(z.object({id:z.string().min(1).max(120),endBone:z.string().min(1).max(120),target:vectorSchema,pole:vectorSchema,start:number.min(0).max(3600),end:number.min(0).max(3600),maxAngle:number.min(1).max(180),groundHeight:number.optional(),enabled:z.boolean()})).max(32).optional(),
  rigId: z.string().min(1).max(120).optional(),
  clips: z.array(z.object({name:z.string().min(1).max(80),start:number.min(0).max(3600),end:number.min(0).max(3600),sourceDuration:number.positive().max(3600).optional(),speed:number.min(.1).max(4).optional(),amplitude:number.min(0).max(2).optional(),repeat:z.number().int().min(1).max(20).optional(),blend:number.min(0).max(5).optional()}).refine(c=>c.end>c.start,'Clip end must follow start')).max(64).optional(),
  morphWeights: z.record(z.string().max(60), number.min(0).max(1)).optional(),
  material: z.object({
    transparent: z.boolean().optional(),
    normalScale: z.tuple([number.min(-10).max(10), number.min(-10).max(10)]).optional(),
    aoTextureAssetId: z.string().max(120).optional(),
    aoIntensity: number.min(0).max(10).optional(),
    alphaTest: number.min(0).max(1).optional(),
    textureSettings: z.partialRecord(
      z.enum(['textureAssetId', 'normalTextureAssetId', 'roughnessTextureAssetId', 'metalnessTextureAssetId', 'emissiveTextureAssetId', 'aoTextureAssetId']),
      z.object({
        offset: z.tuple([number, number]),
        repeat: z.tuple([number, number]),
        center: z.tuple([number, number]),
        rotation: number,
        wrapS: z.union([z.literal(1000), z.literal(1001), z.literal(1002)]),
        wrapT: z.union([z.literal(1000), z.literal(1001), z.literal(1002)]),
      }),
    ).optional(),
    emissive: z.string().max(80).optional(),
    emissiveIntensity: number.min(0).max(20).optional(),
    normalTextureAssetId: z.string().max(120).optional(),
    roughnessTextureAssetId: z.string().max(120).optional(),
    metalnessTextureAssetId: z.string().max(120).optional(),
    emissiveTextureAssetId: z.string().max(120).optional(),
    textureFlipY: z.boolean().optional(),
    textureResolution: z.union([z.literal(256), z.literal(512), z.literal(1024), z.literal(2048)]).optional(),
    layers: z.array(z.object({
      id: z.string().min(1).max(120),
      name: z.string().min(1).max(80),
      map: z.enum(['color', 'normal', 'roughness']),
      opacity: number.min(0).max(1),
      visible: z.boolean().optional(),
      strokes: z.array(z.object({
        uv: z.tuple([number.min(0).max(1), number.min(0).max(1)]),
        radius: number.min(.001).max(1),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      })).max(256),
    })).max(8).optional(),
    paint: z.array(z.object({
      uv: z.tuple([number.min(0).max(1), number.min(0).max(1)]),
      radius: number.min(.001).max(1),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    })).max(256).optional(),
    color: z.string().max(80).optional(),
    metalness: number.min(0).max(1).optional(),
    roughness: number.min(0).max(1).optional(),
    wireframe: z.boolean().optional(),
    doubleSided: z.boolean().optional(),
    textureAssetId: z.string().max(120).optional(),
  }).optional(),
  bones: z.array(z.object({ name: z.string().max(120), parent: z.number().int().min(-1).max(255), position: vectorSchema, rotation: vectorSchema.optional(), bindRotation: vectorSchema.optional(), rotationLimits:z.object({min:vectorSchema,max:vectorSchema}).refine(l=>l.min.every((v,i)=>v<=l.max[i]),'Joint minimum must not exceed maximum').optional(), mirrorBone:z.string().min(1).max(120).optional() })).max(256).optional(),
});
export const sceneSchema = z.object({
  camera: z.object({
    position: vectorSchema,
    target: vectorSchema,
    fov: number.min(10).max(120),
    safeFrame: number.min(0).max(.3).optional(),
  }),
  ambient: number.min(0).max(10),
  light: z.object({ position: vectorSchema, intensity: number.min(0).max(20), color: z.string().max(80) }),
  lights: z.array(z.object({
    id: z.string().min(1).max(120),
    type: z.enum(['point', 'spot', 'directional']),
    position: vectorSchema,
    target: vectorSchema.optional(),
    color: z.string().max(80),
    intensity: number.min(0).max(1000),
    distance: number.min(0).max(10000).optional(),
    angle: number.min(.01).max(1.57).optional(),
    shadow: z.boolean().optional(),
  })).max(8).optional(),
  atmosphere: z.object({ fogColor: z.string().max(80), fogDensity: number.min(0).max(1) }).optional(),
  rendering: z.object({
    exposure: number.min(.1).max(5).optional(),
    bloom: number.min(0).max(3).optional(),
    bloomThreshold: number.min(0).max(10).optional(),
    shadows: z.boolean().optional(),
    environmentIntensity: number.min(0).max(5).optional(),
  }).optional(),
  emitters: z.array(z.object({
    id: z.string().min(1).max(120),
    position: vectorSchema,
    spread: vectorSchema,
    velocity: vectorSchema,
    count: z.number().int().min(1).max(3000),
    size: number.min(.001).max(10),
    color: z.string().max(80),
    lifetime: number.min(.1).max(60),
    seed: z.number().int().min(0).max(2147483647),
    start: number.min(0).max(3600).optional(),
    end: number.min(0).max(3600).optional(),
  })).max(8).optional(),
});
export type Layout = z.infer<typeof layoutSchema>;
export type MeshData = z.infer<typeof meshSchema>;
