// 用途：在真实HTTP边界验证回执与用量；替换fetch，不触网。
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'receipt-'));process.env.DEEPSEEK_DIAG_DIR=tmp;
require('node:test').after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
const old=Module._load;Module._load=function(id,...a){if(id==='vscode')return {env:{language:'en'},window:{createOutputChannel:()=>({info(){},error(){},warn(){},debug(){}})}};return old.call(this,id,...a)};
const root=process.env.CACHE_EXTENSION_TEST_DIR||path.join(__dirname,'..');
const {DeepSeekClient}=require(path.join(root,'out/client/core.js'));
const budget=require(path.join(root,'out/request-budget.js')),events=require(path.join(root,'out/provider/request-events.js'));
const receipts=fs.existsSync(path.join(root,'out/send-receipt.js'))?require(path.join(root,'out/send-receipt.js')):{};
const usage={prompt_tokens:100,completion_tokens:8,prompt_cache_hit_tokens:60,prompt_cache_miss_tokens:40};
function request(id,limit=655360){assert.equal(typeof receipts.bindRequestTrace,'function');return receipts.bindRequestTrace(budget.bindRequestBudget({model:'fixture',stream:false,messages:[{role:'user',content:'PRIVATE HISTORY'}],max_tokens:100},{...budget.DEFAULT_BUDGET_POLICY,maxInputTokens:limit}),{requestId:id,requestKind:'summary',parentRequestId:'parent'});}
function rows(id){return events.readErrorSummary({requestId:id,includeInfo:true}).rows;}
for(const method of ['complete','stream'])for(const mode of ['ok','no-usage','network','blocked','cancelled'])test(method+' '+mode,async t=>{
 const id=events.newRequestId(),r=request(id,mode==='blocked'?1:655360),client=new DeepSeekClient('https://example.invalid','PRIVATE KEY');let wire,errors=[];
 const send=t.mock.method(global,'fetch',async(u,o)=>{wire=o.body;if(mode==='network')throw Error('PRIVATE FAILURE');return {ok:true,status:200,json:async()=>({choices:[{finish_reason:'stop',message:{content:'summary'}}],...(mode==='no-usage'?{}:{usage})}),body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode((mode==='no-usage'?'':'data: '+JSON.stringify({choices:[],usage})+'\n\n')+'data: [DONE]\n\n'));c.close()}})}});
 const token={isCancellationRequested:mode==='cancelled',onCancellationRequested:()=>({dispose(){}})};
 if(method==='complete'){if(['network','blocked','cancelled'].includes(mode))await assert.rejects(client.completeChat(r,1000,token));else await client.completeChat(r,1000,token)}
 else await client.streamChatCompletion(r,{onContent(){},onThinking(){},onToolCall(){},onDone(){},onError(e){errors.push(e)}},token);
 const result=rows(id),sent=!['blocked','cancelled'].includes(mode);
 assert.equal(send.mock.callCount(),sent?1:0);assert.equal(result.filter(x=>x.eventCode==='SEND_ATTEMPT').length,sent?1:0);
 assert.equal(result.filter(x=>x.eventCode==='USAGE_OBSERVED').length,mode==='ok'?1:0);
 assert.equal(result.filter(x=>x.eventCode==='USAGE_UNAVAILABLE').length,sent&&mode!=='ok'?1:0);
 if(sent){const candidate=result.find(x=>x.eventCode==='WIRE_CANDIDATE');assert.equal(candidate.wireHash,require('node:crypto').createHash('sha256').update(wire).digest('hex'));assert.ok(result.every(x=>x.parentRequestId==='parent'));}
 assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('truncated response仍记录真实usage，不宣称无用量',async t=>{const id=events.newRequestId(),r=request(id);t.mock.method(global,'fetch',async()=>({ok:true,status:200,json:async()=>({usage,choices:[{finish_reason:'length',message:{content:'partial'}}]})}));await assert.rejects(new DeepSeekClient('https://example.invalid','key').completeChat(r,1000));const result=rows(id);assert.equal(result.filter(x=>x.eventCode==='USAGE_OBSERVED').length,1);assert.ok(!result.some(x=>x.eventCode==='USAGE_UNAVAILABLE'));});
for(const cancel of [false,true])test('usage出现后中断仍记真实已观察用量 '+cancel,async t=>{
 const id=events.newRequestId(),r=request(id),token={isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})};let n=0;
 t.mock.method(global,'fetch',async()=>({ok:true,status:200,body:{getReader:()=>({read:async()=>{if(n++===0)return {done:false,value:new TextEncoder().encode('data: '+JSON.stringify({choices:[],usage})+'\n\n')};token.isCancellationRequested=cancel;throw Object.assign(Error('interrupted'),{name:cancel?'AbortError':'Error'});}})}}));
 await new DeepSeekClient('https://example.invalid','key').streamChatCompletion(r,{onContent(){},onThinking(){},onToolCall(){},onDone(){},onError(){}},token);
 const result=rows(id);assert.equal(result.filter(x=>x.eventCode==='USAGE_OBSERVED').length,1);assert.ok(!result.some(x=>x.eventCode==='USAGE_UNAVAILABLE'));
});
