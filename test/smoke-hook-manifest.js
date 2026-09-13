// 用途：用临时惰性 ZIP 验证产物缺件必失败；不构建或部署真实扩展。
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..');const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'manifest-check-'));after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
const expected=['request_catalog.js','event_log.js','index_evidence.js','source_sidecar.js','session_context.js','session_state.js','tool_compress.js','build_index.js','skill_filter.js','context_monitor.js','prefix_canon.js','compact_fold.js','text_parts.js'];
function fixture(name,missing){const dir=path.join(tmp,name);const hooks=path.join(dir,'extension/resources/hooks');fs.mkdirSync(hooks,{recursive:true});fs.writeFileSync(path.join(dir,'extension/package.json'),'{}');for(const f of expected)if(f!==missing)fs.writeFileSync(path.join(hooks,f),'module.exports = {};\n');return {dir,hooks};}
function inspect(name,missing){const {dir}=fixture(name,missing);const archive=path.join(tmp,name+'.vsix');assert.equal(spawnSync('zip',['-qr',archive,'extension'],{cwd:dir}).status,0);return spawnSync(process.execPath,[path.join(root,'tools/check-artifact.mjs'),archive],{encoding:'utf8'});}
for(const file of expected)test('artifact rejects missing '+file,()=>{const r=inspect('missing-'+file,file);assert.equal(r.status,1,`${file} silently omitted: ${r.stdout}`);assert.ok(r.stdout.includes(file));});
test('complete synthetic archive accepted',()=>assert.equal(inspect('complete').status,0));
test('shared manifest covers exact runtime set',async()=>{const m=await import('../tools/hook-manifest.mjs');assert.deepEqual([...m.HOOK_FILES].sort(),[...expected].sort());});
test('validator rejects undeclared local dependency',async()=>{const m=await import('../tools/hook-manifest.mjs');const {hooks}=fixture('undeclared');fs.writeFileSync(path.join(hooks,'skill_filter.js'),"require('./new_helper');");assert.ok(m.validateHookDirectory(hooks).some(x=>x.includes('new_helper')));});
test('validator rejects empty module',async()=>{const m=await import('../tools/hook-manifest.mjs');const {hooks}=fixture('empty');fs.writeFileSync(path.join(hooks,'event_log.js'),'');assert.ok(m.validateHookDirectory(hooks).some(x=>x.includes('event_log.js')));});
test('validator rejects symlink module',async()=>{const m=await import('../tools/hook-manifest.mjs');const {hooks}=fixture('symlink');fs.unlinkSync(path.join(hooks,'event_log.js'));fs.symlinkSync('text_parts.js',path.join(hooks,'event_log.js'));assert.ok(m.validateHookDirectory(hooks).some(x=>x.includes('event_log.js')));});

for(const file of expected)test('build preflight rejects missing '+file,()=>{const {hooks}=fixture('preflight-'+file,file);const r=spawnSync(process.execPath,[path.join(root,'tools/build.mjs')],{encoding:'utf8',env:{...process.env,DEEPSEEK_HOOK_SRC:hooks}});assert.equal(r.status,1);assert.ok((r.stdout+r.stderr).includes(file));assert.ok(!r.stdout.includes('[2/5]'));});
