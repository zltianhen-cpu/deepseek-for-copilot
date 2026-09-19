// 用途：只读取证 CLI 的分组、日期、精确关联与隐私合同；使用独立临时夹具。
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = path.join(__dirname, '../tools/probe-dual-form.mjs');
const date = '2026-09-18';
const stat = (id, hash, extra = {}) => ({ timestamp: '2026-09-18T06:00:00Z', requestId: id, foldSessionKey: 'session-A', requestKind: 'main-agent', inHeadHash8: hash, runtime: { pid: 57200 }, ...extra });
const usage = (id, extra = {}) => ({ timestampUtc: '2026-09-18T06:00:01Z', requestId: id, eventCode: 'USAGE_OBSERVED', requestKind: 'main-agent', input: 100, output: 2, hit: 80, miss: 20, ...extra });
function run(t, stats, events = [], args = ['--date', date]) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-form-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 fs.mkdirSync(path.join(dir, 'events'));
 fs.writeFileSync(path.join(dir, 'stats.log'), stats.map(s => typeof s === 'string' ? s : s.timestamp + ' ' + JSON.stringify(s)).join('\n'));
 fs.writeFileSync(path.join(dir, 'events/events.jsonl'), events.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n'));
 const r = spawnSync(process.execPath, [cli, '--stats', path.join(dir, 'stats.log'), '--events', path.join(dir, 'events'), ...args], { encoding: 'utf8' });
 return { ...r, data: r.status === 0 ? JSON.parse(r.stdout) : null };
}
function good(r) { assert.equal(r.status, 0, r.stderr); return r.data; }
test('日期必填且非法日期拒绝', t => { for (const a of [[], ['--date','2026-02-30'], ['--date','18/09/2026']]) assert.notEqual(run(t, [], [], a).status, 0); });
test('上海日期按 UTC+8 边界筛选', t => {
 const d = good(run(t, [stat('a','x',{timestamp:'2026-09-17T16:00:00Z'}),stat('b','y',{timestamp:'2026-09-18T15:59:59Z'}),stat('c','z',{timestamp:'2026-09-18T16:00:00Z'})]));
 assert.equal(d.timezone,'Asia/Shanghai'); assert.equal(d.selectedStats,2); assert.equal(d.groups[0].transitions.length,1);
});
test('同 PID 不同 session 不跨组配对，PID仅筛选', t => {
 const d=good(run(t,[stat('a','x'),stat('b','y',{foldSessionKey:'session-B'}),stat('c','x'),stat('d','z',{runtime:{pid:7}})],[],['--date',date,'--pid','57200']));
 assert.equal(d.selectedStats,3);assert.equal(d.groups.length,2);assert.equal(d.groups.flatMap(g=>g.transitions).length,0);
});
test('日期 session kind 分组，多日和 summary 不串组', t=>{
 const d=good(run(t,[stat('a','x'),stat('s','y',{requestKind:'summary'}),stat('old','z',{timestamp:'2026-09-17T06:00:00Z'})],[usage('a'),usage('s',{requestKind:'summary',input:9,hit:0,miss:9}),usage('old',{timestampUtc:'2026-09-17T06:00:00Z'})]));
 assert.equal(d.groups.length,2);assert.equal(d.groups.find(g=>g.kind==='main-agent').usage.input,100);assert.equal(d.groups.find(g=>g.kind==='summary').usage.input,9);
});
test('防抖不算删除，仅显式 reset 配合已知删除原因计数',t=>{
 const rows=[stat('a','x',{canonReason:'user-edit',canonReset:true}),stat('b','y',{canonReason:'user-edit-debounced',canonReset:false}),stat('c','x',{canonReason:'intact',canonReset:false}),stat('d','y',{canonReason:'user-edit',canonReset:false})];
 const g=good(run(t,rows)).groups[0];assert.equal(g.deletions,1);assert.equal(g.debounced,1);assert.equal(g.transitions.length,3);
});
test('严格 requestId 关联，缺 ID 不按相邻时间猜',t=>{
 const d=good(run(t,[stat('a','x'),stat(undefined,'y')],[usage('a'),usage('unrelated')]));const g=d.groups[0];
 assert.equal(g.usage.matched,1);assert.equal(g.usage.input,100);assert.equal(g.usage.missingRequestId,1);assert.equal(d.unmatchedUsage,1);
});
test('坏 JSONL 计数并继续有效记录',t=>{
 const d=good(run(t,['not json',stat('a','x')],['{bad',usage('a')]));assert.equal(d.badLines.stats,1);assert.equal(d.badLines.events,1);assert.equal(d.groups[0].usage.matched,1);
});
test('同 requestId 同 payload 重复 usage 只累计一次',t=>{
 const d=good(run(t,[stat('a','x')],[usage('a'),usage('a',{eventId:'again'})]));assert.equal(d.groups[0].usage.input,100);assert.equal(d.duplicateUsage.identical,1);
});
test('冲突 duplicate usage 标记歧义且不累计',t=>{
 const d=good(run(t,[stat('a','x')],[usage('a'),usage('a',{hit:70,miss:30})]));assert.equal(d.groups[0].usage.input,0);assert.equal(d.groups[0].usage.ambiguous,1);assert.equal(d.duplicateUsage.conflicting,1);
});
test('main 请求不能拿 summary usage 填补',t=>{
 const d=good(run(t,[stat('a','x')],[usage('a',{requestKind:'summary'})]));assert.equal(d.groups[0].usage.matched,0);assert.equal(d.groups[0].usage.kindMismatch,1);
});
test('stats 无 kind 仅用同 ID 唯一事件 kind 补齐',t=>{
 const d=good(run(t,[stat('a','x',{requestKind:undefined})],[usage('a')]));assert.equal(d.groups[0].kind,'main-agent');assert.equal(d.groups[0].usage.matched,1);
});
test('缺 session 不汇成同一会话',t=>{
 const d=good(run(t,[stat('a','x',{foldSessionKey:undefined}),stat('b','y',{foldSessionKey:undefined})]));assert.equal(d.groups.length,0);assert.equal(d.uncertainties.missingSession,2);
});
test('输出不泄露 query 正文或附件，哈希变化仅列候选',t=>{
 const d=good(run(t,[stat('a','x',{query:'SECRET-PROMPT',attachments:['SECRET-ATTACHMENT']}),stat('b','y')]));const s=JSON.stringify(d);assert.ok(!s.includes('SECRET'));assert.equal(d.groups[0].transitions[0].classification,'candidate-only');
});
test('同 ID 跨 session stats 歧义不重复分配 usage',t=>{
 const d=good(run(t,[stat('a','x'),stat('a','y',{foldSessionKey:'session-B'})],[usage('a')]));assert.equal(d.groups.reduce((n,g)=>n+g.usage.input,0),0);assert.equal(d.uncertainties.ambiguousStatsIds,1);
});
test('同时间不同 hash 不推断先后',t=>{
 const d=good(run(t,[stat('a','x'),stat('b','y')]));assert.equal(d.groups[0].transitions[0].orderUncertain,true);
});
test('PREPARE 暂定 main-agent 不覆盖实际 SEND/USAGE 的 background',t=>{
 const d=good(run(t,[stat('a','x',{requestKind:undefined})],[{...usage('a'),eventCode:'PREPARE',requestKind:'main-agent'},{...usage('a'),eventCode:'SEND_ATTEMPT',requestKind:'background'},usage('a',{requestKind:'background'})]));
 assert.equal(d.groups[0].kind,'background');assert.equal(d.groups[0].usage.matched,1);
});
test('发送种类与 usage 冲突时不采用 PREPARE 猜测',t=>{
 const d=good(run(t,[stat('a','x',{requestKind:undefined})],[{...usage('a'),eventCode:'PREPARE'},{...usage('a'),eventCode:'SEND_ATTEMPT',requestKind:'main-agent'},usage('a',{requestKind:'summary'})]));
 assert.equal(d.groups[0].kind,'unknown');assert.equal(d.groups[0].usage.matched,0);
});
