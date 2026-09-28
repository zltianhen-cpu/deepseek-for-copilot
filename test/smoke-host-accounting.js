// Purpose: raw host measurement must not use routing discounts; ratio logs are observations only.
'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const path=require('node:path');
const lines=[];
class Text{constructor(value){this.value=value;}}
class Call{constructor(callId,name,input){Object.assign(this,{callId,name,input});}}
class Result{constructor(callId,content){Object.assign(this,{callId,content});}}
class Data{constructor(data,mimeType){Object.assign(this,{data,mimeType});}}
class Thinking{constructor(value){this.value=value;}}
let filter=()=>{};
const fakeFilter={filterOpenAIMessagesQueued:(...args)=>filter(...args)};
const vscode={env:{language:'en'},workspace:{workspaceFolders:[],getConfiguration:()=>({get:(_k,d)=>d,inspect:()=>({})})},window:{createOutputChannel:()=>Object.fromEntries(['info','warn','error','debug'].map(x=>[x,m=>lines.push(m)]))},LanguageModelTextPart:Text,LanguageModelToolCallPart:Call,LanguageModelToolResultPart:Result,LanguageModelDataPart:Data,LanguageModelThinkingPart:Thinking,LanguageModelChatMessageRole:{User:1,Assistant:2,System:3}};
process.env.DEEPSEEK_AUTOBUILD_OFF='1';
const load=Module._load;Module._load=function(id,...args){if(id==='vscode')return vscode;if(id.endsWith('/skill_filter.js'))return fakeFilter;return load.call(this,id,...args);};
const root=process.env.CACHE_EXTENSION_TEST_DIR||path.join(__dirname,'..');
const T=require(path.join(root,'out/provider/tokens.js'));
const H=require(path.join(root,'out/provider/chat-hooks.js'));
const cat='<skills><skill><name>fixture</name><description>'+'x'.repeat(3000)+'</description></skill></skills>';
const msg=parts=>({role:1,content:parts});
for(const mode of ['raw','real-send'])for(const share of [.02,.1,.5])test(`raw measurement invariant ${mode}/${share}`,()=>{T.setTokenCountMode(mode);T.setSkillCatalogKeptShare(share);assert.equal(T.estimateMessageChars([msg([new Text(cat)])]),cat.length);});
test('nested tool result uses raw text',()=>{T.setTokenCountMode('real-send');T.setSkillCatalogKeptShare(.1);assert.equal(T.estimateMessageChars([msg([new Result('outer',[new Result('inner',[new Text(cat)])])])]),10+cat.length);});
test('multiple catalogs all counted raw',()=>{assert.equal(T.estimateMessageChars([msg([new Text(cat+cat)])]),cat.length*2);});
test('split parts counted without mutation',()=>{const a=[msg([new Text(cat.slice(0,300)),new Text(cat.slice(300))])],s=JSON.stringify(a);assert.equal(T.estimateMessageChars(a),cat.length);assert.equal(JSON.stringify(a),s);});
test('thinking strings and arrays preserved',()=>{assert.equal(T.estimateMessageChars([msg([new Thinking('abc'),new Thinking(['x','yz'])])]),6);});
test('image bytes not raw text',()=>{assert.equal(T.estimateMessageChars([msg([new Data(new Uint8Array(40000),'image/png')])]),0);});
test('null and missing content safe',()=>{assert.equal(T.estimateMessageChars(null),0);assert.equal(T.estimateMessageChars([{}]),0);});
test('tool call accounting unchanged',()=>{const p=new Call('c','read',{text:cat});assert.equal(T.estimateMessageChars([msg([p])]),5+JSON.stringify(p.input).length);});
test('host count legacy path unchanged by raw observation',()=>{T.setTokenCountMode('real-send');T.setSkillCatalogKeptShare(.1);const before=T.estimateTokenCount(cat,4);T.estimateMessageChars([msg([new Text(cat)])]);assert.equal(T.estimateTokenCount(cat,4),before);assert.equal(before,Math.ceil(cat.length*.1/4));});
test('global ratio cannot alter anonymous count',()=>{const before=T.estimateTokenCount('x'.repeat(4000),4);T.setRealSendRatio(.05);assert.equal(T.isRealSendRatioActive(),false);assert.equal(T.estimateTokenCount('x'.repeat(4000),4),before);});
async function observe(host,output=1000,id='r-fixture',fn){lines.length=0;filter=fn||((messages)=>{messages[0].content='y'.repeat(output);});const messages=[{role:'user',content:'x'.repeat(4000)}];await H.applyMessageFilter(messages,{hostMessageChars:host,requestId:id});return lines.filter(x=>x.includes('[fold-ratio]')).join('\n');}
test('log identifies raw host basis and request',async()=>{const s=await observe(8000);assert.match(s,/requestId=r-fixture/);assert.match(s,/basis=host-raw/);assert.match(s,/r=0.125/);});
test('log cannot be mistaken for actual token discount',async()=>{const s=await observe(8000);assert.match(s,/unit=characters/);assert.match(s,/phase=filtered-candidate/);assert.match(s,/hostDiscount=disabled/);});
for(const host of [0,-1,NaN,Infinity,undefined])test(`invalid or missing host fallback ${host}`,async()=>{const s=await observe(host);assert.match(s,/basis=converted/);assert.match(s,/r=0.250/);assert.doesNotMatch(s,/(?:host|r)=(?:NaN|Infinity)/);});
test('missing id explicit unknown',async()=>{assert.match(await observe(8000,1000,''),/requestId=unknown/);});
test('untrusted id cannot inject log records',async()=>{const s=await observe(8000,1000,'r-x\nspoof=yes');assert.match(s,/requestId=unknown/);assert.doesNotMatch(s,/spoof/);});
test('zero output has no misleading ratio',async()=>{assert.equal(await observe(8000,0),'');});
test('expansion ratio not clipped into fictional saving',async()=>{assert.match(await observe(4000,8000),/r=2.000/);});
test('hook failure publishes no ratio and no host discount',async()=>{assert.equal(await observe(8000,1000,'r-fixture',()=>{throw new Error('fixture');}),'');assert.equal(T.isRealSendRatioActive(),false);});
