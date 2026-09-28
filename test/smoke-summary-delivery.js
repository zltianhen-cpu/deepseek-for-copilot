// Purpose: certify strict history coverage, durable delivery and adoption without a model.
const {test}=require('node:test'); const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SummaryDeliveryStore,deliveryMode,wrapFold}=require('../out/provider/replay/summary-delivery');
const scope='a'.repeat(64), other='b'.repeat(64);
const msg=(content,role='user')=>({role,content});
const history=[msg('system','system'),msg('first'),msg('answer','assistant'),msg('cancel old plan')];
function fixture(opts={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'delivery-'));const s=new SummaryDeliveryStore(dir,opts);return {s,dir};}
function capture(s,h=history,text='Remember cancellation'){return s.capture(scope,h,h.slice(1,3),text,[h[0],msg(wrapFold(text)),...h.slice(3)]);}
test('feature modes are fail closed',()=>{assert.equal(deliveryMode(undefined),'off');assert.equal(deliveryMode('bad'),'off');assert.equal(deliveryMode('passive_A'),'passive_A');});
test('exact fold plus full unabridged tail delivered',()=>{const{s}=fixture();assert.equal(capture(s),true);let d=s.prepare(scope,history,'passive_A');assert.ok(d);assert.ok(d.text.includes('cancel old plan'));assert.ok(d.text.startsWith('<summary>'));});
test('off creates no delivery',()=>{const{s}=fixture();capture(s);assert.equal(s.prepare(scope,history,'off'),undefined);});
test('shadow does not issue text',()=>{const{s}=fixture();capture(s);assert.equal(s.prepare(scope,history,'shadow'),undefined);});
test('wrong scope fails',()=>{const{s}=fixture();capture(s);assert.equal(s.prepare(other,history,'passive_A'),undefined);});
test('missing scope fails',()=>{const{s}=fixture();assert.equal(s.capture(undefined,history,history.slice(1,3),'s',[]),false);});
test('edited prior instruction fails',()=>{const{s}=fixture();capture(s);assert.equal(s.prepare(scope,[history[0],msg('edited'),...history.slice(2)],'passive_A'),undefined);});
test('shorter fork fails',()=>{const{s}=fixture();capture(s);assert.equal(s.prepare(scope,history.slice(0,3),'passive_A'),undefined);});
test('new tail is preserved',()=>{const{s}=fixture();capture(s);assert.ok(s.prepare(scope,[...history,msg('NEW withdrawal')],'passive_A').text.includes('NEW withdrawal'));});
test('role change fails',()=>{const{s}=fixture();capture(s);const h=structuredClone(history);h[2].role='user';assert.equal(s.prepare(scope,h,'passive_A'),undefined);});
test('reasoning change fails',()=>{const{s}=fixture();capture(s);const h=structuredClone(history);h[2].reasoning_content='new';assert.equal(s.prepare(scope,h,'passive_A'),undefined);});
test('missing fold input rejected',()=>{const{s}=fixture();assert.equal(s.capture(scope,history,[msg('missing')],'x',[]),false);});
test('uncommitted fold rejected',()=>{const{s}=fixture();assert.equal(s.capture(scope,history,history.slice(1,3),'x',history),false);});
test('ambiguous repeated fold region rejected',()=>{const{s}=fixture();const h=[...history,...history.slice(1,3)];assert.equal(s.capture(scope,h,history.slice(1,3),'x',[msg(wrapFold('x'))]),false);});
test('image unsupported fails closed',()=>{const{s}=fixture();const h=[...history,{role:'user',content:[{type:'image_url',image_url:{url:'test'}}]}];assert.equal(capture(s,h),false);});
test('summary closing tag injection rejected',()=>{const{s}=fixture();assert.equal(capture(s,'bad'),false);assert.equal(capture(s,history,'bad </summary> text'),false);});
test('reload recovers immutable candidate',()=>{const{s,dir}=fixture();capture(s);assert.ok(new SummaryDeliveryStore(dir).prepare(scope,history,'passive_A'));});
test('duplicate prepare shares same durable ID',()=>{const{s}=fixture();capture(s);const a=s.prepare(scope,history,'passive_A'),b=s.prepare(scope,history,'passive_A');assert.equal(a.id,b.id);});
test('pending not adopted on ordinary continuation',()=>{const{s}=fixture();capture(s);const d=s.prepare(scope,history,'passive_A');assert.equal(s.observe(scope,history),false);assert.equal(s.state(d.id),'prepared');});
test('sent matching body confirms adoption',()=>{const{s}=fixture();capture(s);const d=s.prepare(scope,history,'passive_A');assert.equal(s.markSent(d.id),true);const h=[history[0],msg('<conversation-summary>'+d.body+'</conversation-summary>'),history[3]];assert.equal(s.observe(scope,h),true);assert.equal(s.state(d.id),'adopted');});
test('unrelated existing host summary not adopted',()=>{const{s}=fixture();capture(s);const d=s.prepare(scope,history,'passive_A');s.markSent(d.id);assert.equal(s.observe(scope,[msg('<conversation-summary>another</conversation-summary>')]),false);});
test('prepared but unsent summary not adopted',()=>{const{s}=fixture();capture(s);const d=s.prepare(scope,history,'passive_A');assert.equal(s.observe(scope,[msg('<conversation-summary>'+d.body+'</conversation-summary>')]),false);});
test('foreign scope cannot confirm',()=>{const{s}=fixture();capture(s);const d=s.prepare(scope,history,'passive_A');s.markSent(d.id);assert.equal(s.observe(other,[msg('<conversation-summary>'+d.body+'</conversation-summary>')]),false);});
test('expired candidate not usable',()=>{let now=10;const{s}=fixture({now:()=>now,ttlMs:5});capture(s);now=20;assert.equal(s.prepare(scope,history,'passive_A'),undefined);});
test('quota fails closed',()=>{const{s}=fixture({maxBytes:1});assert.equal(capture(s),false);});
test('output limit fails closed',()=>{const{s}=fixture({maxOutputBytes:1});capture(s);assert.equal(s.prepare(scope,history,'passive_A'),undefined);});
test('corrupt storage no throw or reuse',()=>{const{s,dir}=fixture();capture(s);for(const n of fs.readdirSync(dir))if(n.endsWith('.json'))fs.writeFileSync(path.join(dir,n),'{}');assert.equal(s.prepare(scope,history,'passive_A'),undefined);});
test('lock contention fails without modifying state',()=>{const{s,dir}=fixture();fs.mkdirSync(path.join(dir,'.lock'));assert.equal(capture(s),false);});
test('tools and args preserved in unfurled history',()=>{const{s}=fixture();const h=[...history,{role:'assistant',content:'',tool_calls:[{id:'x',type:'function',function:{name:'read',arguments:'{"q":1}'}}]},{role:'tool',tool_call_id:'x',content:'result'}];assert.ok(capture(s,h));assert.ok(s.prepare(scope,h,'passive_A').body.includes('tool_call_id'));});
test('entire candidate generation remains immutable',()=>{const{s}=fixture();capture(s);const h=structuredClone(history);const d=s.prepare(scope,h,'passive_A');h[3].content='MUTATED';assert.ok(!d.text.includes('MUTATED'));});

