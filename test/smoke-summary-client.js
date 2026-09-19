// 用途：非流式摘要必须完整结束；仅 HTTP 边界用内存响应替代。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'vscode') return { env: { language: 'en' }, window: {
    createOutputChannel: () => ({ info() {}, error() {}, debug() {}, warn() {}, appendLine() {} }),
  } };
  return load.call(this, id, ...args);
};
const path = require('node:path');
const compiledRoot = process.env.CACHE_EXTENSION_TEST_DIR || path.join(__dirname, '..');
const { DeepSeekClient } = require(path.join(compiledRoot, 'out/client/core.js'));
const { makeFoldSummarize } = require(path.join(compiledRoot, 'out/provider/fold-summarize.js'));
const client = new DeepSeekClient('https://example.invalid', 'test-placeholder');
const {bindRequestBudget,DEFAULT_BUDGET_POLICY}=require(path.join(compiledRoot,'out/request-budget.js'));
const request = bindRequestBudget({ model: 'test', messages: [{ role: 'user', content: 'x' }], stream: false }, DEFAULT_BUDGET_POLICY);
function response(t, finish, content) {
  t.mock.method(global, 'fetch', async () => ({ ok: true,
    json: async () => ({ choices: [{ finish_reason: finish, message: { content } }] }),
  }));
}
test('stop 完整摘要正常返回', async t => {
  response(t, 'stop', 'complete summary');
  assert.equal(await client.completeChat(request, 1000), 'complete summary');
});
for (const reason of ['length', 'tool_calls', 'content_filter', undefined]) {
  test('拒绝非完整结束 ' + reason, async t => {
    response(t, reason, 'partial summary');
    await assert.rejects(client.completeChat(request, 1000));
  });
}
test('空摘要被拒绝', async t => {
  response(t, 'stop', '  '); await assert.rejects(client.completeChat(request, 1000));
});
test('截断经生产摘要回调返回空串，不提交半截', async t => {
  response(t, 'length', 'partial summary');
  assert.equal(await makeFoldSummarize(client, 'test')(request.messages), '');
});
test('网络异常经生产回调返回空串', async t => {
  t.mock.method(global, 'fetch', async () => { throw Error('network'); });
  assert.equal(await makeFoldSummarize(client, 'test')(request.messages), '');
});
test('已取消摘要不发送请求', async t => {
  const send = t.mock.method(global, 'fetch', async () => { throw Error('must not send'); });
  assert.equal(await makeFoldSummarize(client, 'test', { isCancellationRequested: true })(request.messages), '');
  assert.equal(send.mock.callCount(), 0);
});
for (const [finish, expected] of [['stop','success'],['length','truncated'],['tool_calls','invalid-finish'],[undefined,'invalid-finish']]) {
 test('摘要诊断可区分 '+expected+' '+finish, async t => {
  response(t,finish,'summary'); const f=makeFoldSummarize(client,'test'); await f(request.messages);
  assert.equal(f.lastDiagnostic.reason,expected); assert.equal(f.lastDiagnostic.attempt,1);
 });
}
for (const [name,expected] of [['AbortError','timeout'],['TypeError','network']]) {
 test('异常诊断 '+name,async t=>{
  t.mock.method(global,'fetch',async()=>{const e=Error('private-detail');e.name=name;throw e;});
  const f=makeFoldSummarize(client,'test'); await f(request.messages);
  assert.equal(f.lastDiagnostic.reason,expected);assert.ok(!JSON.stringify(f.lastDiagnostic).includes('private-detail'));
 });
}
test('HTTP 状态错误分类且不记响应正文',async t=>{
 t.mock.method(global,'fetch',async()=>({ok:false,status:429,statusText:'limited',text:async()=>'private-body'}));
 const f=makeFoldSummarize(client,'test'); await f(request.messages);
 assert.equal(f.lastDiagnostic.reason,'http');assert.ok(!JSON.stringify(f.lastDiagnostic).includes('private-body'));
});
test('取消与空摘要分别记账',async t=>{
 const cancelled=makeFoldSummarize(client,'test',{isCancellationRequested:true});await cancelled(request.messages);
 assert.equal(cancelled.lastDiagnostic.reason,'cancelled');
 response(t,'stop','');const empty=makeFoldSummarize(client,'test');await empty(request.messages);assert.equal(empty.lastDiagnostic.reason,'empty');
});
test('摘要显式关闭思考避免输出预算被推理占满',async t=>{
 let body;t.mock.method(global,'fetch',async(url,o)=>{body=JSON.parse(o.body);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'ok'}}]})}});
 await makeFoldSummarize(client,'deepseek-flash')(request.messages);
 assert.deepEqual(body.thinking,{type:'disabled'});
});
test('截断只重试一次，第二次完整才返回',async t=>{
 const budgets=[];t.mock.method(global,'fetch',async(url,o)=>{budgets.push(JSON.parse(o.body).max_tokens);return {ok:true,json:async()=>({choices:[{finish_reason:budgets.length===1?'length':'stop',message:{content:budgets.length===1?'partial':'complete'}}]})}});
 const f=makeFoldSummarize(client,'deepseek-flash');assert.equal(await f(request.messages),'complete');assert.deepEqual(budgets,[4096,8192]);assert.equal(f.lastDiagnostic.requests,2);
});
test('连续截断最多两次，不泄露半截内容',async t=>{
 let n=0;t.mock.method(global,'fetch',async()=>{n++;return {ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'private partial'}}]})}});
 const f=makeFoldSummarize(client,'deepseek-flash');assert.equal(await f(request.messages),'');assert.equal(n,2);assert.equal(f.lastDiagnostic.reason,'truncated');assert.ok(!JSON.stringify(f.lastDiagnostic).includes('private'));
});
test('HTTP错误记录状态，不原地重试',async t=>{
 let n=0;t.mock.method(global,'fetch',async()=>{n++;return {ok:false,status:429,statusText:'Too Many Requests',text:async()=>'{"error":{"message":"private"}}'}});
 const f=makeFoldSummarize(client,'deepseek-flash');await f(request.messages);assert.equal(n,1);assert.equal(f.lastDiagnostic.httpStatus,429);
});
test('总时间预算耗尽不发送第二次且计数真实',async t=>{
 let now=0,n=0;t.mock.method(Date,'now',()=>now);
 t.mock.method(global,'fetch',async()=>{n++;now=60001;return {ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'partial'}}]})}});
 const f=makeFoldSummarize(client,'deepseek-flash');assert.equal(await f(request.messages),'');assert.equal(n,1);assert.equal(f.lastDiagnostic.requests,1);assert.equal(f.lastDiagnostic.reason,'timeout');
});
