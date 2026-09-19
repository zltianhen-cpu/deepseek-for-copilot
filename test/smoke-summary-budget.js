// 用途：分块摘要的完整性与共享预算；客户端替身保留真实预算检查。
'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.CACHE_EXTENSION_TEST_DIR || path.join(__dirname,'..');
process.env.DEEPSEEK_HOOKS_OFF='1';
const {makeFoldSummarize,COMPACTION_INSTRUCTION}=require(path.join(root,'out/provider/fold-summarize.js'));
const {assessRequestBudget,getRequestBudgetPolicy,DEFAULT_BUDGET_POLICY}=require(path.join(root,'out/request-budget.js'));
const events=require(path.join(root,'out/provider/request-events.js'));
const user=(text)=>({role:'user',content:text});
const small={maxInputTokens:7000,maxContextTokens:20000,maxOutputTokens:8192,imageTokens:1000};
const chunks=()=>Array.from({length:4},(_,i)=>user('BLOCK'+i+' '+String(i).repeat(3000)));
function fixture(fn=async()=> 'summary',policy=small,token,tools){
 const seen=[];const client={completeChat:async(r,ms,t)=>{seen.push(r);return fn(r,seen.length,ms,t)}};
 return {seen,f:makeFoldSummarize(client,'unknown',token,tools,'parent-fixture',policy)};
}
test('1.3M 多消息切块；每次受限；原文逐字不变',async()=>{
 const msgs=Array.from({length:130},(_,i)=>user('ID'+i+' '+ 'x'.repeat(10000))),before=JSON.stringify(msgs);
 const x=fixture(async(r,n)=>'summary '+n,DEFAULT_BUDGET_POLICY);
 const result=await x.f(msgs);assert.ok(result);assert.ok(x.seen.length>=3);assert.ok(x.seen.length<=12);
 x.seen.forEach(r=>assert.equal(assessRequestBudget(r,getRequestBudgetPolicy(r)).ok,true));
 assert.equal(JSON.stringify(msgs),before);
});
test('装得下的 prefix 保持原缓存请求形状',async()=>{
 const prefix=[{role:'system',content:'rules'},user('prior'),user('new')],x=fixture();
 assert.equal(await x.f([user('prior')],{prefixMessages:prefix}),'summary');
 assert.deepEqual(x.seen[0].messages.slice(0,-1),prefix);assert.equal(x.seen.length,1);
});
test('超线 prefix 不能覆盖已切块 foldMsgs；固定 system 保留',async()=>{
 const sys={role:'system',content:'must preserve'},msgs=chunks(),prefix=[sys,...msgs,user('EXCLUDE_CURRENT '+'z'.repeat(10000))],x=fixture();
 assert.ok(await x.f(msgs,{prefixMessages:prefix}));assert.ok(x.seen.length>1);
 for(const r of x.seen){assert.equal(r.messages[0].content,sys.content);assert.ok(!JSON.stringify(r).includes('EXCLUDE_CURRENT'));assert.equal(assessRequestBudget(r,small).ok,true)}
 const sent=x.seen.flatMap(r=>r.messages).filter(m=>m.role!=='system'&&!(typeof m.content==='string' && m.content.startsWith(COMPACTION_INSTRUCTION)));
 assert.deepEqual(sent,msgs);
});
test('第二块失败丢弃全部部分摘要',async()=>{
 const x=fixture(async(r,n)=>{if(n===2)throw TypeError('network');return 'private partial'});
 assert.equal(await x.f(chunks()),'');assert.equal(x.seen.length,2);assert.equal(x.f.lastDiagnostic.reason,'network');
});
test('单个巨型消息不能截字；零调用',async()=>{
 const msgs=[user('x'.repeat(10000))],before=JSON.stringify(msgs),x=fixture();
 assert.equal(await x.f(msgs),'');assert.equal(x.seen.length,0);assert.equal(x.f.lastDiagnostic.reason,'budget');assert.equal(JSON.stringify(msgs),before);
});
function pair(size=1400){return [{role:'assistant',content:'',tool_calls:[{id:'a',type:'function',function:{name:'run',arguments:'{}'}},{id:'b',type:'function',function:{name:'run',arguments:'{}'}}]},{role:'tool',tool_call_id:'a',content:'A'.repeat(size)},{role:'tool',tool_call_id:'b',content:'B'.repeat(size)}]}
test('assistant 与所有 tool 始终同组同请求',async()=>{
 const group=pair(),msgs=[user('x'.repeat(3000)),...group,user('y'.repeat(3000))],x=fixture();assert.ok(await x.f(msgs));assert.ok(x.seen.length>1);
 const found=x.seen.filter(r=>r.messages.some(m=>m.tool_calls));assert.equal(found.length,1);assert.deepEqual(found[0].messages.filter(m=>m.role==='assistant'||m.role==='tool'),group);
});
test('单巨型工具组拒绝，不拆工具回复',async()=>{
 const x=fixture();assert.equal(await x.f(pair(4000)),'');assert.equal(x.seen.length,0);assert.equal(x.f.lastDiagnostic.reason,'budget');
});
for(const [name,msgs] of [['孤儿',[{role:'tool',tool_call_id:'missing',content:'x'}]],['缺工具',pair().slice(0,2)]])test(name+' 工具组拒绝',async()=>{
 const x=fixture();assert.equal(await x.f(msgs),'');assert.equal(x.seen.length,0);assert.equal(x.f.lastDiagnostic.reason,'budget');
});
test('实际 tools 超预算零调用',async()=>{
 const tools=[{type:'function',function:{name:'run',parameters:{description:'x'.repeat(8000)}}}],x=fixture(undefined,small,undefined,tools);
 assert.equal(await x.f([user('hi')]),'');assert.equal(x.seen.length,0);
});
test('输出重试重新核算上下文，不够零第二次',async()=>{
 const x=fixture(async()=>{throw Object.assign(Error('truncated'),{code:'truncated'})},{...small,maxContextTokens:8000});
 assert.equal(await x.f([user('hi')]),'');assert.equal(x.seen.length,1);assert.equal(x.f.lastDiagnostic.reason,'budget');
});
test('截断重试生成独立 attempt ID 且保留 parent',async t=>{
 const recorded=[];t.mock.method(events,'recordRequestEvent',(...args)=>recorded.push(args));
 const x=fixture(async(r,n)=>{if(n===1)throw Object.assign(Error('truncated'),{code:'truncated'});return 'ok'});
 assert.equal(await x.f([user('hi')]),'ok');const sends=recorded.filter(r=>r[1]==='PREPARE');
 assert.equal(sends.length,2);assert.notEqual(sends[0][0],sends[1][0]);assert.ok(sends.every(r=>r[3]==='parent-fixture'));
});
test('调用上限 12，不返回部分内容',async()=>{
 const msgs=Array.from({length:13},()=>user('x'.repeat(4000))),x=fixture();
 assert.equal(await x.f(msgs),'');assert.ok(x.seen.length<=12);assert.equal(x.f.lastDiagnostic.reason,'request-limit');
});
test('总时限超过 60 秒，完成内容也不能提交',async t=>{
 let now=0;t.mock.method(Date,'now',()=>now);
 const x=fixture(async()=>{now=60001;return 'late summary'});
 assert.equal(await x.f(chunks()),'');assert.equal(x.seen.length,1);assert.equal(x.f.lastDiagnostic.reason,'timeout');
});
test('调用间取消不发送后续且不返回部分摘要',async()=>{
 const token={isCancellationRequested:false};const x=fixture(async()=>{token.isCancellationRequested=true;return 'partial'},small,token);
 assert.equal(await x.f(chunks()),'');assert.equal(x.seen.length,1);assert.equal(x.f.lastDiagnostic.reason,'cancelled');
});
test('空块结果一律失败',async()=>{
 const x=fixture(async()=> '  ');assert.equal(await x.f(chunks()),'');assert.equal(x.f.lastDiagnostic.reason,'empty');
});
test('缩减层最多一层且每次仍受预算',async()=>{
 const x=fixture(async(r,n)=>n<=4?'s'.repeat(4000):'reduced '+n);
 assert.ok(await x.f(chunks()));assert.ok(x.seen.length>4);assert.ok(x.seen.length<=12);
 x.seen.forEach(r=>assert.equal(assessRequestBudget(r,small).ok,true));
});
test('第二层仍过大返回空，不无限再总结',async()=>{
 const x=fixture(async()=> 's'.repeat(4000));
 assert.equal(await x.f(chunks()),'');assert.ok(x.seen.length<=8);assert.equal(x.f.lastDiagnostic.reason,'budget');
});
for(const status of [400,429])test('HTTP '+status+' 不重试',async()=>{
 const x=fixture(async()=>{throw Object.assign(Error('http'),{status})});assert.equal(await x.f(chunks()),'');assert.equal(x.seen.length,1);assert.equal(x.f.lastDiagnostic.reason,'http');
});

