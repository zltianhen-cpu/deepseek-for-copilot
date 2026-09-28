// 用途：本地摘要交付真实 prepare/stream 管线的隔离测试，禁止网络及收费调用。
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-pipeline-test-'));
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
			new Text('Reading.'),
			new Call('call-a', 'read_file', { path: 'example.txt' }),
		],
	},
	{ role: 1, content: [new Result('call-a', [new Text('example content')])] },
	{ role: 1, content: [new Text('Retain cancellation instruction')] },
];
function summary(messages = prefix()) {
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


const folds = from('provider/fold-summarize.js');
const { streamChatCompletion } = from('provider/stream.js');
const { wrapFold } = from('provider/replay/summary-delivery.js');
const originalMake = folds.makeFoldSummarize;
const oldMode = process.env.DEEPSEEK_SUMMARY_DELIVERY;
let generated = 0, filterCalls = 0, commit = true;
folds.makeFoldSummarize = () => async () => { generated++; return 'Verified historical fold fixture'; };
const filter = async (messages, ctx) => {
 filterCalls++;
 const region = structuredClone(messages.slice(1,4));
 const text = await ctx.summarize(region);
 if(commit) messages.splice(1,3,{role:'user',content:wrapFold(text)});
};
after(() => { folds.makeFoldSummarize=originalMake; if(oldMode===undefined)delete process.env.DEEPSEEK_SUMMARY_DELIVERY;else process.env.DEEPSEEK_SUMMARY_DELIVERY=oldMode; });
let sequence=0;
function start(mode='passive_A') {
 process.env.DEEPSEEK_SUMMARY_DELIVERY=mode;
 hooks.applyMessageFilter=filter; generated=0;filterCalls=0;commit=true;
 return options('delivery-pipeline-'+(++sequence));
}
async function seeded(mode='passive_A') {const opts=start(mode); const main=await prepare(prefix(),opts);return {opts,main};}
async function stream(prepared,cancelled=false) {
 const reports=[];let remote=0,ratio=0;
 prepared.client.streamChatCompletion=async()=>{remote++;throw new Error('unexpected remote call');};
 await streamChatCompletion({prepared,progress:{report:p=>reports.push(p)},token:{isCancellationRequested:cancelled,onCancellationRequested:()=>({dispose(){}})},getCharsPerToken:()=>4,setCharsPerToken:()=>ratio++});
 return {reports,remote,ratio};
}
test('real main prepare captures only committed fold',async()=>{const {opts,main}=await seeded();assert.equal(generated,1);assert.equal(main.localDelivery,undefined);const result=await prepare(summary(),opts);assert.ok(result.localDelivery);assert.equal(filterCalls,1);});
test('real stream emits summary text only without remote or fake usage',async()=>{const {opts}=await seeded();const result=await prepare(summary(),opts);assert.ok(result.localDelivery);const {reports,remote,ratio}=await stream(result);assert.equal(remote,0);assert.equal(ratio,0);assert.equal(reports.length,1);assert.ok(reports[0] instanceof Text);assert.ok(reports[0].value.startsWith('<summary>'));assert.ok(reports[0].value.includes('Retain cancellation instruction'));});
test('cancelled local stream emits nothing and never calls remote',async()=>{const {opts}=await seeded();const result=await prepare(summary(),opts);assert.ok(result.localDelivery);const reports=[];let remote=0;result.client.streamChatCompletion=async()=>{remote++;};await assert.rejects(streamChatCompletion({prepared:result,progress:{report:x=>reports.push(x)},token:{isCancellationRequested:true},getCharsPerToken:()=>4,setCharsPerToken(){}}),/cancel/i);assert.deepEqual(reports,[]);assert.equal(remote,0);});
test('off mode follows existing host summary path',async()=>{const {opts}=await seeded('off');assert.equal((await prepare(summary(),opts)).localDelivery,undefined);});
test('shadow records candidates without returning local response',async()=>{const {opts}=await seeded('shadow');assert.equal((await prepare(summary(),opts)).localDelivery,undefined);});
test('foreign conversation cannot consume candidate',async()=>{await seeded();assert.equal((await prepare(summary(),options('foreign-delivery'))).localDelivery,undefined);});
test('tool schema change prevents local delivery',async()=>{const {opts}=await seeded();opts.tools[0].description='Different tool schema';assert.equal((await prepare(summary(),opts)).localDelivery,undefined);});
test('generated but uncommitted fold cannot be delivered',async()=>{const opts=start();commit=false;await prepare(prefix(),opts);assert.equal(generated,1);assert.equal((await prepare(summary(),opts)).localDelivery,undefined);});
test('ordinary continuation never gets local summary delivery',async()=>{const {opts}=await seeded();const next=await prepare([...prefix(),{role:1,content:[new Text('continue normal work')]}],opts);assert.equal(next.localDelivery,undefined);});
test('edited history falls back despite same session',async()=>{const {opts}=await seeded();const h=prefix();h[1]={role:1,content:[new Text('cancel the earlier request')]};assert.equal((await prepare(summary(h),opts)).localDelivery,undefined);});
test('new tail preserved verbatim inside local summary',async()=>{const {opts}=await seeded();const h=[...prefix(),{role:1,content:[new Text('LATEST: cancel all edits')]}];const result=await prepare(summary(h),opts);assert.ok(result.localDelivery);assert.ok(result.localDelivery.text.includes('LATEST: cancel all edits'));});
test('cancelled prepare never issues local delivery',async()=>{const {opts}=await seeded();const result=await prepare(summary(),opts,{token:{isCancellationRequested:true,onCancellationRequested:()=>({dispose(){}})}});assert.equal(result.localDelivery,undefined);});
test('missing reasoning marker falls back instead of relaxing identity',async()=>{const opts=start();const h=prefix();h[2].content.unshift(createReplayMarkerPart({reasoningText:'private historical reasoning',segmentId:'11111111-1111-4111-8111-111111111111'}));await prepare(h,opts);const result=await prepare(summary(h),opts);assert.equal(result.localDelivery,undefined);});

test('pipeline rejects committed projection that splits a tool pair',async()=>{const opts=start();hooks.applyMessageFilter=async(messages,ctx)=>{const text=await ctx.summarize(structuredClone(messages.slice(1,3)));messages.splice(1,2,{role:'user',content:wrapFold(text)});};await prepare(prefix(),opts);assert.equal((await prepare(summary(),opts)).localDelivery,undefined);});

// Follow the actual delivery with a host-assembled history; inspect only context passed to real hooks.
async function sentFixture() {
 const {opts}=await seeded();
 const prepared=await prepare(summary(),opts);
 assert.ok(prepared.localDelivery);
 await stream(prepared);
 const h=prefix();
 return {opts,prepared,assembled:[h[0],{role:1,content:[new Text('<conversation-summary>\n'+prepared.localDelivery.body+'\n</conversation-summary>')]},...h.slice(4)]};
}
async function observeContext(history,opts,extra={}) {
 const contexts=[];
 hooks.applyMessageFilter=async(_messages,ctx)=>{contexts.push({sessionKey:ctx.sessionKey,managedHostSummary:ctx.managedHostSummary});};
 const result=await prepare(history,opts,extra);
 assert.equal(result.localDelivery,undefined);
 assert.equal(contexts.length,1);
 return contexts[0];
}
function assertUnmanaged(ctx) {assert.equal(ctx.sessionKey,undefined);assert.equal(ctx.managedHostSummary,false);}
test('adopted host assembly switches to isolated stable fold generation',async()=>{
 const {opts,prepared,assembled}=await sentFixture();
 const first=await observeContext(assembled,opts);
 assert.equal(first.managedHostSummary,true);
 assert.match(first.sessionKey,/^host-adopted:[a-f0-9]{64}:[a-f0-9]{64}$/);
 assert.ok(first.sessionKey.endsWith(':'+prepared.localDelivery.id));
 const continuation=[...assembled,{role:1,content:[new Text('NEW: keep later task')]}];
 const next=await observeContext(continuation,opts);
 assert.equal(next.sessionKey,first.sessionKey);
 assert.equal(next.managedHostSummary,true);
 const record=JSON.parse(fs.readFileSync(path.join(tmp,'summary-delivery-v1',prepared.localDelivery.id+'.json'),'utf8')).entry;
 assert.equal(record.state,'adopted');
 assert.equal(record.actualTailKeys.length,2);
});
test('sent pending ordinary continuation does not change fold generation',async()=>{
 const {opts}=await sentFixture();assertUnmanaged(await observeContext(prefix(),opts));
});
test('prepared but unsent host-looking body does not switch generation',async()=>{
 const {opts}=await seeded();const prepared=await prepare(summary(),opts);assert.ok(prepared.localDelivery);
 const h=prefix();const assembled=[h[0],{role:1,content:[new Text('<conversation-summary>'+prepared.localDelivery.body+'</conversation-summary>')]},...h.slice(4)];
 assertUnmanaged(await observeContext(assembled,opts));
});
test('unknown host summary body does not switch generation',async()=>{
 const {opts,assembled}=await sentFixture();assembled[1]={role:1,content:[new Text('<conversation-summary>unrelated host-written body</conversation-summary>')]};assertUnmanaged(await observeContext(assembled,opts));
});
test('other session cannot adopt sent summary generation',async()=>{
 const {assembled}=await sentFixture();assertUnmanaged(await observeContext(assembled,options('foreign-adoption-'+sequence)));
});
test('changed system prefix prevents generation adoption',async()=>{
 const {opts,assembled}=await sentFixture();assembled[0]={role:3,content:[new Text('You are an expert AI programming assistant. CHANGED instructions.')]};assertUnmanaged(await observeContext(assembled,opts));
});
test('missing retained cancellation prevents generation adoption',async()=>{
 const {opts,assembled}=await sentFixture();assembled.pop();assertUnmanaged(await observeContext(assembled,opts));
});
test('shadow mode cannot switch generation from an earlier sent delivery',async()=>{
 const {opts,assembled}=await sentFixture();process.env.DEEPSEEK_SUMMARY_DELIVERY='shadow';assertUnmanaged(await observeContext(assembled,opts));
});
test('off mode cannot switch generation from an earlier sent delivery',async()=>{
 const {opts,assembled}=await sentFixture();process.env.DEEPSEEK_SUMMARY_DELIVERY='off';assertUnmanaged(await observeContext(assembled,opts));
});
test('cancelled follow-up cannot switch generation',async()=>{
 const {opts,assembled}=await sentFixture();assertUnmanaged(await observeContext(assembled,opts,{token:{isCancellationRequested:true,onCancellationRequested:()=>({dispose(){}})}}));
});
test('editing appended history after adoption cannot reuse active generation',async()=>{
 const {opts,assembled}=await sentFixture();
 const extended=[...assembled,{role:1,content:[new Text('new task AFTER adoption')]}];
 const accepted=await observeContext(extended,opts);assert.equal(accepted.managedHostSummary,true);
 const edited=[...assembled,{role:1,content:[new Text('CHANGED task AFTER adoption')]}];
 assertUnmanaged(await observeContext(edited,opts));
 assertUnmanaged(await observeContext(assembled,opts));
});