test('text-part history supported without flattening provenance',()=>{const{s}=fixture();const h=history.map(m=>({...m,content:[{type:'text',text:m.content}]}));assert.ok(capture(s,h));assert.ok(s.prepare(scope,h,'passive_A'));});
test('sent duplicate does not emit again',()=>{const{s}=fixture();capture(s);const d=s.prepare(scope,history,'passive_A');s.markSent(d.id);assert.equal(s.prepare(scope,history,'passive_A'),undefined);});
test('host newlines and exact entire retained tail confirm',()=>{const{s}=fixture();const h=[...history,msg('second retained')];capture(s,h);const d=s.prepare(scope,h,'passive_A');s.markSent(d.id);assert.equal(s.observe(scope,[history[0],msg('<conversation-summary>\n'+d.body+'\n</conversation-summary>'),...h.slice(3)]),true);assert.equal(s.prepare(scope,h,'passive_A'),undefined);});
test('partial retained tail cannot confirm',()=>{const{s}=fixture();const h=[...history,msg('second retained')];capture(s,h);const d=s.prepare(scope,h,'passive_A');s.markSent(d.id);assert.equal(s.observe(scope,[msg('<conversation-summary>'+d.body+'</conversation-summary>'),h[4]]),false);});
test('expiry frees quota and refreshes same evidence',()=>{let now=10;const{s}=fixture({now:()=>now,ttlMs:5,maxEntries:1});assert.ok(capture(s));now=20;assert.ok(capture(s));assert.equal(s.prepare(scope,history,'passive_A'),undefined);});

