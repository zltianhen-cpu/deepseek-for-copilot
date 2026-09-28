// Verify provenance at the real catalog mutator, including image and attachment boundaries.
'use strict';
process.env.CATALOG_PERSIST='0';
const {test}=require('node:test'),assert=require('node:assert/strict');
const cat=require('../resources/hooks/request_catalog');
const {HostSummaryReplayCache}=require('../out/provider/replay/host-summary');
const clone=x=>JSON.parse(JSON.stringify(x));
const block=n=>`<skill><name>${n}</name><description>${'description '.repeat(50)}</description><file>/skills/${n}</file></skill>`;
const catalog='<skills>'+block('alpha')+block('beta')+'</skills>';
const api={sid:'catalog',fingerprint:'source',query:'target',forced:new Set(),allowlist:new Set(),select:()=>new Set(['alpha']),compress:s=>s.slice(0,20)};
function seed(){cat._resetCatalogStateForTest();cat.recover([{role:'system',content:catalog},{role:'user',content:'query'}],{sessionKey:'s'},api);}
test('real source emits historical catalog; summary preserves images and tool evidence',async()=>{
 seed();const raw=[{role:'system',content:'head'},{role:'user',content:'query'},{role:'assistant',content:'answer'},{role:'user',content:[{type:'text',text:catalog},{type:'image_url',image_url:{url:'picture'}},{type:'text',text:'facts'}]},{role:'tool',tool_call_id:'t',content:'full evidence'}];
 const c=new HostSummaryReplayCache({waitMs:0}),ticket=c.begin('s',raw,'source'),main=clone(raw),seen=[];
 cat.recover(main,{sessionKey:'s',sourceSidecar:{entries:main.map((m,i)=>({index:i,mappedRole:m.role,hostProven:i===3}))},catalogReplay:v=>{seen.push(v);c.recordCatalog(ticket,v)}},api);
 assert.equal(seen.length,1);assert.equal(seen[0].index,3);assert.ok(main[3].content[0].text.length<raw[3].content[0].text.length);
 c.complete(ticket,main);const r=await c.recover('s',[...raw,{role:'user',content:'summarize'}]);assert.deepEqual(r.messages.slice(0,-1),main);assert.equal(r.catalogRestored,1);
});
for(const [name,content,proven] of [ ['untrusted user',catalog,false], ['attachment',`<attachment>${catalog}</attachment>`,true], ['broken',catalog.replace('</skills>',''),true], ['nested','<skills>'+catalog+'</skills>',true], ['image splits label',[{type:'text',text:'<skills>'+block('alpha')},{type:'image_url',image_url:{url:'image'}},{type:'text',text:'</skills>'}],true] ])test(name+' cannot produce replay evidence',()=>{
 seed();const m=[{role:'system',content:'head'},{role:'user',content},{role:'assistant',content:'answer'}],before=clone(m),seen=[];
 cat.recover(m,{sessionKey:'s',sourceSidecar:{entries:m.map((v,i)=>({index:i,mappedRole:v.role,hostProven:proven&&i===1}))},catalogReplay:v=>seen.push(v)},api);
 assert.equal(seen.length,0);assert.deepEqual(m,before);
});
test('multiple catalogs and text parts preserve outside bytes',()=>{seed();const m=[{role:'system',content:[{type:'text',text:'prefix '+catalog+' tail '+catalog},{type:'image_url',image_url:{url:'image'}},{type:'text',text:'outside'}]},{role:'user',content:'query'},{role:'assistant',content:'answer'}],seen=[];cat.recover(m,{sessionKey:'s',catalogReplay:v=>seen.push(v)},api);assert.equal(seen.length,1);assert.equal(m[0].content[2].text,'outside');assert.ok(m[0].content[0].text.startsWith('prefix '));assert.ok(m[0].content[0].text.includes(' tail '));});
test('throwing evidence callback cannot break main filter',()=>{seed();assert.doesNotThrow(()=>cat.recover([{role:'system',content:catalog}],{sessionKey:'s',catalogReplay:()=>{throw Error('test')}},api));});
