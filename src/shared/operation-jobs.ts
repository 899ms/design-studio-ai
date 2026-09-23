import {z} from 'zod';
import {documentWriteSchema} from './document-write';
import {exportOptionsSchema} from './export-contract';
import {sceneRequestSchema} from './scene-authoring-schema';
export const operationIdSchema=z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
export const operationJobSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('save'),operationId:operationIdSchema,input:documentWriteSchema.omit({operationId:true,responseMode:true})}),
 // Long 3D commands (remesh, rig, bind) run outside the request timeout and always apply.
 z.object({kind:z.literal('scene'),operationId:operationIdSchema,input:sceneRequestSchema.omit({preview:true})}),
 z.object({kind:z.literal('export'),operationId:operationIdSchema,input:exportOptionsSchema.extend({expectedRevision:z.number().int().positive()})}),
]);
export type OperationJobRequest=z.infer<typeof operationJobSchema>;
export type OperationJob={id:string;kind:OperationJobRequest['kind'];status:'queued'|'running'|'succeeded'|'failed';stage:string;revision:number|null;error:{code:string;message:string}|null;resultUrl:string|null;createdAt:number;updatedAt:number};