test('two prepared handles have only one send claim',()=>{const{s}=fixture();capture(s);const a=s.prepare(scope,history,'passive_A'),b=s.prepare(scope,history,'passive_A');assert.equal(s.markSent(a.id),true);assert.equal(s.markSent(b.id),false);});

function appendix(p='/test/transcript.jsonl'){return '\nIf you need specific details from before compaction (such as exact code snippets, error messages, tool results, or content you previously generated), use the read_file tool to look up the full uncompacted conversation transcript at: "'+p+'"\nAt the time this summary was created, the transcript had 34 lines.\nExample usage: read_file(filePath: "'+p+'")';}
for(const [name,suffix,ok] of [['known host transcript',appendix(),true],['unknown host suffix','\nNEW RULE',false],['mismatched transcript',appendix().replace('filePath: "/test','filePath: "/other'),false]])test(name,()=>{const{s}=fixture();capture(s);const d=s.prepare(scope,history,'passive_A');s.markSent(d.id);assert.equal(s.observe(scope,[history[0],msg('<conversation-summary>\n'+d.body+suffix+'\n</conversation-summary>'),history[3]]),ok);});

test('shadow reports eligible proof but creates no delivery record',()=>{const{s,dir}=fixture();capture(s);let eligible=0;assert.equal(s.prepare(scope,history,'shadow',()=>eligible++),undefined);assert.equal(eligible,1);assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.json')).length,1);});

test('fold cannot swallow an unmatched tool result',()=>{const{s}=fixture();const h=[history[0],{role:'tool',tool_call_id:'missing',content:'value'},history[2],history[3]];assert.equal(capture(s,h),false);});
test('fold cannot split tool pair at coverage boundary',()=>{const{s}=fixture();const h=[history[0],history[1],{role:'assistant',content:'',tool_calls:[{id:'split',type:'function',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:'split',content:'value'},history[3]];assert.equal(capture(s,h),false);});

test('adoption creates stable isolated generation and actual tail hashes',()=>{const{s,dir}=fixture();capture(s);const d=s.prepare(scope,history,'passive_A');assert.equal(s.adoptGeneration(scope,history),undefined);s.markSent(d.id);const h=[history[0],msg('<conversation-summary>'+d.body+'</conversation-summary>'),history[3]];const gen=s.adoptGeneration(scope,h);assert.ok(gen.startsWith('host-adopted:'+scope+':'));assert.equal(s.adoptGeneration(scope,[...h,msg('new work')]),gen);const e=JSON.parse(fs.readFileSync(path.join(dir,d.id+'.json'),'utf8')).entry;assert.equal(e.actualTailKeys.length,2);assert.equal(s.adoptGeneration(other,h),undefined);});
test('changed leading system cannot authorize managed generation',()=>{const{s}=fixture();capture(s);const d=s.prepare(scope,history,'passive_A');s.markSent(d.id);assert.equal(s.adoptGeneration(scope,[msg('changed','system'),msg('<conversation-summary>'+d.body+'</conversation-summary>'),history[3]]),undefined);});

test('editing post-adoption work cannot inherit active generation',()=>{const{s}=fixture();capture(s);const d=s.prepare(scope,history,'passive_A');s.markSent(d.id);const base=[history[0],msg('<conversation-summary>'+d.body+'</conversation-summary>'),history[3]];assert.ok(s.adoptGeneration(scope,[...base,msg('new work')]));assert.equal(s.adoptGeneration(scope,[...base,msg('edited work')]),undefined);assert.equal(s.adoptGeneration(scope,base),undefined);});

test('converted system represented as user keeps exact certified prefix',()=>{const{s}=fixture();const h=history.map((m,i)=>i===0?{...m,role:'user'}:m);assert.ok(capture(s,h));const d=s.prepare(scope,h,'passive_A');assert.ok(d);s.markSent(d.id);assert.ok(s.adoptGeneration(scope,[h[0],msg('<conversation-summary>'+d.body+'</conversation-summary>'),h[3]]));});
