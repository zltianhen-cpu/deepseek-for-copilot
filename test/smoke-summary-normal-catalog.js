// Purpose: reproduce normal-index catalog rewrites missing from summary replay.
'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'normal-catalog-'));
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
process.env.DEEPSEEK_DATA_DIR=dir;
process.env.DEEPSEEK_INDEX_PATH=path.join(dir,'index.json');
process.env.DEEPSEEK_SCENE_POLICY_PATH=path.join(dir,'policy.json');
fs.writeFileSync(process.env.DEEPSEEK_SCENE_POLICY_PATH,JSON.stringify({enabled:false}));
const skills=Array.from({length:70},(_,i)=>({name:`test-${i}`,description:'lookup '+('details '.repeat(40)),text:`test-${i} lookup`,is_hub:false}));
fs.writeFileSync(process.env.DEEPSEEK_INDEX_PATH,JSON.stringify({skills}));
const root=process.env.CACHE_EXTENSION_TEST_DIR || path.join(__dirname,'..');
const filter=require(path.join(root,'resources/hooks/skill_filter'));
const {HostSummaryReplayCache}=require(path.join(root,'out/provider/replay/host-summary'));
const clone=x=>JSON.parse(JSON.stringify(x));
const catalog='<context><skills>'+skills.map(s=>`<skill><name>${s.name}</name><description>${s.description}</description></skill>`).join('\n')+'</skills><agents>unchanged</agents></context>';
test('normal path records historical user catalog and summary receives identical bytes',async()=>{
 const raw=[{role:'system',content:'instructions'},{role:'user',content:'earlier query'},{role:'assistant',content:'earlier answer',reasoning_content:'reason'},{role:'user',content:catalog},{role:'assistant',content:'more answer'},{role:'user',content:'lookup'}];
 const main=clone(raw),c=new HostSummaryReplayCache({waitMs:0}),ticket=c.begin('scope',raw),seen=[];
 const result=await filter.filterOpenAIMessages(main,{sessionKey:'normal-proof',requestKind:'test',sourceSidecar:{entries:raw.map((m,i)=>({index:i,mappedRole:m.role,hostProven:true,vscodeRole:m.role}))},catalogReplay:e=>{seen.push(e);c.recordCatalog(ticket,e)}});
 assert.equal(result.catalogPath,'normal');assert.ok(main[3].content.length<raw[3].content.length,'must actually shrink');
 assert.ok(seen.some(e=>e.index===3&&e.kind==='catalog'),'normal rewrite must emit certified replay evidence');
 c.complete(ticket,main);
 const summary=await c.recover('scope',[...clone(raw).map(({reasoning_content:_reasoning_content,...m})=>m),{role:'user',content:'summarize'}]);
 assert.equal(summary.messages[3].content,main[3].content);
 assert.equal(summary.messages.length,raw.length+1);
});
const {captureNormalReplay}=require(path.join(root,'resources/hooks/request_catalog'));
const one='<skills><skill><name>a</name><description>long</description></skill><skill><name>b</name><description>long</description></skill></skills>';
const small='<skills><skill><name>a</name><description>long</description></skill></skills>';
function capture(before,after,opts={}) {const seen=[];captureNormalReplay({sourceSidecar:{entries:[{index:0,mappedRole:before.role,hostProven:true}]},catalogReplay:x=>seen.push(x),...opts},0,before,after,1);return seen;}
for(const role of ['system','user']) for(const format of ['string','text-array','image-array']) test(`certified ${role} ${format}`,()=>{
 const wrap=s=>format==='string'?s:format==='text-array'?[{type:'text',text:s}]:[{type:'text',text:s},{type:'image_url',image_url:{url:'unchanged'}}];
 const before={role,content:wrap('before '+one+' after')},after={role,content:wrap('before '+small+' after')};
 assert.equal(capture(before,after).length,1);
});
for(const [name,mutate,opts] of [
 ['outside text',m=>m.content+='new fact'],['prefix',m=>m.content='new fact'+m.content],
 ['role',m=>m.role='system'],['metadata',m=>m.newField=true],

])test('reject '+name,()=>{const b={role:'user',content:'outside '+one},a={role:'user',content:'outside '+small};mutate(a);assert.equal(capture(b,a,opts).length,0)});
for(const [name,wrap] of [['attachment',s=>'<attachment>'+s+'</attachment>'],['nested',s=>'<skills>'+s+'</skills>'],['broken',s=>s.replace('</skills>','')],['no container',s=>s.replace(/<\/?skills>/g,'')]]) test('reject '+name,()=>{assert.equal(capture({role:'system',content:wrap(one)},{role:'system',content:wrap(small)}).length,0)});
test('image changes reject',()=>{const b={role:'system',content:[{type:'text',text:one},{type:'image_url',image_url:{url:'original'}}]},a=clone(b);a.content[0].text=small;a.content[1].image_url.url='changed';assert.equal(capture(b,a).length,0)});
test('no callback is harmless',()=>{assert.doesNotThrow(()=>capture({role:'system',content:one},{role:'system',content:small},{catalogReplay:undefined}))});
test('callback exception does not interrupt filter',()=>{assert.doesNotThrow(()=>capture({role:'system',content:one},{role:'system',content:small},{catalogReplay:()=>{throw Error('fixture')}}))});
test('unchanged message not registered',()=>{const b={role:'system',content:one};assert.equal(capture(b,clone(b)).length,0)});

