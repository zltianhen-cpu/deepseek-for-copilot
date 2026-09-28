// Purpose: tool ordering contract and real prepare -> client -> mock HTTP regression.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const Module = require('node:module');
const warnings = [];
class Text { constructor(value) { this.value = value; } }
const stub = {
  env: { language: 'en' }, version: 'smoke',
  window: { createOutputChannel: () => ({ info() {}, debug() {}, error() {}, warn: x => warnings.push(x) }) },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_k, d) => d, inspect: () => ({}) }) },
  Uri: { file: p => ({ fsPath: p, scheme: 'file' }) },
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
  LanguageModelTextPart: Text,
  LanguageModelDataPart: class {}, LanguageModelThinkingPart: class {},
  LanguageModelToolCallPart: class {}, LanguageModelToolResultPart: class {},
};
const originalLoad = Module._load;
Module._load = function (id, ...args) { return id === 'vscode' ? stub : originalLoad.call(this, id, ...args); };
const root = process.env.CACHE_EXTENSION_TEST_DIR || path.join(__dirname, '..');
const from = p => require(path.join(root, 'out', p));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-order-'));
process.env.DEEPSEEK_DATA_DIR = tmp;
process.env.DEEPSEEK_AUTOBUILD_OFF = '1';
const { prepareRequestTools } = from('provider/tools/request.js');
const { safeStringify } = from('json.js');
const host = (name, description = name, inputSchema = { type: 'object', properties: {} }) => ({ name, description, inputSchema });
const prep = tools => prepareRequestTools(true, { tools });
const names = tools => tools?.map(t => t.function.name);
const canonical = ['configure_python_environment', 'get_python_environment_details', 'get_python_executable_details'];
const pythonTools = canonical.map(n => host(n));
const rotated = [pythonTools[1], pythonTools[2], pythonTools[0]];
after(() => { Module._load = originalLoad; fs.rmSync(tmp, { recursive: true, force: true }); });

test('incident Python rotation produces identical outgoing bytes', () => {
  assert.equal(safeStringify(prep(rotated)), safeStringify(prep(pythonTools)));
});
test('all six permutations converge', () => {
  const permutations = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
  for (const p of permutations) assert.deepEqual(names(prep(p.map(i => pythonTools[i]))), canonical);
});
test('same set across independent calls is deterministic', () => {
  prep([host('unrelated')]);
  assert.deepEqual(prep(rotated), prep(pythonTools));
});
test('frozen host input and schemas are not mutated', () => {
  const schema = Object.freeze({ type: 'object', properties: Object.freeze({}) });
  const input = Object.freeze([Object.freeze(host('z', 'z', schema)), Object.freeze(host('a', 'a', schema))]);
  const before = JSON.stringify(input), output = prep(input);
  assert.deepEqual(names(output), ['a', 'z']);
  assert.equal(JSON.stringify(input), before);
  assert.equal(output[0].function.parameters, schema);
});
test('descriptions and nested schema arrays retain exact bytes', () => {
  const schema = { type:'object', required:['z','a'], properties:{ x:{enum:['z','a']} } };
  const output = prep([host('z', 'keep\n原文', schema), host('a')]);
  assert.equal(output[1].function.description, 'keep\n原文');
  assert.equal(JSON.stringify(output[1].function.parameters), JSON.stringify(schema));
});
test('locale independent code-unit ordering', t => {
  t.mock.method(String.prototype, 'localeCompare', () => { throw Error('locale comparator forbidden'); });
  assert.deepEqual(names(prep(['z','_x','a','Z','A'].map(n => host(n)))), ['A','Z','_x','a','z']);
});
test('preordered input remains byte identical', () => {
  assert.equal(safeStringify(prep(pythonTools)), safeStringify(pythonTools.map(t => ({type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}}))));
});
test('empty tools stay undefined', () => assert.equal(prep([]), undefined));
test('missing tools stay undefined', () => assert.equal(prep(undefined), undefined));
test('disabled capability stays undefined', () => assert.equal(prepareRequestTools(false,{tools:rotated}),undefined));
test('one tool retains definition', () => assert.equal(prep([host('z')])[0].function.name,'z'));
test('duplicate names retain order and all definitions, with diagnostic', () => {
  const before = warnings.length;
  const output = prep([host('z'),host('a','first'),host('a','second')]);
  assert.deepEqual(names(output),['z','a','a']);
  assert.equal(output[1].function.description,'first');
  assert.equal(output[2].function.description,'second');
  assert.ok(warnings.slice(before).some(s => s.includes('TOOLS_ORDER_SKIPPED')));
});
for (const invalid of ['', undefined, 42]) test('invalid name preserves order: '+String(invalid), () => {
  const before=warnings.length;
  assert.deepEqual(names(prep([host('z'),host(invalid,'invalid'),host('a')])), ['z',invalid,'a']);
  assert.ok(warnings.slice(before).some(s => s.includes('TOOLS_ORDER_SKIPPED')));
});
test('Mermaid present and absent converge without losing tools', () => {
  const a=prep([host('z'),host('run_in_terminal'),host('a')]);
  const b=prep([host('renderMermaidDiagram','host version'),host('a'),host('z'),host('run_in_terminal')]);
  assert.equal(safeStringify(a),safeStringify(b));
  assert.deepEqual(names(a),['a','renderMermaidDiagram','run_in_terminal','z']);
});
test('limit checked after Mermaid insertion', () => assert.throws(()=>prepareRequestTools(1,{tools:[host('run_in_terminal')]})));
test('exact tool limit remains allowed', () => assert.equal(prepareRequestTools(3,{tools:rotated}).length,3));
test('tool addition and removal remain observable', () => {
  assert.notEqual(safeStringify(prep(pythonTools)),safeStringify(prep(pythonTools.slice(1))));
  assert.notEqual(safeStringify(prep(pythonTools)),safeStringify(prep([...pythonTools,host('new_tool')])));
});
test('description changes remain observable', () => assert.notEqual(safeStringify(prep([host('a','old')])),safeStringify(prep([host('a','new')]))));
test('schema changes remain observable', () => assert.notEqual(safeStringify(prep([host('a')])),safeStringify(prep([host('a','a',{type:'object',additionalProperties:false})]))));

