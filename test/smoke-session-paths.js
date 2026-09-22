// 用途：验证分支前缀一致、字段保护、工具路径恢复和请求隔离。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSessionPaths: norm } = require('../out/provider/session-paths');
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const msg = (content, role='system') => ({role, content});
const path = (id=A, kind='debug-logs') => `/tmp/${kind}/${id}/content.txt`;
const out = (text) => norm([msg(text)]).messages[0].content;
for (const kind of ['debug-logs', 'chat-session-resources']) {
 test(`${kind} 跨分支一致`, () => assert.equal(out(path(A,kind)),out(path(B,kind))));
 test(`${kind} 真实路径恢复`, () => { const n=norm([msg(path(A,kind))]); assert.deepEqual(JSON.parse(n.restoreArguments(JSON.stringify({path:n.messages[0].content}))),{path:path(A,kind)}); });
 test(`${kind} 多会话不合并`, () => {const n=out(path(A,kind)+' '+path(B,kind)); assert.match(n,/session_1__/); assert.match(n,/session_2__/);});
 test(`${kind} Windows 恢复`, () => { const x=path(A,kind).replaceAll('/','\\'); const n=norm([msg(x)]);assert.equal(JSON.parse(n.restoreArguments(JSON.stringify(n.messages[0].content))),x);});
}
for (const [name, text] of [
 ['普通UUID',A], ['其他目录',`/tmp/files/${A}`], ['相似目录',`/my-debug-logs/${A}`],
 ['非法长UUID',`debug-logs/${A}0`], ['后缀文字',`debug-logs/${A}xyz`], ['非法编号','debug-logs/not-a-uuid'],
 ['大写编号','debug-logs/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'], ['空串',''],
 ['已有占位', 'debug-logs/__copilot_session_1__'],
]) test(name+' 保留',()=>assert.equal(out(text),text));
test('四种角色文本',()=>{for(const role of ['system','user','assistant','tool'])assert.match(norm([msg(path(),role)]).messages[0].content,/session_1__/);});
test('输入不变',()=>{const m=[msg(path())];const before=JSON.stringify(m);norm(m);assert.equal(JSON.stringify(m),before);});
test('重复执行不变',()=>{const m=norm([msg(path())]).messages;assert.deepEqual(norm(m).messages,m);});
test('数组文本处理图片保留',()=>{const m=norm([msg([{type:'text',text:path()},{type:'image_url',image_url:{url:path()}}])]).messages[0];assert.match(m.content[0].text,/session_1__/);assert.equal(m.content[1].image_url.url,path());});
test('工具ID名称不改',()=>{const m=norm([{...msg(path(),'tool'),tool_call_id:path(),tool_calls:[{id:path(),type:'function',function:{name:path(),arguments:JSON.stringify({path:path()})}}]}]).messages[0];assert.equal(m.tool_call_id,path());assert.equal(m.tool_calls[0].id,path());assert.equal(m.tool_calls[0].function.name,path());assert.match(m.tool_calls[0].function.arguments,/session_1__/);});
test('工具call目录不改',()=>assert.match(out(path().replace('content.txt','call_abc/content.txt')),/call_abc\/content.txt$/));
test('推理文本处理',()=>assert.match(norm([{...msg(''),reasoning_content:path()}]).messages[0].reasoning_content,/session_1__/));
test('无效工具JSON保留',()=>{const args='{'+path();const m=norm([{...msg(''),tool_calls:[{id:'x',type:'function',function:{name:'read',arguments:args}}]}]);assert.equal(m.messages[0].tool_calls[0].function.arguments,args);assert.equal(m.restoreArguments(args),args);});
test('嵌套与特殊键恢复',()=>{const n=norm([msg(path())]);const raw=JSON.stringify({nested:[n.messages[0].content,null,3],['__proto__']:n.messages[0].content});const restored=JSON.parse(n.restoreArguments(raw));assert.equal(restored.nested[0],path());assert.equal(restored.__proto__,path());});
test('并发请求不串线',()=>{const a=norm([msg(path(A))]),b=norm([msg(path(B))]);const args=JSON.stringify(a.messages[0].content);assert.equal(JSON.parse(a.restoreArguments(args)),path(A));assert.equal(JSON.parse(b.restoreArguments(args)),path(B));});
test('未知占位不猜',()=>assert.equal(norm([msg(path())]).restoreArguments('"debug-logs/__copilot_session_99__"'),'"debug-logs/__copilot_session_99__"'));
test('无匹配工具参数空白保留',()=>{const args='{ "a": 1 }';assert.equal(norm([]).restoreArguments(args),args);});
test('同形完整历史一致',()=>{const branch=(id)=>[msg(path(id)),msg(path(id,'chat-session-resources'),'tool'),msg('same','user')];assert.deepEqual(norm(branch(A)).messages,norm(branch(B)).messages);});

const {createSessionTextStream}=require('../out/provider/session-paths');
for (const kind of ['debug-logs','chat-session-resources']) test(kind+' 每个分片断点还原',()=>{
 const original='a'.repeat(300)+' '+path(A,kind)+' '+'b'.repeat(300);
 const n=norm([msg(original)]), aliased=n.messages[0].content;
 for(let cut=0;cut<=aliased.length;cut++) {
  let result=''; const stream=createSessionTextStream(n.restoreText,(text)=>result+=text);
  stream.push(aliased.slice(0,cut));stream.push(aliased.slice(cut));stream.flush();stream.flush();assert.equal(result,original);
 }
});
test('单字分片与连续轮保持',()=>{
 const n=norm([msg(path())]);let result='';const stream=createSessionTextStream(n.restoreText,(s)=>result+=s);
 for(const c of n.messages[0].content) stream.push(c);stream.flush();assert.equal(result,path());
 assert.match(norm([msg(path()),msg(result,'assistant')]).messages[0].content,/session_1__/);
});
