// Purpose: failed or disabled diagnostic writes must be distinguishable from success.
const {test}=require('node:test');const assert=require('node:assert/strict');
const root=process.env.CACHE_EXTENSION_TEST_DIR || require('node:path').join(__dirname,'..');
const events=require(root+'/out/provider/request-events');const log=require(root+'/resources/hooks/event_log');
const {recordStage}=require(root+'/out/send-receipt');const {makeFoldSummarize}=require(root+'/out/provider/fold-summarize');
for(const [name,value] of [['written',{ok:true}],['budget',{ok:false,error:'diag-directory-budget'}],['busy',{ok:false,error:'diag-writer-busy'}],['disabled',{ok:true,skipped:true}]])test(name+' propagates stage result',()=>{
 const old=log.reportEvent;log.reportEvent=()=>value;
 try {const r=recordStage({requestId:'test',requestKind:'summary'},'SUMMARY_INPUT',[{role:'user',content:'private'}]);assert.equal(r.ok,value.ok);assert.equal(r.error,value.error);assert.equal(!!r.skipped,!!value.skipped);}finally{log.reportEvent=old}
});
test('unexpected errors are redacted and do not break request',()=>{
 const old=log.reportEvent;log.reportEvent=()=>{throw Error('PRIVATE')};
 try{const r=events.recordRequestEvent('test','SUMMARY_INPUT','summary');assert.equal(r.ok,false);assert.equal(r.error,'diag-event-failed');assert.ok(!JSON.stringify(r).includes('PRIVATE'))}finally{log.reportEvent=old}
});
test('a failed page makes the whole stage incomplete',()=>{
 let i=0;const old=log.reportEvent;log.reportEvent=()=>++i===2?{ok:false,error:'diag-directory-budget'}:{ok:true};
 try{const r=recordStage({requestId:'test',requestKind:'summary'},'SUMMARY_INPUT',Array.from({length:25},()=>({role:'user',content:'x'})));assert.equal(r.ok,false);assert.equal(r.error,'diag-directory-budget')}finally{log.reportEvent=old}
});
test('summary succeeds but reports diagnostic failure to caller',async()=>{
 const old=log.reportEvent;log.reportEvent=()=>({ok:false,error:'diag-directory-budget'});
 try{const f=makeFoldSummarize({completeChat:async()=> 'ok'},'test');assert.equal(await f([{role:'user',content:'hello'}]),'ok');assert.equal(f.lastDiagnostic.diagnosticWriteStatus,'failed');assert.equal(f.lastDiagnostic.diagnosticWriteError,'diag-directory-budget')}finally{log.reportEvent=old}
});
test('healthy summary really writes its fingerprints',async()=>{
 const fs=require('fs'),path=require('path');const f=makeFoldSummarize({completeChat:async()=> 'ok'},'test');
 assert.equal(await f([{role:'user',content:'hello'}]),'ok');assert.equal(f.lastDiagnostic.diagnosticWriteStatus,'written');
 const rows=fs.readdirSync(log.diagDir()).filter(n=>n.endsWith('.jsonl')).flatMap(n=>fs.readFileSync(path.join(log.diagDir(),n),'utf8').trim().split('\n').map(JSON.parse));
 assert.ok(rows.some(r=>r.eventCode==='SUMMARY_INPUT'&&r.historyHash));assert.ok(rows.some(r=>r.eventCode==='SUMMARY_INPUT_ITEMS'&&r.fingerprints.length));
});
