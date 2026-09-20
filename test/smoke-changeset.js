// 用途：变化清单（REQUEST_CHANGESET）与档位门（minimal 只留告警/失败）的接线回归；不访问网络。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'changeset-'));
process.env.DEEPSEEK_DIAG_DIR = tmp;
let debugModeValue = 'minimal';
const old = Module._load;
Module._load = function (id, ...args) {
	if (id === 'vscode')
		return {
			env: { language: 'en' },
			workspace: {
				getConfiguration: () => ({
					get: (key, fallback) => (key === 'debugMode' ? debugModeValue : fallback),
					inspect: () => ({
						key: 'deepseek-fork.debugMode',
						globalValue: debugModeValue,
						workspaceValue: undefined,
						workspaceFolderValue: undefined,
						defaultValue: 'minimal',
					}),
					update: async () => undefined,
				}),
			},
			window: { createOutputChannel: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
			Uri: {
				joinPath: (base, ...parts) => ({ fsPath: path.join(base?.fsPath ?? tmp, ...parts.map(String)) }),
				file: (p) => ({ fsPath: String(p) }),
			},
		};
	return old.call(this, id, ...args);
};
const root = process.env.CACHE_EXTENSION_TEST_DIR || path.join(__dirname, '..');
const changesetApi = require(path.join(root, 'out/provider/request-changeset'));
const eventsApi = require(path.join(root, 'out/provider/request-events'));

function rows() {
	const out = [];
	for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
		for (const line of fs.readFileSync(path.join(tmp, entry.name), 'utf8').split('\n')) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line));
			} catch {
				/* 容忍半行 */
			}
		}
	}
	return out;
}

