// 用途：宿主摘要丢失附件时，核验真实 prepare 管线、历史保护和会话隔离。
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-summary-test-'));
process.env.DEEPSEEK_DATA_DIR = tmp;
process.env.DEEPSEEK_AUTOBUILD_OFF = '1';
const root = process.env.CACHE_EXTENSION_TEST_DIR || path.join(__dirname, '..');
process.env.DEEPSEEK_HOOK_DIR = path.join(root, 'resources/hooks');
const Text = class {
	constructor(value) {
		this.value = value;
	}
};
const Data = class {
	constructor(data, mimeType) {
		Object.assign(this, { data, mimeType });
	}
};
const Thinking = class {
	constructor(value) {
		this.value = value;
	}
};
const Call = class {
	constructor(callId, name, input) {
		Object.assign(this, { callId, name, input });
	}
};
const Result = class {
	constructor(callId, content) {
		Object.assign(this, { callId, content });
	}
};
const vscode = {
	env: { language: 'en' },
	version: 'smoke',
	window: {
		createOutputChannel: () => ({ info() {}, debug() {}, error() {}, warn() {}, appendLine() {} }),
	},
	workspace: {
		workspaceFolders: [],
		getConfiguration: () => ({ get: (_k, d) => d, inspect: () => ({}) }),
	},
	Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
	LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
	LanguageModelTextPart: Text,
	LanguageModelDataPart: Data,
	LanguageModelThinkingPart: Thinking,
	LanguageModelToolCallPart: Call,
	LanguageModelToolResultPart: Result,
};
const load = Module._load;
Module._load = function (id, ...args) {
	return id === 'vscode' ? vscode : load.call(this, id, ...args);
};
const from = (p) => require(path.join(root, 'out', p));
const _routing = from('provider/routing/classifier.js');
const hooks = from('provider/chat-hooks.js');
const { createReplayMarkerPart } = from('provider/replay/index.js');
const { prepareChatRequest } = from('provider/request.js');
const originalFilter = hooks.applyMessageFilter;
after(() => {
	hooks.applyMessageFilter = originalFilter;
	fs.rmSync(tmp, { recursive: true, force: true });
});
const SUMMARY =
	'The conversation has grown too large for the context window and must be compacted now.\n\nCreate a comprehensive summary.\nIMPORTANT: Output your summary wrapped in <summary> and </summary> tags. Do NOT call any tools. Your ONLY task right now is to produce a comprehensive summary of the conversation so far.';
const prefix = () => [
	{
		role: 3,
		content: [new Text('You are an expert AI programming assistant. Stable instructions.')],
	},
	{ role: 1, content: [new Text('Read the example file.')] },
	{
		role: 2,
		content: [
			createReplayMarkerPart({
				reasoningText: '先核对文件，保持原文\n完整。',
				segmentId: '11111111-1111-4111-8111-111111111111',
			}),
			new Text('Reading.'),
			new Call('call-a', 'read_file', { path: 'example.txt' }),
		],
	},
	{ role: 1, content: [new Result('call-a', [new Text('example content')])] },
];
function _summary(messages = prefix()) {
	return [
		...messages.map((m) => ({ ...m, content: m.content.filter((p) => !(p instanceof Data)) })),
		{ role: 1, content: [new Text(SUMMARY)] },
	];
}
function options(id = 'conversation-a') {
	return {
		requestInitiator: 'github.copilot-chat',
		modelOptions: { _conversationId: id },
		tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }],
	};
}
function prepare(messages, opts = options(), extra = {}) {
	return prepareChatRequest({
		authManager: { getApiKey: async () => 'placeholder-test-key' },
		globalStorageUri: { fsPath: tmp },
		modelInfo: { id: 'deepseek-flash' },
		segment: { reason: 'markerMissing', segmentId: '22222222-2222-4222-8222-222222222222' },
		messages,
		options: opts,
		token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
		cacheDiagnostics: { beginRequest: () => ({}) },
		getVisionDescriber: async () => undefined,
		...extra,
	});
}


const config=from('config.js');
for(const effort of ['none','low','high','max'])test('real prepare passes parent mode '+effort,async t=>{
 const wires=[];t.mock.method(config,'getBaseUrl',()=> 'https://api.deepseek.com');
 t.mock.method(global,'fetch',async(_u,o)=>{wires.push(JSON.parse(o.body));return {ok:true,status:200,json:async()=>({usage:{prompt_tokens:100,completion_tokens:12,total_tokens:112,completion_tokens_details:{reasoning_tokens:7}},choices:[{finish_reason:'stop',message:{content:'summary'}}]})}});
 let usage;t.mock.method(hooks,'logUsage',r=>{usage=r});
 t.mock.method(hooks,'applyMessageFilter',async(m,ctx)=>{assert.equal(await ctx.summarize([m[1]],{prefixMessages:m,tools:ctx.tools,protectedPrefixCount:ctx.protectedPrefixCount}),'summary')});
 const opts=options('mode-'+effort);opts.modelOptions.reasoningEffort=effort;const prepared=await prepare(prefix(),opts);
 assert.equal(wires.length,1);assert.deepEqual(wires[0].thinking,prepared.request.thinking);assert.equal(wires[0].reasoning_effort,prepared.request.reasoning_effort);assert.equal(wires[0].tool_choice,prepared.request.tool_choice);assert.deepEqual(wires[0].tools,prepared.request.tools);assert.equal(usage.reasoning,7);
});
test('custom endpoint preserves legacy summary mode',async t=>{
 let wire;t.mock.method(config,'getBaseUrl',()=> 'https://custom.invalid');t.mock.method(global,'fetch',async(_u,o)=>{wire=JSON.parse(o.body);return {ok:true,status:200,json:async()=>({choices:[{finish_reason:'stop',message:{content:'summary'}}]})}});
 t.mock.method(hooks,'applyMessageFilter',async(m,ctx)=>{await ctx.summarize([m[1]],{prefixMessages:m,tools:ctx.tools})});await prepare(prefix(),options('custom-mode'));
 assert.equal(wire.thinking.type,'disabled');assert.equal(wire.tool_choice,'none');assert.equal(wire.reasoning_effort,undefined);
});
