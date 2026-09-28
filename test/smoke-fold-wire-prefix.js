// Purpose: summary must reuse the main outbound path representation and restore real paths.
const {test}=require('node:test');const assert=require('node:assert/strict');
const root=process.env.CACHE_EXTENSION_TEST_DIR || require('node:path').join(__dirname,'..');
const {makeFoldSummarize}=require(root+'/out/provider/fold-summarize');
const {normalizeSessionPaths:norm}=require(root+'/out/provider/session-paths');
const A='11111111-1111-1111-1111-111111111111';
const path=`/tmp/debug-logs/${A}/file.txt`;
const prefix=[{role:'system',content:path},{role:'user',content:'task'},{role:'assistant',content:'done',reasoning_content:path},{role:'user',content:'next'}];
test('summary shares full main outbound prefix and does not mutate inputs',async()=>{
 const before=JSON.stringify(prefix);let sent;
 const f=makeFoldSummarize({completeChat:async r=>{sent=r;return 'ok'}},'test');
 assert.equal(await f(prefix.slice(1,3),{prefixMessages:prefix}),'ok');
 assert.deepEqual(sent.messages.slice(0,-1),norm(prefix).messages);
 assert.equal(JSON.stringify(prefix),before);
});
test('summary output restores original path before storing',async()=>{
 const f=makeFoldSummarize({completeChat:async r=>r.messages[0].content},'test');
 assert.equal(await f(prefix.slice(1,3),{prefixMessages:prefix}),path);
});
for(const [name,build] of [
 ['array text',()=>({role:'user',content:[{type:'text',text:path},{type:'image_url',image_url:{url:'https://example.com/image.png'}}]})],
 ['arguments',()=>({role:'assistant',content:'',tool_calls:[{id:'call',type:'function',function:{name:'read',arguments:JSON.stringify({path})}}]})],
 ['invalid arguments',()=>({role:'assistant',content:'',tool_calls:[{id:'call',type:'function',function:{name:'read',arguments:'{'+path}}]})],
 ['ordinary uuid',()=>({role:'user',content:A})],
])test(name+' keeps main conversion semantics',async()=>{
 const item=build();const p=[{role:'system',content:'system'},item,...(item.tool_calls?[{role:'tool',tool_call_id:'call',content:'result'}]:[]),{role:'user',content:'tail'}];let sent;
 const f=makeFoldSummarize({completeChat:async r=>{sent=r;return 'ok'}},'test');
 assert.equal(await f([p[1]],{prefixMessages:p}),'ok');assert.deepEqual(sent.messages.slice(0,-1),norm(p).messages);
});

test('ambiguous aliases refuse summary instead of losing a real path',async()=>{
 let calls=0;const p=[{role:'user',content:path+' old debug-logs/__copilot_session_1__/b'}];const before=JSON.stringify(p);
 const f=makeFoldSummarize({completeChat:async r=>{calls++;return r.messages[0].content}},'test');
 assert.equal(await f(p,{prefixMessages:p}),'');assert.equal(calls,0);assert.equal(f.lastDiagnostic.reason,'path-collision');assert.equal(JSON.stringify(p),before);
});