let passed = 0;
async function check(name, fn) {
	await fn();
	console.log('PASS ' + name);
	passed++;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

check('enabled collector emits one REQUEST_CHANGESET with steps', () => {
	const c = changesetApi.createChangesetCollector({
		requestId: 'r-smoke-1',
		requestKind: 'main-agent',
		enabled: true,
	});
	c.reportStep({
		name: 'PRUNE_TOOL',
		before: { items: 12, chars: 90000, digest: 'a'.repeat(32) },
		after: { items: 12, chars: 30000, digest: 'b'.repeat(32) },
		removed: { count: 0, chars: 0, indexes: [] },
		added: { count: 0, chars: 0, indexes: [] },
		changed: { count: 3, chars: 60000, indexes: [1, 2, 3] },
		extra: { pruned: 3, SECRET: 'x'.repeat(4000) },
		ts: Date.now(),
	});
	c.reportStep({ name: 'FOLD', before: { items: 12 }, after: { items: 4 }, removed: { count: 8 }, added: { count: 0 } });
	c.finish();
	const event = rows().find((r) => r.eventCode === 'REQUEST_CHANGESET');
	assert.ok(event, '必须写出 REQUEST_CHANGESET');
	assert.equal(event.changesetSteps.length, 2);
	assert.equal(event.changesetSteps[0].name, 'PRUNE_TOOL');
	assert.equal(event.changesetSteps[0].bItems, 12);
	assert.equal(event.changesetSteps[0].aChars, 30000);
	assert.equal(event.changesetSteps[0].chCount, 3);
	assert.equal(event.changesetSteps[0].chIdx, '1,2,3');
	assert.equal(event.changesetSteps[0].bDigest, 'a'.repeat(32));
	assert.equal(event.changesetSteps[1].rmCount, 8);
});

check('no payload text leaks into the event', () => {
	const blob = JSON.stringify(rows());
	assert.ok(!blob.includes('SECRET'), '变化清单只许数字/索引/哈希，不许文本');
	assert.ok(!blob.includes('x'.repeat(200)));
});

check('disabled collector stays silent', () => {
	const before = rows().filter((r) => r.eventCode === 'REQUEST_CHANGESET').length;
	const c = changesetApi.createChangesetCollector({ requestId: 'r-smoke-2', requestKind: 'main-agent', enabled: false });
	c.reportStep({ name: 'FOLD' });
	c.finish();
	assert.equal(rows().filter((r) => r.eventCode === 'REQUEST_CHANGESET').length, before);
});

check('caps: ≤20 steps (log array limit) and junk sanitized', () => {
	const c = changesetApi.createChangesetCollector({ requestId: 'r-smoke-3', requestKind: 'main-agent', enabled: true });
	for (let i = 0; i < 30; i++)
		c.reportStep({ name: 'STEP_' + i, removed: { count: -5, chars: 1.5, indexes: Array.from({ length: 60 }, (_v, k) => k) } });
	c.reportStep({ name: 42 });
	c.finish();
	const event = rows().find((r) => r.requestId === 'r-smoke-3' && r.eventCode === 'REQUEST_CHANGESET');
	assert.ok(event);
	assert.equal(event.changesetSteps.length, 20, '日志 maxArrayItems=20，超出必须自己先封顶');
	assert.equal(event.changesetSteps[0].rmCount, 0, '负数必须归零');
	assert.equal(event.changesetSteps[0].rmChars, 0, '非整数必须归零');
	assert.equal(event.changesetSteps[0].rmIdx, '0,1,2,3,4,5,6,7', '索引只留前 8 个');
});

check('minimal mode keeps failures but drops process events', () => {
	eventsApi.setDiagnosticsMode('minimal');
	eventsApi.recordRequestEvent('r-smoke-4', 'PREPARE', 'main-agent');
	eventsApi.recordRequestEvent('r-smoke-4', 'REQUEST_SEND_FAILED', 'main-agent');
	const mine = rows().filter((r) => r.requestId === 'r-smoke-4');
	assert.equal(mine.length, 1, 'minimal 档只留告警/失败');
	assert.equal(mine[0].eventCode, 'REQUEST_SEND_FAILED');
});

check('verbose mode restores process events', () => {
	eventsApi.setDiagnosticsMode('verbose');
	eventsApi.recordRequestEvent('r-smoke-5', 'PREPARE', 'main-agent');
	assert.equal(rows().filter((r) => r.requestId === 'r-smoke-5').length, 1);
	eventsApi.setDiagnosticsMode('unknown');
});

async function main() {
	dumpRootFiles = () => {
		const base = path.join(tmp, 'request-dumps');
		if (!fs.existsSync(base)) return [];
		const out = [];
		for (const entry of fs.readdirSync(base, { recursive: true })) {
			if (String(entry).endsWith('.json')) out.push(String(entry));
		}
		return out;
	};

	await check('converted snapshot is silent in minimal mode', () => {
		debugModeValue = 'minimal';
		const dump = require(path.join(root, 'out/provider/debug'));
		assert.equal(typeof dump.dumpConvertedSnapshot, 'function');
		assert.doesNotThrow(() =>
			dump.dumpConvertedSnapshot({
				requestId: 'r-smoke-6',
				globalStorageUri: { fsPath: tmp },
				segment: { segmentId: 'seg-smoke' },
				requestKind: 'main-agent',
				messages: [{ role: 'system', content: 'converted-body' }],
				tools: [],
			}),
		);
		assert.equal(filesList().filter((f) => f.includes('deepseek-converted')).length, 0, 'minimal 档不许落快照');
	});

	await check('converted snapshot writes full body in verbose mode', async () => {
		debugModeValue = 'verbose';
		const dump = require(path.join(root, 'out/provider/debug'));
		dump.dumpConvertedSnapshot({
			requestId: 'r-smoke-7',
			globalStorageUri: { fsPath: tmp },
			segment: { segmentId: 'seg-smoke' },
			requestKind: 'main-agent',
			messages: [{ role: 'system', content: 'converted-body' }],
			tools: [],
		});
		let files = [];
		for (let i = 0; i < 50; i++) {
			files = filesList().filter((f) => f.includes('deepseek-converted'));
			if (files.length) break;
			await sleep(40);
		}
		assert.ok(files.length, 'verbose 档必须落下 convert 后快照');
		const written = JSON.parse(fs.readFileSync(path.join(tmp, 'request-dumps', files[0]), 'utf8'));
		assert.equal(written.stage, 'converted');
		assert.equal(written.requestId, 'r-smoke-7');
		assert.equal(written.messages[0].content, 'converted-body', '正文必须逐字可见');
		debugModeValue = 'minimal';
	});

	await check('note only allows enum-ish values (no free text)', () => {
		const c = changesetApi.createChangesetCollector({ requestId: 'r-smoke-9', requestKind: 'main-agent', enabled: true });
		c.reportStep({ name: 'FOLD', extra: { reason: '机密正文ABC' } });
		c.reportStep({ name: 'FOLD2', extra: { reason: 'fold-hold' } });
		c.finish();
		const event = rows().find((r) => r.requestId === 'r-smoke-9' && r.eventCode === 'REQUEST_CHANGESET');
		assert.ok(event);
		assert.equal(event.changesetSteps[0].note, undefined, '自由文本必须被栉掉');
		assert.equal(event.changesetSteps[1].note, 'reason=fold-hold');
	});

	await check('reportStep is forwarded into hook runtime (cross-layer)', async () => {
		const hooksDir = path.join(tmp, 'fake-hooks');
		fs.mkdirSync(hooksDir, { recursive: true });
		fs.writeFileSync(
			path.join(hooksDir, 'skill_filter.js'),
			`module.exports = {\n  filterOpenAIMessages: (messages, opts) => { global.__captured = opts; return { ok: true, reason: 'fake' }; },\n  filterOpenAIMessagesQueued: (messages, opts) => { global.__captured = opts; return Promise.resolve({ ok: true, reason: 'fake' }); },\n};\n`,
		);
		process.env.DEEPSEEK_HOOK_DIR = hooksDir;
		process.env.DEEPSEEK_AUTOBUILD_OFF = '1';
		const hooks = require(path.join(root, 'out/provider/chat-hooks'));
		const reportStep = () => undefined;
		await hooks.applyMessageFilter([{ role: 'user', content: 'x' }], { requestId: 'r-smoke-10', reportStep });
		assert.ok(global.__captured, '钩子必须被调到');
		assert.equal(typeof global.__captured.runtime.reportStep, 'function', '转发链不能断：钩子必须拿到 reportStep');
		assert.equal(global.__captured.runtime.reportStep, reportStep);
		delete process.env.DEEPSEEK_HOOK_DIR;
	});

	await check('byte budget trims and flags itself', () => {
		const c = changesetApi.createChangesetCollector({ requestId: 'r-smoke-11', requestKind: 'main-agent', enabled: true });
		for (let i = 0; i < 20; i++)
			c.reportStep({
				name: 'STEP_' + i,
				before: { items: 300, chars: 900000, digest: 'c'.repeat(32) },
				after: { items: 300, chars: 800000, digest: 'd'.repeat(32) },
				removed: { count: 3, chars: 100, indexes: [1, 2, 3, 4, 5, 6, 7, 8] },
				added: { count: 2, chars: 50, indexes: [9, 10, 11, 12, 13, 14, 15, 16] },
				changed: { count: 4, chars: 90, indexes: [17, 18, 19, 20, 21, 22, 23, 24] },
				extra: { reason: 'fold-hold', holdReason: 'host-shape' },
			});
		c.finish();
		const event = rows().find((r) => r.requestId === 'r-smoke-11' && r.eventCode === 'REQUEST_CHANGESET');
		assert.ok(event);
		assert.equal(event.changesetStepsTotal, 20);
		assert.ok(event.changesetStepsKept <= 20);
		const line = JSON.stringify(event);
		assert.ok(line.length < 8 * 1024, '整行必须留在 8KB 以内，实际 ' + line.length);
	});

	await check('freeze happens before hooks can rewrite messages', async () => {
		debugModeValue = 'verbose';
		const dump = require(path.join(root, 'out/provider/debug'));
		const messages = [{ role: 'system', content: 'ORIGINAL-BODY' }];
		dump.dumpConvertedSnapshot({
			requestId: 'r-smoke-12',
			globalStorageUri: { fsPath: tmp },
			segment: { segmentId: 'seg-freeze' },
			requestKind: 'main-agent',
			messages,
			tools: [],
		});
		// 模拟钩子：同一数组 + 同一对象被原地改写
		messages[0].content = 'POST-HOOK-BODY';
		let file = '';
		for (let i = 0; i < 50; i++) {
			const hit = filesList().find((f) => f.includes('deepseek-converted') && f.includes('seg-freeze'));
			if (hit) {
				file = hit;
				break;
			}
			await sleep(40);
		}
		assert.ok(file, '快照必须落盘');
		const written = JSON.parse(fs.readFileSync(path.join(tmp, 'request-dumps', file), 'utf8'));
		assert.equal(written.messages[0].content, 'ORIGINAL-BODY', '必须冻结钩子动手之前的正文');
		debugModeValue = 'minimal';
	});

	await check('fail-open leaves a trace', () => {
		const c = changesetApi.createChangesetCollector({ requestId: 'r-smoke-13', requestKind: 'main-agent', enabled: true });
		c.reportStep({
			get name() {
				throw new Error('boom');
			},
		});
		c.finish();
		assert.ok(
			rows().some((r) => r.eventCode === 'REQUEST_CHANGESET_FAILED'),
			'扩展侧 catch 必须留痕',
		);
	});

	await check('junk step names are rejected', () => {
		const c = changesetApi.createChangesetCollector({ requestId: 'r-smoke-14', requestKind: 'main-agent', enabled: true });
		c.reportStep({ name: '坏名字\n\t控制字符' });
		c.reportStep({ name: 'GOOD_STEP' });
		c.finish();
		const event = rows().find((r) => r.requestId === 'r-smoke-14' && r.eventCode === 'REQUEST_CHANGESET');
		assert.ok(event);
		assert.equal(event.changesetSteps.length, 1);
		assert.equal(event.changesetSteps[0].name, 'GOOD_STEP');
	});

	console.log(`${passed} fixtures passed`);
}

let filesList = () => {
	const base = path.join(tmp, 'request-dumps');
	if (!fs.existsSync(base)) return [];
	const out = [];
	for (const entry of fs.readdirSync(base, { recursive: true })) {
		if (String(entry).endsWith('.json')) out.push(String(entry));
	}
	return out;
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
