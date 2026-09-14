import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerDesignTools } from '../src/app/browser-design-tools';
import { createDocument } from '../src/shared/catalog';

// Collect every `op` discriminator literal the published operations schema exposes,
// wherever the JSON Schema nests it (enum or const, anyOf or oneOf).
function operationLiterals(schema: unknown) {
  const literals = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const op = (record.properties as Record<string, unknown> | undefined)?.op as Record<string, unknown> | undefined;
    if (op && Array.isArray(op.enum)) for (const literal of op.enum) literals.add(String(literal));
    if (op && 'const' in op) literals.add(String(op.const));
    for (const nested of Object.values(record)) walk(nested);
  };
  walk(schema);
  return literals;
}

test('browser registration stays compact while retaining canonical validation and discovery', async () => {
  let document = createDocument('web');
  type Tool = Parameters<Parameters<typeof registerDesignTools>[0]['registerTool']>[0];
  const tools = new Map<string, Tool>();
  const unregister = registerDesignTools({ registerTool: tool => tools.set(tool.name, tool), unregisterTool: name => { tools.delete(name); } }, () => document, next => { document = next; });
  // Conservative regression budgets, not a claim about every host's exact limits.
  const metadata = [...tools.values()].map(({ execute, ...tool }) => tool);
  assert.ok(Buffer.byteLength(JSON.stringify(metadata)) < 32000);
  for (const tool of metadata) assert.ok(Buffer.byteLength(JSON.stringify(tool)) < 4096, tool.name);
  const capabilities = await tools.get('studio_capabilities')!.execute({}) as { content: { text: string }[] };
  const schemas = JSON.parse(capabilities.content[0].text);
  // Pin the published contract instead of recomputing it: the batch schema must keep its
  // bounds and expose the real operation literals, and document writes must keep their keys.
  assert.equal(schemas.operations.type, 'array');
  assert.equal(schemas.operations.minItems, 1);
  const literals = operationLiterals(schemas.operations);
  for (const op of ['add-node', 'update-node', 'remove-node', 'add-page', 'set-theme', 'set-timeline', 'upsert-track', 'upsert-keyframe', 'rename', 'reparent-node', 'update-page', 'scene-command','replace-asset']) assert.ok(literals.has(op), `operations schema must publish "${op}"`);
  assert.ok(literals.size >= 20, `expected the full operation union, saw ${literals.size}`);
  assert.equal(schemas.documentWrite.type, 'object');
  assert.deepEqual([...schemas.documentWrite.required].sort(), ['document', 'expectedRevision']);
  for (const field of ['document', 'expectedRevision']) assert.ok(schemas.documentWrite.properties[field], `documentWrite must publish ${field}`);
  const apply = tools.get('studio_apply_operations')!;
  await apply.execute({ operations: [{ op: 'rename', name: 'Editable through WebMCP' }] });
  assert.equal(document.name, 'Editable through WebMCP');
  const before = structuredClone(document);
  await assert.rejects(apply.execute({ operations: [{ op: 'rename', name: 'Must not apply' }, { op: 'add-node', pageId: document.pages[0].id, node: { id: 'invalid' } }] }));
  assert.deepEqual(document, before, 'invalid nested nodes must reject the whole batch');
  await assert.rejects(apply.execute({ operations: [{ op: 'unknown-operation' }] }));
  assert.deepEqual(document, before);
  assert.ok(tools.has('studio_api_put_projects_id_document'));
  assert.ok(tools.has('studio_api_post_projects_id_assets'));
  assert.ok(tools.has('studio_api_post_design_systems_import'));
  assert.ok(tools.has('studio_imported_model'));
  assert.ok(tools.has('studio_frame_scene_shot'));
  assert.ok(![...tools.keys()].some(name => name.includes('tokens') || name.includes('auth')));
  unregister();
  assert.equal(tools.size, 0);
});

test('agent shot framing previews without writes and applies a fitted square variant',async()=>{
  let document=createDocument('3d');document.pages[0].nodes=[{id:'subject',name:'Subject',type:'model3d',x:0,y:0,width:400,height:400,scene:{position:[0,0,0],scale:[3,1,1]}}];
  const original=JSON.stringify(document),tools=new Map<string,any>();registerDesignTools({registerTool:tool=>tools.set(tool.name,tool)},()=>document,next=>{document=next;});
  const tool=tools.get('studio_frame_scene_shot'),input={pageId:document.pages[0].id,nodeIds:['subject'],aspect:'square',samples:3};
  const preview=JSON.parse((await tool.execute(input)).content[0].text);assert.equal(preview.preview,true);assert.equal(JSON.stringify(document),original);
  await tool.execute({...input,preview:false});assert.equal(document.pages.length,2);assert.equal(document.pages[1].width,1080);assert.equal(document.pages[1].height,1080);assert(document.pages[1].scene?.camera);assert.notEqual(document.pages[1].nodes[0].id,'subject');
});
