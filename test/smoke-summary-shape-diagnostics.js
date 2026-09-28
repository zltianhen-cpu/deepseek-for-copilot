// Purpose: distinguish full-prefix reuse, unmatched targets and budget fallback without changing payloads.
const {test}=require('node:test');const assert=require('node:assert/strict');
const path=require('node:path');const root=process.env.CACHE_EXTENSION_TEST_DIR || path.join(__dirname,'..');
const {makeFoldSummarize,buildFoldSummaryRequest}=require(path.join(root,'out/provider/fold-summarize'));
const {DEFAULT_BUDGET_POLICY}=require(path.join(root,'out/request-budget'));
const m=content=>({role:'user',content});
for(const [name,target,prefix,expected] of [
 ['unique contiguous',[m('target')],[m('target'),m('tail')],'SUMMARY_PREFIX_FULL'],
 ['unmatched',[m('target')],[m('other')],'SUMMARY_TARGET_UNMATCHED'],
 ['ambiguous',[m('target')],[m('target'),m('target')],'SUMMARY_TARGET_UNMATCHED'],
 ['no prefix',[m('target')],undefined,'SUMMARY_TARGET_ONLY'],
])test(name,async()=>{
 const seen=[],f=makeFoldSummarize({completeChat:async req=>{seen.push(req);return 'summary'}},'test');
 const extra=prefix?{prefixMessages:prefix}:undefined;
 const expectedBody=buildFoldSummaryRequest('test',target,extra);
 assert.equal(await f(target,extra),'summary');
 assert.equal(f.lastDiagnostic.requestShape,expected);
 assert.deepEqual(seen[0],expectedBody,'diagnostics must not change request');
});
test('budget fallback has its own shape and does not claim full-prefix reuse',async()=>{
 const f=makeFoldSummarize({completeChat:async()=> 'summary'},'test',undefined,undefined,undefined,{...DEFAULT_BUDGET_POLICY,maxInputTokens:4000});
 assert.equal(await f([m('target')],{prefixMessages:[m('target'),m('x'.repeat(40000))]}),'summary');
 assert.equal(f.lastDiagnostic.requestShape,'SUMMARY_BUDGET_CHUNK');
});
