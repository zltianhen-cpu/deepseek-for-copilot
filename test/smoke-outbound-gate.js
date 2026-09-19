// 用途：旧字符闸门只读阻断，绝不截尾或丢当前工具循环任务。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const load = Module._load;
Module._load = function (id, ...args) {
 if (id === 'vscode') return {env:{language:'en'},window:{createOutputChannel:()=>({info(){},warn(){},error(){},debug(){}})}};
 return load.call(this,id,...args);
};
const root=process.env.CACHE_EXTENSION_TEST_DIR || path.join(__dirname,'..');
const gate=require(path.join(root,'out/provider/outbound-gate.js'));
const user=n=>({role:'user',content:'u'.repeat(n)});
const incident=()=>[{role:'system',content:'rules'},user(600000),{role:'assistant',content:'a'.repeat(600000)},user(10),{role:'assistant',content:'',tool_calls:[{id:'c1',type:'function',function:{name:'run',arguments:'{}'}}]},{role:'tool',tool_call_id:'c1',content:'result'}];
test('工具循环超线只读阻断，当前 user 和所有历史逐字不变',()=>{
 const msgs=incident(), before=JSON.stringify(msgs), refs=[...msgs];
 const result=gate.applyOutboundGate(msgs);
 assert.equal(JSON.stringify(msgs),before,'闸门不得删改任何消息');
 assert.equal(result.ok,false);assert.equal(result.droppedMessages,0);assert.equal(result.droppedImages,0);
 assert.equal(result.afterChars,result.beforeChars);refs.forEach((m,i)=>assert.equal(msgs[i],m));
});
test('enforce 超线必须抛本地错且原文不变',()=>{
 const msgs=incident(), before=JSON.stringify(msgs);
 assert.throws(()=>gate.enforceOutboundGate(msgs));assert.equal(JSON.stringify(msgs),before);
});
for(const [size,ok] of [[500000,true],[1050000,true],[1050001,false]]) test('字符边界 '+size,()=>{
 const msgs=[user(size)], before=JSON.stringify(msgs); const result=gate.applyOutboundGate(msgs);
 assert.equal(result.ok,ok);assert.equal(result.applied,false);assert.equal(JSON.stringify(msgs),before);
});
test('拒绝结果确定且幂等',()=>{
 const msgs=incident(),before=JSON.stringify(msgs);
 assert.deepEqual(gate.applyOutboundGate(msgs),gate.applyOutboundGate(msgs));assert.equal(JSON.stringify(msgs),before);
});
