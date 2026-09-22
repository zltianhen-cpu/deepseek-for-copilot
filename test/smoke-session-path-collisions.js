// 用途：防止占位文本停用整轮，以及本轮名字误还原外来路径；可加载旧产物复现失败。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require(process.env.SESSION_PATH_MODULE || '../out/provider/session-paths');
const norm = api.normalizeSessionPaths;
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const real = (id=A, kind='debug-logs', sep='/') => `${kind}${sep}${id}`;
const alias = (id='1', kind='debug-logs', sep='/') => `${kind}${sep}__copilot_session_${id}__`;
const msg = (content, role='user') => ({role,content});
const clean = (n) => assert.ok(!JSON.stringify(n.messages).includes(A));
const call = (args) => ({id:'call_keep',type:'function',function:{name:'read',arguments:args}});
for (const role of ['system','user','tool','assistant']) test(role+' 裸标记不阻止真实路径转换',()=>{
 const n=norm([msg(real(),'system'),msg('提到 __copilot_session_1__ 而已',role)]);
 assert.equal(n.messages[0].content,alias());assert.equal(n.messages[1].content,'提到 __copilot_session_1__ 而已');
});
test('外来99号不消耗本轮计数',()=>{
 const n=norm([msg(alias('99')+' '+real()+' '+real(B))]);
 assert.equal(n.messages[0].content,alias('99')+' '+alias()+' '+alias('2'));
});



test('只有外来路径返回新容器且不猜映射',()=>{
 const input=[msg(alias())];const n=norm(input);assert.notEqual(n.messages,input);assert.notEqual(n.messages[0],input[0]);assert.deepEqual(n.messages,input);assert.equal(n.restoreText(alias()),alias());
});
test('混合结果二次处理相等且原输入不变',()=>{
 const m=[msg(real()),msg(alias())],before=JSON.stringify(m);const n=norm(m);
 assert.deepEqual(norm(n.messages).messages,n.messages);assert.equal(JSON.stringify(m),before);
});




for(const field of ['image','id','key']) test('保留字段'+field+'出现外来名字不误还原',()=>{
 let extra=msg('');if(field==='image')extra=msg([{type:'image_url',image_url:{url:'https://example.test/'+alias()}}]);
 if(field==='id')extra={...msg('','tool'),tool_call_id:alias()};
 if(field==='key')extra={...msg(''),tool_calls:[call(JSON.stringify({[alias()]:'value'}))]};
 const n=norm([msg(real()),extra]);assert.equal(n.messages[0].content,alias());assert.deepEqual(n.messages[1],extra);assert.equal(n.restoreText(alias()),alias());
});
test('伪目录和残缺名字不占位',()=>{
 for(const text of ['my-'+alias(),alias()+'suffix','__copilot_session_1__']){
  const n=norm([msg(real()),msg(text)]);assert.equal(n.messages[0].content,alias());assert.equal(n.messages[1].content,text);
 }
});
test('普通历史追加不改已有前段',()=>{
 const input=[msg(real(),'system')],before=norm(input).messages;
 for(const text of ['__copilot_session_1__',alias('99'),'ordinary'])assert.deepEqual(norm([...input,msg(text)]).messages.slice(0,1),before);
});




test('计数不含正文且不进入消息',()=>{
 const n=norm([msg(real()+' '+real()+' '+real(B)),msg(alias())]);
 assert.deepEqual(n.stats,{normalizedPaths:3,distinctPaths:2,foreignAliases:1,collisionPaths:1,invalidToolArguments:0});assert.ok(!JSON.stringify(n.messages).includes('normalizedPaths'));
});
test('坏JSON记原因但正文照常处理',()=>{
 const invalid='{'+alias();const n=norm([msg(real()),{...msg(''),tool_calls:[call(invalid)]}]);clean(n);
 assert.equal(n.messages[1].tool_calls[0].function.arguments,invalid);assert.equal(n.stats.invalidToolArguments,1);
});

test('无歧义路径每个流分片断点还原',()=>{
 const original='a'.repeat(260)+' '+real()+'/content '+alias('99')+' '+'z'.repeat(260);
 const n=norm([msg(original)]);clean(n);
 for(let i=0;i<=n.messages[0].content.length;i++){
  let result='';const s=api.createSessionTextStream(n.restoreText,x=>result+=x);s.push(n.messages[0].content.slice(0,i));s.push(n.messages[0].content.slice(i));s.flush();assert.equal(result,original);
 }
});
test('有歧义路径流分片保留且不阻断普通文本',()=>{
 const input=real()+' '+alias(),n=norm([msg(input)]),expected=alias()+' '+alias();
 for(let i=0;i<=expected.length;i++){let result='';const s=api.createSessionTextStream(n.restoreText,x=>result+=x);s.push(expected.slice(0,i));s.push(expected.slice(i));s.flush();assert.equal(result,expected);}
});
