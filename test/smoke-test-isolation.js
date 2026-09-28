// 用途：统一测试入口隔离数据，并验证删除环境变量也不能写入隔离目录外。
const {test,after}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {spawnSync}=require('node:child_process');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'test-isolation-'));after(()=>fs.rmSync(root,{recursive:true,force:true}));
async function env(){const {makeTestEnv}=await import('../tools/run-tests.mjs');const d=fs.mkdtempSync(path.join(root,'child-'));return {environment:makeTestEnv(d),dir:d};}
function child(code,environment){return spawnSync(process.execPath,['-e',code],{env:environment,encoding:'utf8'});}
test('npm test uses the single isolated runner',()=>{assert.equal(require('../package.json').scripts.test,'node tools/run-tests.mjs')});
test('env overrides inherited real paths',async()=>{const {environment:e,dir}=await env();for(const key of ['HOME','DEEPSEEK_DATA_DIR','DEEPSEEK_DIAG_DIR','DEEPSEEK_INDEX_PATH','TMPDIR'])assert.ok(e[key].startsWith(dir+path.sep),key);assert.match(e.NODE_OPTIONS,/--permission/)});
test('default logger after deleting overrides stays in temporary HOME',async()=>{const {environment,dir}=await env();const mod=require.resolve('../resources/hooks/event_log');const r=child(`delete process.env.DEEPSEEK_DIAG_DIR;delete process.env.DEEPSEEK_DATA_DIR;const m=require(${JSON.stringify(mod)});if(!m.reportEvent({eventCode:'ISOLATION'}).ok)process.exit(2);console.log(m.diagDir())`,environment);assert.equal(r.status,0,r.stderr);assert.ok(r.stdout.trim().startsWith(dir+path.sep))});
test('write outside sandbox is rejected without touching sentinel',async()=>{const {environment}=await env();const sentinel=path.join(root,'sentinel');fs.writeFileSync(sentinel,'safe');const r=child(`require('fs').writeFileSync(${JSON.stringify(sentinel)},'bad')`,environment);assert.notEqual(r.status,0);assert.match(r.stderr,/ERR_ACCESS_DENIED/);assert.equal(fs.readFileSync(sentinel,'utf8'),'safe')});
test('unlink outside sandbox is rejected',async()=>{const {environment}=await env();const sentinel=path.join(root,'keep');fs.writeFileSync(sentinel,'safe');const r=child(`require('fs').unlinkSync(${JSON.stringify(sentinel)})`,environment);assert.notEqual(r.status,0);assert.ok(fs.existsSync(sentinel))});
test('allowed temporary writes work',async()=>{const {environment,dir}=await env();const r=child(`require('fs').writeFileSync(${JSON.stringify(path.join(dir,'ok'))},'ok')`,environment);assert.equal(r.status,0,r.stderr)});

test('symlink fixture rejects a path outside TMPDIR',()=>{const {symlinkFixture}=require('../tools/test-symlink.cjs');assert.throws(()=>symlinkFixture('/not-a-test-fixture',path.join(root,'bad-link')),/inside isolated TMPDIR/)});