test('完整prefix仅授权唯一匹配的旧历史范围',async()=>{
 const x=fixture(),prior=user('OLD_ONLY');await x.f([prior],{prefixMessages:[{role:'system',content:'rules'},prior,user('CURRENT_EXCLUDE')]});
 const instruction=x.seen[0].messages.at(-1).content;
 assert.match(instruction,/SUMMARY_TARGET_RANGE=1:1/);assert.match(instruction,/Do not summarize messages outside/);
});
test('重复匹配不猜折区位置，回退只总结foldMsgs',async()=>{
 const x=fixture(),old=user('same');await x.f([old],{prefixMessages:[old,old,user('CURRENT_EXCLUDE')]});
 assert.ok(x.seen.length);assert.ok(!JSON.stringify(x.seen).includes('CURRENT_EXCLUDE'));
});
for(const [name,msgs] of [['null',[user('a'),null]],['missing-role',[user('a'),{content:'lost'}]],['unknown-role',[{role:'bad',content:'lost'}]],['mid-system',[user('a'),{role:'system',content:'later'},user('b')]]])test(name+'不丢弃或重排，零调用',async()=>{
 const x=fixture();assert.equal(await x.f(msgs),'');assert.equal(x.seen.length,0);
});
test('prefix中途system不能通过完整前缀路径',async()=>{
 const x=fixture(),msgs=[user('a'),{role:'system',content:'later'},user('b')];assert.equal(await x.f([msgs[0]],{prefixMessages:msgs}),'');assert.equal(x.seen.length,0);
});
test('映射为user的宿主前缀在每个分块保留且不列入摘要目标',async()=>{
 const host=user('HOST RULE KEEP'),msgs=chunks(),x=fixture();assert.ok(await x.f(msgs,{prefixMessages:[host,...msgs,user('CURRENT '+ 'z'.repeat(10000))],protectedPrefixCount:1}));assert.ok(x.seen.length>1);
 for(const r of x.seen){assert.deepEqual(r.messages[0],host);assert.match(r.messages.at(-1).content,/SUMMARY_TARGET_RANGE=1:/);assert.equal(assessRequestBudget(r,small).ok,true)}
});
