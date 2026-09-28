// Verify catalog-only replay without substituting compressed conversation history.
'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {HostSummaryReplayCache}=require('../out/provider/replay/host-summary');
const clone=x=>JSON.parse(JSON.stringify(x));
const raw=()=>[{role:'system',content:'instructions'},{role:'user',content:'<skills>large catalog</skills> outside'},{role:'assistant',content:'answer',reasoning_content:'reason'},{role:'tool',tool_call_id:'a',content:'full evidence'}];
const incoming=r=>[...clone(r).map(({reasoning_content:_reasoning_content,...m})=>m),{role:'user',content:'summarize all evidence'}];
function setup(opts={}) { const c=new HostSummaryReplayCache({waitMs:0,...opts}),r=raw(),t=c.begin('scope',r,'r-source');return {c,r,t}; }
function patch(s,index=1,change=m=>{m.content='<skills>small</skills> outside'}){const b=clone(s.r[index]),a=clone(b);change(a);s.c.recordCatalog(s.t,{index,before:b,after:a,kind:'catalog'});return a;}
test('replays certified historical catalog, reasoning and full tool evidence',async()=>{const s=setup(),a=patch(s),out=clone(s.r);out[1]=a;s.c.complete(s.t,out);const v=await s.c.recover('scope',incoming(s.r));assert.deepEqual(v.messages.slice(0,-1),out);assert.equal(v.catalogRestored,1);assert.equal(v.sourceRequestId,'r-source');});
for(const [name,mutate] of [
 ['edited user',m=>m[1].content+='x'],['changed tool evidence',m=>m[3].content+='x'],['changed tool id',m=>m[3].tool_call_id='b'],['role changed',m=>m[1].role='tool'],['extra image',m=>m[1].content=[{type:'text',text:m[1].content},{type:'image_url',image_url:{url:'image'}}]],['unknown field',m=>m[1].future=true],['missing history',m=>m.splice(1,1)],['order changed',m=>[m[0],m[1]]=[m[1],m[0]]]])test(name,async()=>{const s=setup(),a=patch(s),out=clone(s.r);out[1]=a;s.c.complete(s.t,out);const m=incoming(s.r);mutate(m);assert.equal((await s.c.recover('scope',m)).messages,undefined);});
test('cross scope rejected',async()=>{const s=setup();patch(s);s.c.complete(s.t,s.r);assert.equal((await s.c.recover('other',incoming(s.r))).messages,undefined);});
test('unproven before rejected',async()=>{const s=setup(),a=clone(s.r[1]);a.content='other';s.c.recordCatalog(s.t,{index:1,before:a,after:{...a,content:'small'},kind:'catalog'});s.c.complete(s.t,s.r);assert.equal((await s.c.recover('scope',incoming(s.r))).catalogRestored,0);});
test('tool callback cannot overwrite evidence',async()=>{const s=setup();patch(s,3);s.c.complete(s.t,s.r);assert.equal((await s.c.recover('scope',incoming(s.r))).catalogRestored,0);});
test('metadata changes rejected',async()=>{const s=setup();patch(s,1,m=>{m.role='system'});s.c.complete(s.t,s.r);assert.equal((await s.c.recover('scope',incoming(s.r))).catalogRestored,0);});
test('folded output never replaces full history',async()=>{const s=setup();patch(s);s.c.complete(s.t,[{role:'user',content:'folded'}]);const v=await s.c.recover('scope',incoming(s.r));assert.deepEqual(v.messages.slice(0,-1),s.r);assert.equal(v.catalogRestored,0);});
test('subsequent mutation invalidates patch',async()=>{const s=setup();patch(s);s.c.complete(s.t,s.r);assert.equal((await s.c.recover('scope',incoming(s.r))).catalogRestored,0);});
test('catalog and locally generated addition compose',async()=>{const s=setup(),a=patch(s),b=clone(a);b.content+='\n<skills_added_this_session>selected</skills_added_this_session>';s.c.recordCatalog(s.t,{index:1,before:a,after:b,kind:'addition'});const out=clone(s.r);out[1]=b;s.c.complete(s.t,out);assert.deepEqual((await s.c.recover('scope',incoming(s.r))).messages[1],b);});
test('expired entry rejected',async()=>{let now=0;const s=setup({now:()=>now,ttlMs:10});patch(s);s.c.complete(s.t,s.r);now=11;assert.equal((await s.c.recover('scope',incoming(s.r))).messages,undefined);});
test('capacity includes patch content',async()=>{const s=setup({maxBytes:1000});patch(s,1,m=>{m.content='x'.repeat(2000)});s.c.complete(s.t,s.r);assert.equal((await s.c.recover('scope',incoming(s.r))).messages,undefined);});
test('cancelled request unchanged',async()=>{const s=setup();patch(s);s.c.complete(s.t,s.r);assert.equal((await s.c.recover('scope',incoming(s.r),{isCancellationRequested:true})).status,'cancelled');});
test('snapshot empty after restart',async()=>{const s=setup();assert.equal((await s.c.recover('scope',incoming(s.r))).messages,undefined);});
test('returned copy does not mutate snapshot',async()=>{const s=setup(),a=patch(s),o=clone(s.r);o[1]=a;s.c.complete(s.t,o);(await s.c.recover('scope',incoming(s.r))).messages[1].content='changed';assert.deepEqual((await s.c.recover('scope',incoming(s.r))).messages[1],a);});
test('ambiguous catalog results rejected',async()=>{const s=setup(),a=patch(s),o=clone(s.r);o[1]=a;s.c.complete(s.t,o);const t=s.c.begin('scope',s.r,'r-second');s.c.complete(t,s.r);assert.equal((await s.c.recover('scope',incoming(s.r))).status,'conflict');});
