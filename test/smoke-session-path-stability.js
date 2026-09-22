// 用途：未来引用不得改变已发前段；歧义工具路径不得猜测。
const {test}=require('node:test'),assert=require('node:assert/strict');
const {normalizeSessionPaths:n}=require(process.env.SESSION_PATH_MODULE||'../out/provider/session-paths');
const A='11111111-1111-1111-1111-111111111111',B='22222222-2222-2222-2222-222222222222';
const m=content=>({role:'user',content});
for(const kind of ['debug-logs','chat-session-resources'])for(const sep of ['/','\\']){
 const real=kind+sep+A,alias=kind+sep+'__copilot_session_1__';
 test(kind+sep+'追加冲突不改历史',()=>{const before=n([m(real)]);for(const tail of [alias,alias+' '+alias.replace('1__','1_alt1__')])assert.deepEqual(n([m(real),m(tail)]).messages.slice(0,1),before.messages);});
 test(kind+sep+'分支不同UUID同名且正确还原',()=>{const a=n([m(real)]),b=n([m(real.replace(A,B))]);assert.deepEqual(a.messages,b.messages);assert.equal(a.restoreArguments(JSON.stringify({p:alias})),JSON.stringify({p:real}));assert.equal(b.restoreText(alias),real.replace(A,B));});
 test(kind+sep+'冲突普通文本保留与工具拒绝',()=>{const x=n([m(real),m(alias)]);assert.equal(x.restoreText(alias),alias);assert.throws(()=>x.restoreArguments(JSON.stringify({p:alias})),/SESSION_PATH_AMBIGUOUS/);assert.equal(x.restoreArguments('{"p":"safe"}'),'{"p":"safe"}');});
 test(kind+sep+'非冲突外来别名不误还原',()=>{const foreign=alias.replace('1__','99__'),x=n([m(real),m(foreign)]);assert.equal(x.restoreText(alias),real);assert.equal(x.restoreText(foreign),foreign);});
}
test('受保护字段出现冲突也不猜工具目标',()=>{const alias='debug-logs/__copilot_session_1__',x=n([m('debug-logs/'+A),{role:'tool',content:'text',tool_call_id:alias}]);assert.throws(()=>x.restoreArguments(JSON.stringify({p:alias})),/SESSION_PATH_AMBIGUOUS/);});
test('Unicode转义的工具冲突被识别',()=>{const a='debug-logs/__copilot_session_1__',x=n([m('debug-logs/'+A),m(a)]);assert.throws(()=>x.restoreArguments(JSON.stringify({p:a}).replace('debug','\\u0064ebug')),/SESSION_PATH_AMBIGUOUS/);});