test('real user sidecar is not mislabelled host: proof comes from local mutator',()=>{const b={role:'user',content:one},a={role:'user',content:small};assert.equal(capture(b,a,{sourceSidecar:{entries:[{index:0,mappedRole:'user',vscodeRole:'user',hostProven:false}]}}).length,1)});
for(const [name,b,a] of [
 ['internal attachment',one.replace('</skills>','<attachment>FACT</attachment></skills>'),small],
 ['internal fact change',one.replace('</skills>','FACT</skills>'),small.replace('</skills>','CHANGED</skills>')],
 ['outside blanklines below contract','head\n\n\n'+one,'head\n'+small],
 ['changed description',one,small.replace('long','fabricated')],
 ['new name',one,small.replace('<name>a</name>','<name>c</name>')],
 ['changed file',one.replace('</description>','</description><file>original</file>'),small.replace('</description>','</description><file>changed</file>')],
])test('reject reviewer counterexample '+name,()=>assert.equal(capture({role:'system',content:b},{role:'system',content:a}).length,0));
test('catalog prose must survive verbatim',()=>{const b={role:'user',content:one.replace('<skills>','<skills>Prose\n')},a={role:'user',content:small.replace('<skills>','<skills>Prose\n')};assert.equal(capture(b,a).length,1)});

test('known one-way blankline contraction is certified',()=>assert.equal(capture({role:'system',content:'head\n\n\n'+one},{role:'system',content:'head\n\n'+small}).length,1));
test('blankline expansion is rejected',()=>assert.equal(capture({role:'system',content:'head\n\n'+one},{role:'system',content:'head\n\n\n'+small}).length,0));

test('outside attachment whitespace is evidence, not formatting',()=>assert.equal(capture({role:'system',content:one+'<attachment>fact\n\n\nend</attachment>'},{role:'system',content:small+'<attachment>fact\n\nend</attachment>'}).length,0));

test('untrusted user directory remains byte-identical and produces no rewrite proof',async()=>{
 const raw=[{role:'system',content:'instructions'},{role:'user',content:catalog},{role:'user',content:'lookup'}];const main=clone(raw),seen=[];
 await filter.filterOpenAIMessages(main,{sessionKey:'untrusted-user-proof',requestKind:'test',sourceSidecar:{entries:raw.map((m,i)=>({index:i,mappedRole:m.role,hostProven:false,vscodeRole:m.role}))},catalogReplay:e=>seen.push(e)});
 assert.deepEqual(main,raw);assert.equal(seen.length,0);
});
