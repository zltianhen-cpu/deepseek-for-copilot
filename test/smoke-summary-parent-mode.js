// Purpose: parent cache settings survive full/chunk/retry summaries without tool execution.
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const root=process.env.CACHE_EXTENSION_TEST_DIR||path.join(__dirname,'..');
const {buildFoldSummaryRequest:build,makeFoldSummarize:make}=require(root+'/out/provider/fold-summarize');
const {DEFAULT_BUDGET_POLICY:policy}=require(root+'/out/request-budget');
const tools=[{type:'function',function:{name:'noop',parameters:{type:'object',properties:{}}}}];
const msg=s=>({role:'user',content:s});
for(const effort of ['low','high','max'])test('full request inherits '+effort,()=>{
 const mode={thinking:{type:'enabled'},reasoning_effort:effort,tool_choice:'auto'};
 const r=build('test',[msg('one')],undefined,tools,mode);
 assert.deepEqual(r.thinking,mode.thinking);assert.equal(r.reasoning_effort,effort);assert.equal(r.tool_choice,'auto');assert.equal(r.temperature,undefined);assert.deepEqual(r.tools,tools);
});
test('disabled parent retained and legacy invocation unchanged',()=>{
 const r=build('test',[msg('one')],undefined,tools,{thinking:{type:'disabled'},tool_choice:'auto'});assert.equal(r.thinking.type,'disabled');assert.equal(r.tool_choice,'auto');assert.equal(r.reasoning_effort,undefined);
 const old=build('test',[msg('one')],undefined,tools);assert.equal(old.thinking.type,'disabled');assert.equal(old.tool_choice,'none');assert.equal(old.temperature,0);
});
test('no tools omits tool choice',()=>assert.equal(build('test',[msg('one')],undefined,undefined,{thinking:{type:'enabled'},reasoning_effort:'high',tool_choice:'auto'}).tool_choice,undefined));
test('retry retains mode and input unmodified',async()=>{
 const mode={thinking:{type:'enabled'},reasoning_effort:'max',tool_choice:'auto'},seen=[],msgs=[msg('x')],before=JSON.stringify(msgs);
 const f=make({completeChat:async r=>{seen.push(r);if(seen.length===1)throw Object.assign(Error(),{code:'truncated'});return 'done'}},'test',undefined,tools,'parent',policy,undefined,mode);
 assert.equal(await f(msgs),'done');assert.deepEqual(seen.map(x=>x.max_tokens),[4096,8192]);for(const r of seen){assert.deepEqual(r.thinking,mode.thinking);assert.equal(r.tool_choice,'auto');assert.equal(r.reasoning_effort,'max')}assert.equal(JSON.stringify(msgs),before);
});
test('budget chunks inherit mode',async()=>{
 const seen=[],mode={thinking:{type:'enabled'},reasoning_effort:'high',tool_choice:'auto'};
 const f=make({completeChat:async r=>{seen.push(r);return 'done'}},'test',undefined,tools,'parent',{maxInputTokens:7000,maxContextTokens:20000,maxOutputTokens:8192,imageTokens:1000},undefined,mode);
 assert.ok(await f(Array.from({length:4},(_,i)=>msg('BLOCK'+i+' x'.repeat(6000)))));assert.ok(seen.length>1);for(const r of seen){assert.equal(r.thinking.type,'enabled');assert.equal(r.tool_choice,'auto');assert.equal(r.reasoning_effort,'high')}
});
