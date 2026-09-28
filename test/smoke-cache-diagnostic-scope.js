// 用途：诊断不得把不同会话段当作同会话历史变动；不改变发送请求。
'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const path=require('node:path');
const lines=[];
const Text=class{constructor(value){this.value=value;}};
const Empty=class{};
const vscode={env:{language:'en'},window:{createOutputChannel:()=>Object.fromEntries(['info','warn','debug','error','appendLine'].map(k=>[k,x=>lines.push(x)]))},workspace:{getConfiguration:()=>({get:(k,d)=>k==='debugMode'?'metadata':d,inspect:()=>({globalValue:'metadata'})})},LanguageModelChatMessageRole:{User:1,Assistant:2,System:3},LanguageModelTextPart:Text,LanguageModelDataPart:Empty,LanguageModelThinkingPart:Empty,LanguageModelToolCallPart:Empty,LanguageModelToolResultPart:Empty};
const orig=Module._load;Module._load=function(id,...args){return id==='vscode'?vscode:orig.call(this,id,...args);};
const root=process.env.CACHE_DIAGNOSTICS_OUT || path.join(__dirname,'..','out');
const {createCacheDiagnosticsRecorder}=require(path.join(root,'provider/debug/diagnostics.js'));
function send(rec,seg,head='system-a',count=8,extra={}){
 const request={model:'deepseek-flash',messages:[{role:'system',content:head},...Array.from({length:count},(_,i)=>({role:i%2?'assistant':'user',content:`message-${i}`}))],...extra.request};
 const before=JSON.stringify(request);lines.length=0;
 const run=rec.beginRequest({request,segment:{segmentId:seg,reason:'markerFound'},requestKind:extra.kind||'main-agent',vscodeModelId:'deepseek-flash',isThinkingModel:false,thinkingEffort:'none',inputMessages:[],resolvedMessages:[]});
 run.onUsage({prompt_tokens:1000,prompt_cache_hit_tokens:990,prompt_cache_miss_tokens:10,completion_tokens:10,total_tokens:1010},4);
 run.onDone({reasoningTextChars:0,emittedToolCalls:0,trailingToolResults:0});
 assert.equal(JSON.stringify(request),before);return lines.join('\n');
}
const noHistory=x=>assert.doesNotMatch(x,/fallback diff:|message count decreased|retained history changed/);
test('different segments with different heads do not report compaction',()=>{const r=createCacheDiagnosticsRecorder();send(r,'A');noHistory(send(r,'B','system-b',2));});
test('same head cannot merge different segment histories',()=>{const r=createCacheDiagnosticsRecorder();send(r,'A');noHistory(send(r,'B','system-a',2));});
test('A B A resumes A history despite B shorter shape',()=>{const r=createCacheDiagnosticsRecorder();send(r,'A');send(r,'B','system-b',2);noHistory(send(r,'A','system-a',10));});
test('A B A detects actual A history shrink',()=>{const r=createCacheDiagnosticsRecorder();send(r,'A');send(r,'B','system-b',2);assert.match(send(r,'A','system-a',3),/message count decreased/);});
test('same segment system change remains visible',()=>{const r=createCacheDiagnosticsRecorder();send(r,'A');assert.match(send(r,'A','system-b'),/fallback diff: system prompt changed/);});
test('same segment shrink remains visible',()=>{const r=createCacheDiagnosticsRecorder();send(r,'A');assert.match(send(r,'A','system-a',2),/message count decreased/);});
test('same segment append produces no history warning',()=>{const r=createCacheDiagnosticsRecorder();send(r,'A');noHistory(send(r,'A','system-a',10));});
test('model switch is separate even with same segment',()=>{const r=createCacheDiagnosticsRecorder();send(r,'A');noHistory(send(r,'A','system-b',2,{request:{model:'other-model'}}));});
test('tools switch is separate even when first message identical',()=>{const r=createCacheDiagnosticsRecorder();send(r,'A');noHistory(send(r,'A','system-a',2,{request:{tools:[{type:'function',function:{name:'x',description:'x',parameters:{type:'object'}}}]}}));});
test('request kind switch is separate',()=>{const r=createCacheDiagnosticsRecorder();send(r,'A');noHistory(send(r,'A','system-b',2,{kind:'background'}));});
test('missing segment does not create shared anonymous bucket',()=>{const r=createCacheDiagnosticsRecorder();send(r,'');noHistory(send(r,'','system-a',2));});
test('three segments interleave without false warnings',()=>{const r=createCacheDiagnosticsRecorder();for(let n=0;n<3;n++)for(const [s,h,c] of [['A','a',9],['B','b',3],['C','c',7]])noHistory(send(r,s,h,c+n));});