// Replace only unrelated filtering and the network. Keep tool preparation,
// replay-scope construction, request assembly, budget and serializer real.
const hooks = from('provider/chat-hooks.js');
const replay = from('provider/replay/host-summary.js');
const { prepareChatRequest } = from('provider/request.js');
const { makeFoldSummarize } = from('provider/fold-summarize.js');
const token = { isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}}) };
async function prepare(tools) {
  return prepareChatRequest({
    authManager:{getApiKey:async()=> 'test-placeholder'},globalStorageUri:{fsPath:tmp},
    modelInfo:{id:'deepseek-flash'},segment:{reason:'none'},
    messages:[{role:1,content:[new Text('stable task')]}],
    options:{requestInitiator:'github.copilot-chat',modelOptions:{_conversationId:'stable-test'},tools},token,
    cacheDiagnostics:{beginRequest:()=>({})},getVisionDescriber:()=>undefined,
  });
}
for (const mode of ['stream','complete','fold']) test('real prepare to HTTP body preserves canonical tools: '+mode, async t => {
  const scopes=[], bodies=[], errors=[];
  const buildScope=replay.buildReplayScope;
  t.mock.method(replay,'buildReplayScope',(...args)=>{scopes.push(args[2]);return buildScope(...args);});
  t.mock.method(hooks,'applyMessageFilter',async()=>{});
  t.mock.method(global,'fetch',async(_url,opts)=>{
    bodies.push(JSON.parse(opts.body));
    return {ok:true,status:200,json:async()=>({choices:[{finish_reason:'stop',message:{content:'summary'}}]}),
      body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));c.close();}})};
  });
  for (const tools of [rotated,pythonTools]) {
    const p=await prepare(tools);
    if(mode==='stream')await p.client.streamChatCompletion(p.request,{onContent(){},onThinking(){},onToolCall(){},onDone(){},onError:e=>errors.push(e)},token);
    else if(mode==='complete')await p.client.completeChat(p.request,1000,token);
    else await makeFoldSummarize(p.client,'deepseek-flash',token,p.request.tools)(p.request.messages);
  }
  assert.deepEqual(errors,[]);
  assert.equal(bodies.length,2);
  assert.deepEqual(names(bodies[0].tools),canonical);
  assert.equal(safeStringify(bodies[0].tools),safeStringify(bodies[1].tools));
  assert.equal(scopes.length,2);
  assert.equal(scopes[0],scopes[1]);
  assert.deepEqual(JSON.parse(scopes[0])[1],bodies[0].tools);
});
