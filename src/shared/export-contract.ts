import {z} from 'zod';
/** A portable JSON download embeds owned media as base64 data URLs; it is bounded separately from a render. */
export const PORTABLE_JSON_MEDIA_BUDGET = 20 * 1024 ** 2;
/** Every rendered artifact, including the Community cover, embeds each owned asset once within this bound. */
export const RENDER_MEDIA_BUDGET = 30 * 1024 ** 2;
export const exportOptionsSchema = z.object({ format: z.enum(['json', 'svg', 'html', 'png', 'pdf', 'pptx', 'webm', 'mp4', 'react', 'glb', 'gltf', 'motion', 'png-sequence', 'spritesheet', 'scene-angles','editable-scene']), nodeId:z.string().min(1).max(120).optional(),reviewSamples:z.number().int().min(2).max(25).optional(),pageIndex: z.number().int().min(0).default(0), start:z.number().min(0).max(3600).default(0), end:z.number().min(.01).max(3600).optional(), fps:z.number().int().min(1).max(60).default(30), expectedRevision: z.number().int().positive().optional() });
