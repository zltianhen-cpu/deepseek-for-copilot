// 用途：验证会话路径从真实请求组装到模拟 HTTP、响应还原与本地计数的完整往返。
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const load = Module._load;
const vscodeStub = {
  env: { language: 'en' },
  version: 'smoke',
  window: {
    createOutputChannel: () => ({ info() {}, error() {}, debug() {}, warn() {}, appendLine() {} }),
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_k, d) => d, inspect: () => ({}) }),
  },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
  LanguageModelTextPart: class LanguageModelTextPart { constructor(value) { this.value = value; } },
  LanguageModelDataPart: class LanguageModelDataPart { constructor(data, mimeType) { this.data = data; this.mimeType = mimeType; } },
  LanguageModelThinkingPart: class LanguageModelThinkingPart { constructor(value) { this.value = value; } },
  LanguageModelToolCallPart: class LanguageModelToolCallPart {
    constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; }
  },
  LanguageModelToolResultPart: class LanguageModelToolResultPart {
    constructor(callId, content) { this.callId = callId; this.content = content; }
  },
};
Module._load = function (id, ...args) {
  if (id === 'vscode') return vscodeStub;
  return load.call(this, id, ...args);
};

const compiledRoot = process.env.CACHE_EXTENSION_TEST_DIR || path.join(__dirname, '..');
function compiled(rel) {
  const p = path.join(compiledRoot, rel);
  if (!fs.existsSync(p)) throw new Error('缺编译产物 ' + rel);
  return p;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-effect-'));
const tmpData = path.join(tmpRoot, 'data');
process.env.DEEPSEEK_DIAG_DIR = path.join(tmpRoot, 'diag');
fs.mkdirSync(tmpData, { recursive: true });
process.env.DEEPSEEK_DATA_DIR = tmpData;
process.env.DEEPSEEK_INDEX_PATH = path.join(tmpData, 'index.json');
process.env.DEEPSEEK_HOOK_DIR = path.join(compiledRoot, 'resources', 'hooks');
process.env.DEEPSEEK_SCENE_POLICY_PATH = path.join(tmpData, 'scene-policy.json');
fs.writeFileSync(process.env.DEEPSEEK_SCENE_POLICY_PATH, JSON.stringify({ enabled: false }));


process.env.DEEPSEEK_AUTOBUILD_OFF = '1';
// 只隔离与本测试无关的技能筛选，真实转换、出站、HTTP 和响应处理仍完整执行。
require(compiled('out/provider/chat-hooks.js')).applyMessageFilter = async () => {};
const { prepareChatRequest } = require(compiled('out/provider/request.js'));
after(() => { Module._load = load; fs.rmSync(tmpRoot, {recursive:true,force:true}); });

test('P7b 外来名字经 prepare、HTTP、响应工具与日志完整往返', async (t) => {
  const Text = vscodeStub.LanguageModelTextPart;
  const real = 'debug-logs/11111111-1111-1111-1111-111111111111';
  const foreign = 'debug-logs/__copilot_session_99__';
  const local = 'debug-logs/__copilot_session_1__';
  const token = {isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})};
  const diag = new Proxy({}, {get:()=>()=>{}});
  const events = require(compiled('out/provider/request-events.js'));
  events.setDiagnosticsMode('verbose');
  const input = [{role:3,content:[new Text(real)]},{role:1,content:[new Text(foreign+' __copilot_session_')]}];
  const before = JSON.stringify(input);
  const prepared = await prepareChatRequest({
    authManager:{getApiKey:async()=> 'test-placeholder'},globalStorageUri:{fsPath:path.join(tmpRoot,'storage')},
    modelInfo:{id:'deepseek-flash'},segment:{reason:'none'},messages:input,
    options:{tools:[{name:'read_file',description:'Read',inputSchema:{type:'object'}}]},token,
    cacheDiagnostics:{beginRequest:()=>diag},getVisionDescriber:()=>undefined,
  });
  assert.equal(JSON.stringify(input),before);
  let sent;
  const chunks = [];
  for (const text of [local.slice(0,25),local.slice(25)]) chunks.push({choices:[{index:0,delta:{reasoning_content:text},finish_reason:null}]});
  for (const text of [local.slice(0,25),local.slice(25)+' '+foreign]) chunks.push({choices:[{index:0,delta:{content:text},finish_reason:null}]});
  chunks.push({choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_keep',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:local,external:foreign})}}]},finish_reason:'tool_calls'}]});
  t.mock.method(global,'fetch',async (_url,opts)=>{
    sent=opts.body;let read=false;return {ok:true,status:200,body:{getReader:()=>({read:async()=>{
      if(read)return {done:true};read=true;return {done:false,value:new TextEncoder().encode(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n')};
    }})}};
  });
  const parts=[];
  await require(compiled('out/provider/stream.js')).streamChatCompletion({prepared,progress:{report:p=>parts.push(p)},token,getCharsPerToken:()=>4,setCharsPerToken(){}});
  assert.ok(sent.includes(local));assert.ok(!sent.includes(real));assert.ok(sent.includes(foreign));assert.ok(!sent.includes('normalizedPaths'));
  const emitted = parts.find(p=>p instanceof vscodeStub.LanguageModelToolCallPart);
  assert.equal(emitted.callId,'call_keep');assert.deepEqual(emitted.input,{path:real,external:foreign});
  const answer=parts.filter(p=>p instanceof Text).map(p=>p.value).join('');assert.ok(answer.includes(real));assert.ok(answer.includes(foreign));assert.ok(!answer.includes(local));
  const rows=events.readErrorSummary({requestId:prepared.requestId,includeInfo:true}).rows;
  for(const code of ['SESSION_PATH_NORMALIZED','SESSION_PATH_FOREIGN']) assert.equal(rows.find(r=>r.eventCode===code)?.itemCount,1);
  assert.ok(!JSON.stringify(rows).includes(real));assert.ok(!JSON.stringify(rows).includes(foreign));
  events.setDiagnosticsMode('minimal');
  events.recordRequestEvent('r-p7b-minimal','SESSION_PATH_NORMALIZED','main-agent',undefined,undefined,{itemCount:1});
  assert.equal(events.readErrorSummary({requestId:'r-p7b-minimal',includeInfo:true}).rows.length,0);
  events.setDiagnosticsMode('unknown');
});

test('P11 歧义工具在真实流处理拒绝且保留已收到文本', async (t) => {
  const Text = vscodeStub.LanguageModelTextPart;
  const real = 'debug-logs/11111111-1111-1111-1111-111111111111';
  const foreign = 'debug-logs/__copilot_session_1__';
  const local = 'debug-logs/__copilot_session_1__';
  const token = {isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})};
  const diag = new Proxy({}, {get:()=>()=>{}});
  const events = require(compiled('out/provider/request-events.js'));
  events.setDiagnosticsMode('verbose');
  const input = [{role:3,content:[new Text(real)]},{role:1,content:[new Text(foreign+' __copilot_session_')]}];
  const before = JSON.stringify(input);
  const prepared = await prepareChatRequest({
    authManager:{getApiKey:async()=> 'test-placeholder'},globalStorageUri:{fsPath:path.join(tmpRoot,'storage')},
    modelInfo:{id:'deepseek-flash'},segment:{reason:'none'},messages:input,
    options:{tools:[{name:'read_file',description:'Read',inputSchema:{type:'object'}}]},token,
    cacheDiagnostics:{beginRequest:()=>diag},getVisionDescriber:()=>undefined,
  });
  assert.equal(JSON.stringify(input),before);
  let sent;
  const chunks = [];
  for (const text of [local.slice(0,25),local.slice(25)]) chunks.push({choices:[{index:0,delta:{reasoning_content:text},finish_reason:null}]});
  for (const text of [local.slice(0,25),local.slice(25)+' '+foreign]) chunks.push({choices:[{index:0,delta:{content:text},finish_reason:null}]});
  chunks.push({choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_keep',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:local,external:foreign})}}]},finish_reason:'tool_calls'}]});
  t.mock.method(global,'fetch',async (_url,opts)=>{
    sent=opts.body;let read=false;return {ok:true,status:200,body:{getReader:()=>({read:async()=>{
      if(read)return {done:true};read=true;return {done:false,value:new TextEncoder().encode(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n')};
    }})}};
  });
  const parts=[];
  await assert.rejects(()=>require(compiled('out/provider/stream.js')).streamChatCompletion({prepared,progress:{report:p=>parts.push(p)},token,getCharsPerToken:()=>4,setCharsPerToken(){}}),/SESSION_PATH_AMBIGUOUS/);
  assert.ok(sent.includes(local));assert.ok(!sent.includes(real));
  assert.ok(!parts.some(p=>p instanceof vscodeStub.LanguageModelToolCallPart));
  assert.ok(parts.filter(p=>p instanceof Text).map(p=>p.value).join('').includes(local));
  events.setDiagnosticsMode('unknown');
});
