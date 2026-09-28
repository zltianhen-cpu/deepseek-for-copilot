// 用途：provenance 缓存的真实读取次数、失效和故障恢复验证。
const {test,after}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'provenance-cache-'));
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const hook=path.join(root,'skill_filter.js');fs.writeFileSync(hook,'first');
fs.writeFileSync(path.join(root,'event_log.js'),"module.exports={reportEvent:r=>{global.__lastProvenance=r},getStatus:()=>({dropped:0})};");
process.env.DEEPSEEK_HOOK_DIR=root;const M=require('../out/provider/request-events');
function record(){M.recordRequestEvent('id','PREPARE','main-agent');return global.__lastProvenance;}
test('100 events read unchanged files once',()=>{const orig=fs.readFileSync;let pkg=0,hooks=0;fs.readFileSync=function(f,...a){if(String(f).endsWith('/package.json'))pkg++;if(f===hook)hooks++;return orig.call(this,f,...a)};try{for(let i=0;i<100;i++)record();}finally{fs.readFileSync=orig}assert.equal(pkg,1);assert.equal(hooks,1);});
test('size change recomputes hash',()=>{const before=record().hookHash;fs.writeFileSync(hook,'second content');assert.notEqual(record().hookHash,before)});
test('mtime-only change recomputes hash',()=>{const before=record().hookHash;fs.writeFileSync(hook,'SECOND CONTENT');const dt=new Date(Date.now()+3000);fs.utimesSync(hook,dt,dt);assert.notEqual(record().hookHash,before)});
test('missing file does not reuse stale hash',()=>{fs.unlinkSync(hook);assert.equal(record().hookHash,'unknown')});
test('recreated file recovers',()=>{fs.writeFileSync(hook,'recovered');assert.match(record().hookHash,/^[a-f0-9]{64}$/)});
test('status getter available without metadata leakage',()=>{assert.deepEqual(M.getDiagnosticsStatus(),{dropped:0})});
