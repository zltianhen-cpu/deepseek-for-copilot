// 用途：本地诊断隐私、筛选与真实摘要发送回归；不访问网络。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'request-events-'));
process.env.DEEPSEEK_DIAG_DIR = tmp;
const workspace = {getConfiguration:()=>({get:(_k,d)=>d})};
const old = Module._load;
Module._load = function(id, ...args) { if(id === 'vscode') return {env:{language:'en'},workspace,window:{createOutputChannel:()=>({info(){},warn(){},error(){},debug(){}})},LanguageModelDataPart:class{},LanguageModelTextPart:class{}}; return old.call(this,id,...args); };
const compiledRoot=process.env.CACHE_EXTENSION_TEST_DIR||path.join(__dirname,'..');
const location = path.join(compiledRoot,'out/provider/request-events');
assert.ok(fs.existsSync(location+'.js'), 'request events adapter must exist');
const rawApi = require(location);
const api = {...rawApi, readErrorSummary: (f) => { const r=rawApi.readErrorSummary(f); return r.rows || r; }};
let passed=0;
async function check(name, f) { await f(); console.log('PASS '+name); passed++; }
(async()=>{
await check('query status explicit',()=>assert.equal(rawApi.readErrorSummary().status,'ok'));
await check('empty data',()=>assert.equal(api.readErrorSummary().length,0));
const id=api.newRequestId();
await check('unique IDs',()=>assert.notEqual(id,api.newRequestId()));
await check('failure metadata only',()=>{api.recordRequestEvent(id,'REQUEST_SEND_FAILED','main-agent');assert.equal(api.readErrorSummary({requestId:id})[0].eventCode,'REQUEST_SEND_FAILED');});
await check('event filter',()=>assert.equal(api.readErrorSummary({eventCode:'NO_SUCH_EVENT'}).length,0));
await check('time filter',()=>assert.equal(api.readErrorSummary({since:'2099-01-01T00:00:00Z'}).length,0));
await check('invalid time rejects',()=>assert.throws(()=>api.readErrorSummary({since:'bad'})));
await check('disabled',()=>{process.env.DEEPSEEK_DIAG_DISABLE='1';api.recordRequestEvent('r-disabled','REQUEST_SEND_FAILED','main-agent');delete process.env.DEEPSEEK_DIAG_DISABLE;assert.equal(api.readErrorSummary({requestId:'r-disabled'}).length,0);});
await check('sensitive content excluded',()=>{fs.writeFileSync(path.join(tmp,'host-fixture.jsonl'),JSON.stringify({timestampUtc:new Date().toISOString(),eventCode:'REQUEST_SEND_FAILED',requestId:'r-safe',category:'request',details:{body:'SECRET'},error:'SECRET',response:'SECRET'})+'\n');assert.ok(!JSON.stringify(api.readErrorSummary()).includes('SECRET'));});
await check('bad directory isolated',()=>{process.env.DEEPSEEK_DIAG_DIR=path.join(tmp,'host-fixture.jsonl');assert.doesNotThrow(()=>api.recordRequestEvent('r-bad','REQUEST_SEND_FAILED','main-agent'));assert.deepEqual(api.readErrorSummary(),[]);process.env.DEEPSEEK_DIAG_DIR=tmp;});
await check('real summary send retains payload and links IDs',async()=>{const {makeFoldSummarize,buildFoldSummaryRequest}=require(path.join(compiledRoot,'out/provider/fold-summarize'));const messages=[{role:'user',content:'SECRET'}];let sent;const summarize=makeFoldSummarize({completeChat:async(req)=>{sent=JSON.stringify(req);return 'SECRET RESPONSE';}},'model',undefined,undefined,id);assert.equal(await summarize(messages),'SECRET RESPONSE');assert.equal(sent,JSON.stringify(buildFoldSummaryRequest('model',messages)));const rows=api.readErrorSummary({requestId:id,includeInfo:true});const summary=rows.filter(r=>r.requestKind==='summary');assert.ok(summary.some(r=>r.eventCode==='PREPARE'));assert.ok(!summary.some(r=>r.eventCode==='SEND_ATTEMPT'));assert.ok(!summary.some(r=>r.eventCode==='USAGE_UNAVAILABLE'));assert.ok(summary.every(r=>r.parentRequestId===id && r.requestId!==id));assert.ok(!JSON.stringify(rows).includes('SECRET'));});
await check('summary failure recorded',async()=>{const {makeFoldSummarize}=require(path.join(compiledRoot,'out/provider/fold-summarize'));assert.equal(await makeFoldSummarize({completeChat:async()=>{throw Error('SECRET');}},'model',undefined,undefined,id)([]),'');assert.ok(api.readErrorSummary({requestId:id}).some(r=>r.requestKind==='summary'&&r.eventCode==='PREPARE'));});

await check('hooks disabled',()=>{process.env.DEEPSEEK_HOOKS_OFF='1';api.recordRequestEvent('r-off','REQUEST_SEND_FAILED','main-agent');delete process.env.DEEPSEEK_HOOKS_OFF;assert.equal(api.readErrorSummary({requestId:'r-off'}).length,0);});
for(const mode of ['usage','no-usage','failure']) await check('real stream '+mode,async()=>{
 const {DeepSeekClient}=require(path.join(compiledRoot,'out/client/core')); const {streamChatCompletion}=require(path.join(compiledRoot,'out/provider/stream'));
 const request={model:'model',stream:true,messages:[{role:'user',content:'PRIVATE BODY'}]};
 const requestId=api.newRequestId();const b=require(path.join(compiledRoot,'out/request-budget'));b.bindRequestBudget(request,b.DEFAULT_BUDGET_POLICY);require(path.join(compiledRoot,'out/send-receipt')).bindRequestTrace(request,{requestId,requestKind:'main-agent'});let body; const originalFetch=global.fetch;
 global.fetch=async(_url,opts)=>{body=opts.body;if(mode==='failure')throw Error('PRIVATE FAILURE');let done=false;return {ok:true,body:{getReader:()=>({read:async()=>{if(done)return {done:true};done=true;return {done:false,value:new TextEncoder().encode((mode==='usage'?'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})+'\n\n':'')+'data: [DONE]\n\n')};}})}};};
 const diag=new Proxy({}, {get:()=>()=>{}});
 const prepared={requestId,request,client:new DeepSeekClient('https://example.invalid','PRIVATE KEY'),requestKind:'main-agent',cacheDiagnostics:diag,trailingToolResultIds:[],replayMarkerMetadata:{},totalRequestChars:12};
 try {const result=streamChatCompletion({prepared,progress:{report(){}},token:{isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})},getCharsPerToken:()=>4,setCharsPerToken(){}}); if(mode==='failure') await assert.rejects(result); else await result;}
 finally{global.fetch=originalFetch;}
 assert.equal(body,JSON.stringify({...request,stream_options:{include_usage:true}}));
 const rows=api.readErrorSummary({requestId,includeInfo:true});assert.ok(rows.some(r=>r.eventCode==='SEND_ATTEMPT'));
 assert.ok(rows.some(r=>r.eventCode===(mode==='usage'?'USAGE_OBSERVED':'USAGE_UNAVAILABLE')));
 if(mode==='usage'){const observed=rows.find(r=>r.eventCode==='USAGE_OBSERVED');assert.equal(observed.input,10);assert.equal(observed.output,2);}
 assert.equal(rows.some(r=>r.eventCode==='REQUEST_SEND_FAILED'),mode==='failure');assert.ok(!JSON.stringify(rows).includes('PRIVATE'));
});
await check('query reports missing directory',()=>{process.env.DEEPSEEK_DIAG_DIR=path.join(tmp,'missing');assert.equal(rawApi.readErrorSummary().status,'missing');process.env.DEEPSEEK_DIAG_DIR=tmp;});
await check('query reports bad lines',()=>{fs.writeFileSync(path.join(tmp,'host-bad.jsonl'),'broken\n');assert.equal(rawApi.readErrorSummary().badLines,1);});
await check('usage whitelist and provenance',()=>{const rid=api.newRequestId();api.recordRequestEvent(rid,'USAGE_OBSERVED','main-agent',undefined,{input:10,output:2,hit:7,miss:3,body:'SECRET'});const row=api.readErrorSummary({requestId:rid})[0];assert.equal(row.input,10);assert.equal(row.hit,7);assert.ok(row.siteId);assert.ok(row.extensionVersion);assert.match(row.hookHash,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(row).includes('SECRET'));});
await check('workspace identity stable and unknown stays empty',()=>{const hooks=require(path.join(compiledRoot,'out/provider/chat-hooks'));assert.equal(hooks.workspaceIdentity(),'');workspace.workspaceFolders=[{uri:{toString:()=> 'file:///fixture-a'}}];const a=hooks.workspaceIdentity();assert.ok(a);assert.equal(a,hooks.workspaceIdentity());workspace.workspaceFolders=[{uri:{toString:()=> 'file:///fixture-b'}}];assert.notEqual(a,hooks.workspaceIdentity());delete workspace.workspaceFolders;});
await check('query reports read errors and truncation',()=>{process.env.DEEPSEEK_DIAG_DIR=path.join(tmp,'host-fixture.jsonl');assert.equal(rawApi.readErrorSummary().status,'unreadable');process.env.DEEPSEEK_DIAG_DIR=tmp;for(let i=0;i<70;i++)fs.writeFileSync(path.join(tmp,'host-extra-'+i+'.jsonl'),'');assert.ok(rawApi.readErrorSummary().truncated>0);});
console.log(`${passed} fixtures passed`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{fs.rmSync(tmp,{recursive:true,force:true});});
