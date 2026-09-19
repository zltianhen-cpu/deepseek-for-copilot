#!/usr/bin/env node
// 用途：只读分析双形态候选；按上海日期、会话和请求种类隔离，只用 requestId 关联 usage。
// 设计：流式读行后只保留白名单元数据，不输出正文；重复或冲突证据显式降级，不猜因果。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const deletionReasons = new Set(['user-edit', 'history-mismatch', 'source-system-changed']);
const string = value => typeof value === 'string' && value.length > 0 ? value : undefined;
function parseArgs(argv) {
 const args = {};
 for (let i=0;i<argv.length;i+=2) {
  if (!['--stats','--events','--date','--pid'].includes(argv[i]) || !argv[i+1] || args[argv[i]]) throw new Error('invalid-arguments');
  args[argv[i]]=argv[i+1];
 }
 if (!args['--date'] || !/^\d{4}-\d{2}-\d{2}$/.test(args['--date'])) throw new Error('date-required-YYYY-MM-DD');
 const parsed=Date.parse(args['--date']+'T00:00:00Z');
 if (!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==args['--date']) throw new Error('invalid-date');
 if (!args['--stats']||!args['--events']) throw new Error('stats-and-events-required');
 if (args['--pid'] && (!/^\d+$/.test(args['--pid']) || !Number.isSafeInteger(Number(args['--pid'])) || Number(args['--pid'])<=0)) throw new Error('invalid-pid');
 return {date:args['--date'], stats:args['--stats'], events:args['--events'], pid:args['--pid']?Number(args['--pid']):null};
}
function stamp(value) {
 // 禁止把无时区时间按运行机器的本地时区解释。
 if(typeof value!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null;
 const ms=Date.parse(value);if(!Number.isFinite(ms))return null;
 return {ms, iso:new Date(ms).toISOString(), date:new Date(ms+8*3600_000).toISOString().slice(0,10)};
}
async function lines(file, type, report, visit) {
 const input=fs.createReadStream(file,{encoding:'utf8'});
 const reader=readline.createInterface({input,crlfDelay:Infinity});let lineNo=0;
 try {
  for await(const line of reader) {
   lineNo++;if(!line.trim())continue;
   let obj,prefix;
   try {
    const i=line.indexOf('{');if(i<0)throw new Error();prefix=line.slice(0,i).trim();obj=JSON.parse(line.slice(i));
    if(!obj||typeof obj!=='object'||Array.isArray(obj))throw new Error();
   }catch {report.badLines[type]++;continue;}
   visit(obj,{prefix,line:lineNo,file:path.basename(file)});
  }
 } finally {reader.close();input.destroy();}
}
function validUsage(row) {
 return ['input','output','hit','miss'].every(k=>Number.isSafeInteger(row[k])&&row[k]>=0);
}
async function analyze(args) {
 const report={schemaVersion:1,date:args.date,timezone:'Asia/Shanghai',pidFilter:args.pid,selectedStats:0,
  badLines:{stats:0,events:0},duplicateStats:0,duplicateUsage:{identical:0,conflicting:0},unmatchedUsage:0,
  uncertainties:{invalidTimestamp:0,missingSession:0,missingKind:0,missingHash:0,ambiguousStatsIds:0,invalidUsage:0,eventMissingRequestId:0,unknownResetReason:0},groups:[],
  limitations:['哈希变化仅是候选，不证明具体正文差异、制造者或费用因果。','PID 仅筛选进程，不作为会话身份；缺 requestId 不按时间配对。','删除计数要求 canonReset=true 且原因属于已核实删除分支，debounced 从不算删除。']};
 const events=new Map();
 const entries=fs.readdirSync(args.events,{withFileTypes:true}).filter(e=>e.isFile()&&e.name.endsWith('.jsonl')).map(e=>e.name).sort();
 for(const name of entries)await lines(path.join(args.events,name),'events',report,(row)=>{
  const ts=stamp(row.timestampUtc??row.ts??row.timestamp);if(!ts){report.uncertainties.invalidTimestamp++;return;}if(ts.date!==args.date)return;
  const id=string(row.requestId);if(!id){report.uncertainties.eventMissingRequestId++;return;}
  let e=events.get(id);if(!e){e={kinds:new Set(),finalKinds:new Set(),usage:[],unavailable:false};events.set(id,e);}
  const kind=string(row.requestKind);if(kind)e.kinds.add(kind);
  // PREPARE 发生在最终分类之前；实际发送/usage 的种类才有优先权。
  if(kind&&['SEND_ATTEMPT','USAGE_OBSERVED','USAGE_UNAVAILABLE'].includes(row.eventCode))e.finalKinds.add(kind);
  if(row.eventCode==='USAGE_UNAVAILABLE')e.unavailable=true;
  if(row.eventCode==='USAGE_OBSERVED') {
   if(!validUsage(row)){report.uncertainties.invalidUsage++;e.invalid=true;return;}
   e.usage.push({kind:kind??'unknown',input:row.input,output:row.output,hit:row.hit,miss:row.miss});
  }
 });
 for(const e of events.values()) {
  const unique=new Map();for(const u of e.usage)unique.set(JSON.stringify(u),u);
  report.duplicateUsage.identical+=e.usage.length-unique.size;
  e.conflicting=unique.size>1;if(e.conflicting)report.duplicateUsage.conflicting++;
  e.exact=unique.size===1?[...unique.values()][0]:null;
 }
 const rows=[],seen=new Set(),idStats=new Map();
 await lines(args.stats,'stats',report,(row,loc)=>{
  const ts=stamp(loc.prefix||row.timestamp||row.ts);if(!ts){report.uncertainties.invalidTimestamp++;return;}if(ts.date!==args.date)return;
  const pid=row.runtime?.pid??row.pid;if(args.pid!==null&&pid!==args.pid)return;
  const id=string(row.requestId),session=string(row.foldSessionKey)??string(row.sessionKey);
  let kind=string(row.requestKind)??string(row.kind);const e=id?events.get(id):null;
  const eventKinds=e?.finalKinds.size?e.finalKinds:e?.kinds;
  if(!kind&&eventKinds?.size===1)kind=[...eventKinds][0];if(!kind){kind='unknown';report.uncertainties.missingKind++;}
  const data={timestamp:ts.iso,ms:ts.ms,requestId:id,sessionKey:session,kind,pid:Number.isSafeInteger(pid)?pid:null,
   hash:string(row.inHeadHash8),reason:string(row.canonReason)??'unknown',reset:row.canonReset===true};
  const identity=JSON.stringify(data);if(seen.has(identity)){report.duplicateStats++;return;}seen.add(identity);
  report.selectedStats++;
  if(id){let ids=idStats.get(id);if(!ids){ids=new Set();idStats.set(id,ids);}ids.add(identity);}
  if(!session){report.uncertainties.missingSession++;return;}
  if(!data.hash)report.uncertainties.missingHash++;
  rows.push({...data,line:loc.line});
 });
 const ambiguous=new Set([...idStats].filter(([,s])=>s.size>1).map(([id])=>id));report.uncertainties.ambiguousStatsIds=ambiguous.size;
 const groups=new Map(),usedIds=new Set();
 for(const row of rows) {
  const key=JSON.stringify([args.date,row.sessionKey,row.kind]);let g=groups.get(key);
  if(!g){g={date:args.date,sessionKey:row.sessionKey,kind:row.kind,pids:new Set(),rows:[],deletions:0,debounced:0,deletionReasons:{},hashCounts:{},transitions:[],usage:{matched:0,missingRequestId:0,missing:0,unavailable:0,ambiguous:0,kindMismatch:0,input:0,output:0,hit:0,miss:0}};groups.set(key,g);}
  g.rows.push(row);if(row.pid!==null)g.pids.add(row.pid);if(row.hash)g.hashCounts[row.hash]=(g.hashCounts[row.hash]??0)+1;
  if(row.reason.endsWith('-debounced'))g.debounced++;
  else if(row.reset&&deletionReasons.has(row.reason)){g.deletions++;g.deletionReasons[row.reason]=(g.deletionReasons[row.reason]??0)+1;}
  else if(row.reset)report.uncertainties.unknownResetReason++;
  const id=row.requestId,e=id?events.get(id):null;
  if(!id){g.usage.missingRequestId++;continue;}
  if(ambiguous.has(id)||e?.conflicting||e?.invalid){g.usage.ambiguous++;continue;}
  if(!e?.exact){if(e?.unavailable)g.usage.unavailable++;else g.usage.missing++;continue;}
  if(e.exact.kind!==row.kind||row.kind==='unknown'){g.usage.kindMismatch++;continue;}
  usedIds.add(id);g.usage.matched++;for(const k of ['input','output','hit','miss'])g.usage[k]+=e.exact[k];
 }
 for(const g of groups.values()) {
  g.rows.sort((a,b)=>a.ms-b.ms||a.line-b.line);
  for(let i=1;i<g.rows.length;i++) {
   const previous=g.rows[i-1],current=g.rows[i];
   if(previous.hash&&current.hash&&previous.hash!==current.hash)g.transitions.push({classification:'candidate-only',from:previous.hash,to:current.hash,
    previousRequestId:previous.requestId??null,requestId:current.requestId??null,timestamp:current.timestamp,
    orderUncertain:previous.ms===current.ms,canonReason:current.reason,deletion:current.reset&&deletionReasons.has(current.reason)});
  }
  g.transitionDeletions=g.transitions.filter(t=>t.deletion).length;
  g.transitionDebounced=g.transitions.filter(t=>t.canonReason.endsWith('-debounced')).length;
  g.stats=g.rows.length;g.usage.coverage=g.stats?g.usage.matched/g.stats:0;g.pids=[...g.pids].sort((a,b)=>a-b);delete g.rows;report.groups.push(g);
 }
 report.groups.sort((a,b)=>a.sessionKey.localeCompare(b.sessionKey)||a.kind.localeCompare(b.kind));
 for(const [id,e] of events)if(e.usage.length&&!usedIds.has(id))report.unmatchedUsage++;
 return report;
}
try {const args=parseArgs(process.argv.slice(2));process.stdout.write(JSON.stringify(await analyze(args),null,2)+'\n');}
catch(error){process.stderr.write(JSON.stringify({error:error?.code??error?.message??'probe-failed'})+'\n');process.exitCode=1;}
