// 用途：预算与真实 HTTP 边界测试；只替换网络，不替换预算实现。
'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const Module=require('node:module');
const load=Module._load;
Module._load=function(id,...args){if(id==='vscode')return {env:{language:'en'},window:{createOutputChannel:()=>({info(){},warn(){},error(){},debug(){}})}};return load.call(this,id,...args)};
const root=process.env.CACHE_EXTENSION_TEST_DIR || path.join(__dirname,'..');
const budgetPath=path.join(root,'out/request-budget.js');
const budget=fs.existsSync(budgetPath)?require(budgetPath):{};
const {DeepSeekClient}=require(path.join(root,'out/client/core.js'));
const client=new DeepSeekClient('https://example.invalid','test-placeholder');
const req=(text='hi')=>budget.bindRequestBudget({model:'unknown-model',stream:false,messages:[{role:'user',content:text}],max_tokens:100},budget.DEFAULT_BUDGET_POLICY);
const policy={maxInputTokens:1000,maxContextTokens:2000,maxOutputTokens:1000,imageTokens:200};
function assess(r,p=policy){assert.equal(typeof budget.assessRequestBudget,'function','必须存在共享预算能力');return budget.assessRequestBudget(r,p)}
function callbacks(errors){return {onContent(){},onThinking(){},onToolCall(){},onDone(){},onError:e=>errors.push(e)}}
function intercept(t){return t.mock.method(global,'fetch',async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'ok'}}]}),body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));c.close()}})}))}
for(const method of ['completeChat','streamChatCompletion'])test(method+' 超预算零 fetch 且原文不变',async t=>{
 const send=intercept(t),r=req('x'.repeat(1100000)),before=JSON.stringify(r),errors=[];
 if(method==='completeChat')await assert.rejects(client.completeChat(r,1000));else {await client.streamChatCompletion(r,callbacks(errors));assert.equal(errors.length,1)}
 assert.equal(send.mock.callCount(),0);assert.equal(JSON.stringify(r),before);
});
for(const method of ['completeChat','streamChatCompletion'])test(method+' 已取消零 fetch',async t=>{
 const send=intercept(t),token={isCancellationRequested:true,onCancellationRequested:()=>({dispose(){}})},errors=[];
 if(method==='completeChat')await assert.rejects(client.completeChat(req(),1000,token));else await client.streamChatCompletion(req(),callbacks(errors),token);
 assert.equal(send.mock.callCount(),0);
});
test('边界恰好通过，超 1 阻断',()=>{
 const r=req(),a=assess(r);assert.equal(a.ok,true);
 assert.equal(assess(r,{...policy,maxInputTokens:a.estimatedInputTokens}).ok,true);
 assert.equal(assess(r,{...policy,maxInputTokens:a.estimatedInputTokens-1}).reason,'input-limit');
});
test('总上下文包含输出预留',()=>{
 const r=req(),a=assess(r);
 assert.equal(assess(r,{...policy,maxContextTokens:a.estimatedInputTokens+100}).ok,true);
 assert.equal(assess(r,{...policy,maxContextTokens:a.estimatedInputTokens+99}).reason,'context-limit');
});
test('输出超限阻断且省略时预留策略最大输出',()=>{
 assert.equal(assess({...req(),max_tokens:1001}).reason,'output-limit');
 const r=req();delete r.max_tokens;assert.equal(assess(r).outputTokens,policy.maxOutputTokens);
});
test('中文 Emoji 使用 UTF8 字节保守估算',()=>{
 const a=assess(req('a')),b=assess(req('中😀'));
 assert.equal(b.estimatedInputTokens-a.estimatedInputTokens,6);
 assert.equal(b.estimateMethod,'utf8-bytes-conservative-heuristic');assert.equal(b.isOfficialTokenCount,false);
});
test('工具 schema、工具调用参数与思考文本均占预算',()=>{
 const r=req();r.tools=[{type:'function',function:{name:'run',parameters:{description:'x'.repeat(1100)}}}];
 assert.equal(assess(r).reason,'input-limit');
 const r2=req();r2.messages[0].reasoning_content='x'.repeat(1100);assert.equal(assess(r2).ok,false);
 const r3=req();r3.messages.push({role:'assistant',content:'',tool_calls:[{id:'c',type:'function',function:{name:'run',arguments:'x'.repeat(1100)}}]});assert.equal(assess(r3).ok,false);
});
test('图片固定预留，与 base64 URL 长度无关',()=>{
 const r=req();r.messages[0].content=[{type:'image_url',image_url:{url:'data:image/png;base64,'+'a'.repeat(1000000)}}];
 const before=JSON.stringify(r),a=assess(r);r.messages[0].content[0].image_url.url='https://example.invalid/image.png';
 const b=assess(r);assert.equal(a.estimatedInputTokens,b.estimatedInputTokens);assert.equal(a.imageTokens,200);assert.equal(a.imageCount,1);assert.ok(before.length>1000000);
});
for(const n of [0,-1,NaN,Infinity,1.5])test('非法策略拒绝 '+n,()=>assert.throws(()=>assess(req(),{...policy,maxInputTokens:n}),{code:'invalid-request-budget'}));
test('非法输出预算拒绝',()=>{for(const n of [0,-1,Infinity,1.5])assert.throws(()=>assess({...req(),max_tokens:n}),{code:'invalid-request-budget'})});
test('确定幂等、冻结对象可检查且字节不变',()=>{
 const r=req('原文😀');Object.freeze(r.messages[0]);Object.freeze(r.messages);Object.freeze(r);
 const before=JSON.stringify(r);assert.deepEqual(assess(r),assess(r));assert.equal(JSON.stringify(r),before);
});
test('显式绑定模型预算、抛错有机器可读 code',()=>{
 assess(req());assert.deepEqual(budget.DEFAULT_BUDGET_POLICY,{maxInputTokens:655360,maxContextTokens:1048576,maxOutputTokens:393216,imageTokens:16384});
 assert.equal(budget.assessRequestBudget(req()).maxInputTokens,655360);
 assert.throws(()=>budget.assertRequestBudget(req('x'.repeat(2000)),policy),{code:'request-budget-exceeded'});
});
for(const method of ['completeChat','streamChatCompletion'])test(method+' 原请求绑定策略用于最终体，元数据不出网',async t=>{
 const send=intercept(t),r=req('x'.repeat(1500)),errors=[];assess(req());
 const original=JSON.stringify(r);assert.equal(budget.bindRequestBudget(r,policy),r);
 assert.equal(JSON.stringify(r),original);assert.deepEqual(budget.getRequestBudgetPolicy(r),policy);
 if(method==='completeChat')await assert.rejects(client.completeChat(r,1000));else {await client.streamChatCompletion(r,callbacks(errors));assert.equal(errors.length,1)}
 assert.equal(send.mock.callCount(),0);
});
for(const method of ['completeChat','streamChatCompletion'])test(method+' 检查最终序列化 toJSON 内容',async t=>{
 const send=intercept(t),r=req(),errors=[];
 r.messages[0].toJSON=()=>({role:'user',content:'x'.repeat(1100000)});
 if(method==='completeChat')await assert.rejects(client.completeChat(r,1000));else {await client.streamChatCompletion(r,callbacks(errors));assert.equal(errors.length,1)}
 assert.equal(send.mock.callCount(),0);
});
for(const method of ['completeChat','streamChatCompletion'])test(method+' 健康请求只发送一次且消息字节不变',async t=>{
 const send=intercept(t),r=req('hello 原文😀'),before=JSON.stringify(r.messages),errors=[];
 if(method==='completeChat')assert.equal(await client.completeChat(r,1000),'ok');else {await client.streamChatCompletion(r,callbacks(errors));assert.equal(errors.length,0)}
 assert.equal(send.mock.callCount(),1);assert.equal(JSON.stringify(JSON.parse(send.mock.calls[0].arguments[1].body).messages),before);
});
test('策略快照不可被调用方后续更改放宽',()=>{
 assess(req());const p={...policy},r=req('x'.repeat(1500));budget.bindRequestBudget(r,p);p.maxInputTokens=9999999;
 assert.equal(budget.assessRequestBudget(r).ok,false);assert.ok(Object.isFrozen(budget.getRequestBudgetPolicy(r)));
});

for(const method of ['completeChat','streamChatCompletion']) for(const mode of ['unbound','clone','omitted-output'])test(method+' fail closed '+mode,async t=>{
 const send=intercept(t),errors=[];let r=req('x'.repeat(500));
 if(mode==='unbound'||mode==='clone')r={...r};
 else {delete r.max_tokens;budget.bindRequestBudget(r,{...policy,maxContextTokens:1200});}
 if(method==='completeChat')await assert.rejects(client.completeChat(r,1000));
 else {await client.streamChatCompletion(r,callbacks(errors));assert.equal(errors.length,1)}
 assert.equal(send.mock.callCount(),0);
});
