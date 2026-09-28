// 用途：相同合成目录比较日志底座写入开销；仅临时数据，无绝对耗时闸值。
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {performance}=require('node:perf_hooks');
const M=require(path.resolve(process.argv[2]||path.join(__dirname,'../resources/hooks/event_log')));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'log-bench-'));
try {
 for(const full of [false,true]) {
  const dir=path.join(tmp,full?'full':'normal');fs.mkdirSync(dir);
  for(let i=0;i<757;i++)fs.writeFileSync(path.join(dir,'host-fixture-'+i+'.jsonl'),full?'x'.repeat(200):'');
  const opts={dir,limits:{maxDirBytes:full?757*200:128*1024*1024}};
  M._reset();M.reportEvent({eventCode:'WARM',incidentKey:'warm'},opts);
  const orig=fs.readdirSync;let scans=0;fs.readdirSync=(...a)=>{scans++;return orig(...a)};
  const durations=[];let failed=0;
  try{for(let i=0;i<100;i++){const t=performance.now();const r=M.reportEvent({eventCode:'BENCH',incidentKey:'bench-'+i},opts);durations.push(performance.now()-t);if(!r.ok)failed++;}}finally{fs.readdirSync=orig}
  durations.sort((a,b)=>a-b);
  console.log(JSON.stringify({scenario:full?'full-warm':'normal-warm',writes:100,failed,scans,p50ms:durations[49],p95ms:durations[94],dropped:M.getStatus?M.getStatus().dropped:null}));
 }
}finally{fs.rmSync(tmp,{recursive:true,force:true})}
