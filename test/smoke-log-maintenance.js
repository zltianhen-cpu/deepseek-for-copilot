const { symlinkFixture } = require('../tools/test-symlink.cjs');
// 用途：诊断预算、失效恢复、活跃保护及并发回归；仅操作临时目录。
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'log-maintenance-'));
const M=require('../resources/hooks/event_log');
after(()=>fs.rmSync(root,{recursive:true,force:true}));
let seq=0;
function setup(){M._reset();const dir=path.join(root,String(++seq));fs.mkdirSync(dir);return dir;}
function write(dir,i=0,limits={}){return M.reportEvent({eventCode:'FIXTURE',incidentKey:'test-'+i,details:{n:i}},{dir,limits});}
function old(dir,name,size=1000,hours=3){const f=path.join(dir,name);fs.writeFileSync(f,'x'.repeat(size));const d=new Date(Date.now()-hours*3600000);fs.utimesSync(f,d,d);return f;}
function size(dir){return fs.readdirSync(dir).reduce((n,f)=>n+fs.lstatSync(path.join(dir,f)).size,0);}
function scans(fn){const orig=fs.readdirSync;let n=0;fs.readdirSync=(...a)=>{n++;return orig(...a)};try{fn();return n;}finally{fs.readdirSync=orig;}}
test('100 writes need at most two full scans',()=>{const d=setup();const n=scans(()=>{for(let i=0;i<100;i++)assert.equal(write(d,i).ok,true)});assert.ok(n<=2,'scans='+n);});
test('dead old host reclaimed under pressure',()=>{const d=setup(),f=old(d,'host-2147483647-abcd.jsonl');assert.equal(write(d,0,{maxDirBytes:1000}).ok,true);assert.equal(fs.existsSync(f),false);});
test('dead old host age retention applies without pressure',()=>{const d=setup(),f=old(d,'host-2147483647-abcd.jsonl',100,24*30);assert.equal(write(d).ok,true);assert.equal(fs.existsSync(f),false);});
test('live old host never deleted',()=>{const d=setup(),f=old(d,`host-${process.pid}-abcd.jsonl`,1000,24*30);assert.equal(write(d,0,{maxDirBytes:1000}).ok,false);assert.ok(fs.existsSync(f));});
test('recent dead host retained',()=>{const d=setup(),f=old(d,'host-2147483647-abcd.jsonl',1000,0);assert.equal(write(d,0,{maxDirBytes:1000}).ok,false);assert.ok(fs.existsSync(f));});
test('unknown identity retained',()=>{const d=setup(),f=old(d,'host-custom.jsonl',1000,24*30);assert.equal(write(d,0,{maxDirBytes:1000}).ok,false);assert.ok(fs.existsSync(f));});
test('permission denied PID probe retains host',()=>{const d=setup(),f=old(d,'host-42-abcd.jsonl');const k=process.kill;process.kill=()=>{throw Object.assign(Error(),{code:'EPERM'})};try{assert.equal(write(d,0,{maxDirBytes:1000}).ok,false);assert.ok(fs.existsSync(f));}finally{process.kill=k;}});
test('current host is retained even with custom dead PID',()=>{const d=setup(),f=old(d,'host-2147483647-abcd.jsonl');const r=M.reportEvent({eventCode:'NOW'},{dir:d,hostInstance:'2147483647-abcd',limits:{maxDirBytes:1100}});assert.equal(r.ok,false);assert.ok(fs.existsSync(f));});
test('warm full directory drops 100 times without scans',()=>{const d=setup();old(d,'host-custom.jsonl');write(d,0,{maxDirBytes:1000});const before=M.getStatus().dropped;const n=scans(()=>{for(let i=1;i<=100;i++)assert.equal(write(d,i,{maxDirBytes:1000}).ok,false)});assert.equal(n,0);assert.equal(M.getStatus().dropped-before,100);});
test('failed event is retried after budget changes',()=>{const d=setup();old(d,'host-custom.jsonl');assert.equal(write(d,1,{maxDirBytes:1000}).ok,false);assert.equal(write(d,1,{maxDirBytes:10000}).ok,true);});
test('disabled does not count as dropped',()=>{const d=setup();assert.equal(M.reportEvent({}, {dir:d,enabled:false}).skipped,true);assert.equal(M.getStatus().dropped,0);});
test('bad directory failure counted and does not throw',()=>{const d=setup(),f=old(d,'file');assert.equal(write(f).ok,false);assert.equal(M.getStatus().dropped,1);});
test('symlink log target never written',()=>{const d=setup(),external=path.join(root,'protected');fs.writeFileSync(external,'SAFE');symlinkFixture(external,path.join(d,'host-'+M.defaultHost()+'.jsonl'));assert.equal(write(d).ok,false);assert.equal(fs.readFileSync(external,'utf8'),'SAFE');});
test('symlink dead file never unlinked',()=>{const d=setup(),f=path.join(d,'host-2147483647-abcd.jsonl');symlinkFixture(path.join(root,'absent'),f);write(d);assert.ok(fs.lstatSync(f).isSymbolicLink());});
test('only known backup filenames eligible',()=>{const d=setup(),f=old(d,'important.bak',1000,24*30);assert.equal(write(d,0,{maxDirBytes:1000}).ok,false);assert.ok(fs.existsSync(f));});
test('backup pressure cleanup preserves current',()=>{const d=setup(),f=old(d,'host-9.jsonl.old.bak');assert.equal(write(d,0,{maxDirBytes:1000}).ok,true);assert.equal(fs.existsSync(f),false);});
test('independent directories have isolated budgets',()=>{const a=setup(),b=setup();old(a,'host-custom.jsonl');assert.equal(write(a,0,{maxDirBytes:1000}).ok,false);assert.equal(write(b).ok,true);});
test('redaction retained',()=>{const d=setup();M.reportEvent({eventCode:'SAFE',details:{apiKey:'PRIVATE',body:'PRIVATE',ok:'yes'}},{dir:d});assert.ok(!fs.readFileSync(path.join(d,'host-'+M.defaultHost()+'.jsonl'),'utf8').includes('PRIVATE'));});
test('incident aggregation retained',()=>{const d=setup();write(d);assert.equal(write(d).aggregated,true);assert.equal(M.flushIncidents({dir:d}).ok,true);});
test('concurrent writers never exceed directory cap',async()=>{const d=setup(),limit=5000,mod=require.resolve('../resources/hooks/event_log');const code=`const m=require(${JSON.stringify(mod)});for(let i=0;i<100;i++)m.reportEvent({eventCode:'PARALLEL',incidentKey:process.pid+'-'+i},{dir:process.argv[1],limits:{maxDirBytes:${limit}}});`;await Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,['-e',code,d],{stdio:'ignore'});c.on('error',reject);c.on('exit',n=>n===0?resolve():reject(Error('child '+n)));})));assert.ok(size(d)<=limit,'bytes='+size(d));assert.ok(size(d)>0);});
test('rotation metadata cache avoids per-write stat',()=>{const d=setup(),f=path.join(d,'stats.log');const orig=fs.lstatSync;let count=0;fs.lstatSync=(...a)=>{if(a[0]===f)count++;return orig(...a)};try{for(let i=0;i<100;i++)assert.equal(M.appendRotating(f,'x\n',{maxBytes:10000,keep:3}).ok,true);}finally{fs.lstatSync=orig}assert.ok(count<=2,'stat count='+count);});
test('numbered rotation preserves old generations',()=>{const d=setup(),f=path.join(d,'stats.log');for(const s of ['AAAA','BBBB','CCCC','DDDD'])assert.equal(M.appendRotating(f,s,{maxBytes:4,keep:3}).ok,true);assert.equal(fs.readFileSync(f,'utf8'),'DDDD');assert.equal(fs.readFileSync(f+'.1','utf8'),'CCCC');assert.equal(fs.readFileSync(f+'.2','utf8'),'BBBB');});
test('full directory recovers after maintenance interval',()=>{const d=setup(),f=old(d,'host-custom.jsonl');assert.equal(write(d,0,{maxDirBytes:1000}).ok,false);fs.unlinkSync(f);const now=Date.now;Date.now=()=>now()+61000;try{assert.equal(write(d,1,{maxDirBytes:1000}).ok,true)}finally{Date.now=now}});
test('corrupt accounting is reconstructed safely',()=>{const d=setup();write(d);fs.writeFileSync(d+'.state/budget.json','broken');assert.equal(write(d,1).ok,true);assert.equal(M.getStatus().scans,2)});
test('busy writer returns immediately and counts drop',()=>{const d=setup();fs.mkdirSync(d+'.state');fs.writeFileSync(d+'.state/lock',JSON.stringify({pid:process.pid}));assert.equal(write(d).error,'diag-writer-busy');assert.equal(M.getStatus().dropped,1);assert.equal(M.getStatus().scans,0)});
test('dead stale lock recovers on following request',()=>{const d=setup();fs.mkdirSync(d+'.state');const f=path.join(d+'.state','lock');fs.writeFileSync(f,JSON.stringify({pid:2147483647}));const dt=new Date(Date.now()-120000);fs.utimesSync(f,dt,dt);assert.equal(write(d).error,'diag-writer-busy');assert.equal(write(d).ok,true)});
test('old live lock stays protected',()=>{const d=setup();fs.mkdirSync(d+'.state');const f=path.join(d+'.state','lock');fs.writeFileSync(f,JSON.stringify({pid:process.pid}));const dt=new Date(Date.now()-120000);fs.utimesSync(f,dt,dt);assert.equal(write(d).error,'diag-writer-busy');assert.ok(fs.existsSync(f))});
test('state symlink never followed',()=>{const d=setup(),outside=path.join(root,'other-state');fs.mkdirSync(outside);symlinkFixture(outside,d+'.state');assert.equal(write(d).ok,false);assert.equal(fs.readdirSync(outside).length,0)});
test('append error leaves conservative reservation and retry works',()=>{const d=setup();const orig=fs.openSync;fs.openSync=(f,...a)=>{if(String(f).endsWith('.jsonl'))throw Object.assign(Error('disk error'),{code:'EIO'});return orig(f,...a)};try{assert.equal(write(d).ok,false)}finally{fs.openSync=orig}const st=JSON.parse(fs.readFileSync(d+'.state/budget.json','utf8'));assert.ok(st.used>0);assert.equal(write(d).ok,true);assert.equal(M.getStatus().dropped,1)});
test('timestamp telemetry rotation preserves threshold semantics',()=>{const d=setup(),f=path.join(d,'telemetry.jsonl');assert.ok(M.appendRotating(f,'12345',{maxBytes:4,timestamp:true}).ok);assert.equal(fs.existsSync(f),true);assert.ok(M.appendRotating(f,'x',{maxBytes:4,timestamp:true}).ok);assert.equal(fs.readFileSync(f,'utf8'),'x');assert.equal(fs.readdirSync(d).filter(n=>n.endsWith('.bak')).length,1)});
test('full budget cannot prevent rotation of a full current file forever',()=>{
 const d=setup();const keep=old(d,'host-custom.jsonl',1000,0);const current=old(d,'host-'+M.defaultHost()+'.jsonl',900,0);
 const r=write(d,123,{maxFileBytes:1000,maxDirBytes:2000});
 assert.equal(r.ok,true,'eligible rotation must create reclaimable backup before cap verdict');
 assert.equal(fs.statSync(keep).size,1000);assert.ok(fs.statSync(current).size<900);assert.ok(size(d)<=2000);
});
