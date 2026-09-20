// 用途：宿主摘要丢失附件时，核验真实 prepare 管线、历史保护和会话隔离。
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-summary-test-'));
process.env.DEEPSEEK_DATA_DIR = tmp;
process.env.DEEPSEEK_AUTOBUILD_OFF = '1';
const root = process.env.CACHE_EXTENSION_TEST_DIR || path.join(__dirname, '..');
process.env.DEEPSEEK_HOOK_DIR = path.join(root, 'resources/hooks');
const Text = class {
	constructor(value) {
		this.value = value;
	}
};
const Data = class {
	constructor(data, mimeType) {
		Object.assign(this, { data, mimeType });
	}
};
const Thinking = class {
	constructor(value) {
		this.value = value;
	}
};
const Call = class {
	constructor(callId, name, input) {
		Object.assign(this, { callId, name, input });
	}
};
const Result = class {
	constructor(callId, content) {
		Object.assign(this, { callId, content });
	}
};
const vscode = {
	env: { language: 'en' },
	version: 'smoke',
	window: {
		createOutputChannel: () => ({ info() {}, debug() {}, error() {}, warn() {}, appendLine() {} }),
	},
	workspace: {
		workspaceFolders: [],
		getConfiguration: () => ({ get: (_k, d) => d, inspect: () => ({}) }),
	},
	Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
	LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
	LanguageModelTextPart: Text,
	LanguageModelDataPart: Data,
	LanguageModelThinkingPart: Thinking,
	LanguageModelToolCallPart: Call,
	LanguageModelToolResultPart: Result,
};
const load = Module._load;
Module._load = function (id, ...args) {
	return id === 'vscode' ? vscode : load.call(this, id, ...args);
};
const from = (p) => require(path.join(root, 'out', p));
const routing = from('provider/routing/classifier.js');
const hooks = from('provider/chat-hooks.js');
const { createReplayMarkerPart } = from('provider/replay/index.js');
const { prepareChatRequest } = from('provider/request.js');
const originalFilter = hooks.applyMessageFilter;
after(() => {
	hooks.applyMessageFilter = originalFilter;
	fs.rmSync(tmp, { recursive: true, force: true });
});
const SUMMARY =
	'The conversation has grown too large for the context window and must be compacted now.\n\nCreate a comprehensive summary.\nIMPORTANT: Output your summary wrapped in <summary> and </summary> tags. Do NOT call any tools. Your ONLY task right now is to produce a comprehensive summary of the conversation so far.';
const prefix = () => [
	{
		role: 3,
		content: [new Text('You are an expert AI programming assistant. Stable instructions.')],
	},
	{ role: 1, content: [new Text('Read the example file.')] },
	{
		role: 2,
		content: [
			createReplayMarkerPart({
				reasoningText: '先核对文件，保持原文\n完整。',
				segmentId: '11111111-1111-4111-8111-111111111111',
			}),
			new Text('Reading.'),
			new Call('call-a', 'read_file', { path: 'example.txt' }),
		],
	},
	{ role: 1, content: [new Result('call-a', [new Text('example content')])] },
];
function summary(messages = prefix()) {
	return [
		...messages.map((m) => ({ ...m, content: m.content.filter((p) => !(p instanceof Data)) })),
		{ role: 1, content: [new Text(SUMMARY)] },
	];
}
function options(id = 'conversation-a') {
	return {
		requestInitiator: 'github.copilot-chat',
		modelOptions: { _conversationId: id },
		tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }],
	};
}
function prepare(messages, opts = options(), extra = {}) {
	return prepareChatRequest({
		authManager: { getApiKey: async () => 'placeholder-test-key' },
		globalStorageUri: { fsPath: tmp },
		modelInfo: { id: 'deepseek-flash' },
		segment: { reason: 'markerMissing', segmentId: '22222222-2222-4222-8222-222222222222' },
		messages,
		options: opts,
		token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
		cacheDiagnostics: { beginRequest: () => ({}) },
		getVisionDescriber: async () => undefined,
		...extra,
	});
}

test('自动摘要先于 main-agent 分类，保留思考配置', () => {
	assert.equal(routing.classifyProviderRequest({ messages: summary() }), 'host-summary');
	assert.equal(routing.shouldForceThinkingNone('host-summary'), false);
});
test('普通用户提到摘要或引用模板不误分', () => {
	for (const text of ['请总结一下', 'Quote: ' + SUMMARY, SUMMARY.slice(0, 100)]) {
		const messages = [...prefix(), { role: 1, content: [new Text(text)] }];
		assert.equal(routing.classifyProviderRequest({ messages }), 'main-agent');
	}
});
test('实际 prepare：补回思考并逐字复用处理后的前文，摘要不调用有状态钩子', async (t) => {
	let calls = 0;
	hooks.applyMessageFilter = async (messages) => {
		calls++;
		messages[0].content = 'stable filtered instructions';
	};
	const main = await prepare(prefix());
	const input = summary();
	const before = JSON.stringify(input);
	const replay = await prepare(input);
	assert.equal(replay.requestKind, 'host-summary');
	assert.deepEqual(replay.request.messages.slice(0, -1), main.request.messages);
	assert.deepEqual(replay.request.messages.at(-1).content, [{ type: 'text', text: SUMMARY }]);
	assert.equal(calls, 1);
	assert.equal(JSON.stringify(input), before);
	assert.deepEqual(replay.request.tools, main.request.tools);
	assert.deepEqual(replay.request.thinking, main.request.thinking);
	const wire = [];
	t.mock.method(global, 'fetch', async (_url, opts) => {
		wire.push(JSON.parse(opts.body));
		let read = false;
		return {
			ok: true,
			body: {
				getReader: () => ({
					read: async () => {
						if (read) return { done: true };
						read = true;
						return { done: false, value: new TextEncoder().encode('data: [DONE]\n\n') };
					},
				}),
			},
		};
	});
	for (const prepared of [main, replay])
		await prepared.client.streamChatCompletion(prepared.request, {
			onContent() {},
			onThinking() {},
			onToolCall() {},
			onDone() {},
			onError(error) {
				throw error;
			},
		});
	assert.equal(wire.length, 2);
	assert.deepEqual(wire[1].messages.slice(0, -1), wire[0].messages, 'HTTP 实发仍保持前文');
	await prepare(prefix());
	assert.equal(calls, 2, '正常聊天仍进入原管线');
});
test('不同对话不串，摘要缺证据时不修改正常钩子状态', async () => {
	let calls = 0;
	hooks.applyMessageFilter = async () => {
		calls++;
	};
	const result = await prepare(summary(), options('another-conversation'));
	assert.equal(result.request.messages[2].reasoning_content, '');
	assert.equal(calls, 0);
});
test('摘要等待并发正常请求的前处理结束，不等模型回答', async () => {
	let release;
	let calls = 0;
	hooks.applyMessageFilter = async (messages) => {
		if (++calls === 1)
			await new Promise((resolve) => {
				release = resolve;
			});
		messages[0].content = 'concurrent stable prefix';
	};
	const mainPromise = prepare(prefix(), options('concurrent'));
	while (!release) await new Promise((resolve) => setImmediate(resolve));
	const summaryPromise = prepare(summary(), options('concurrent'));
	release();
	const [main, replay] = await Promise.all([mainPromise, summaryPromise]);
	assert.deepEqual(replay.request.messages.slice(0, -1), main.request.messages);
	assert.equal(calls, 1);
});

// 核心恢复器的负例独立于钩子测试，防止“只记日志”也拿到绿灯。
test('恢复器接口已接入，内存有界且匹配严格', async (t) => {
	const { HostSummaryReplayCache, buildReplayScope } = from('provider/replay/host-summary.js');
	const raw = [
		{ role: 'user', content: 'system' },
		{ role: 'user', content: 'task' },
		{
			role: 'assistant',
			content: 'answer',
			reasoning_content: 'original reasoning',
			tool_calls: [{ id: 'a', type: 'function', function: { name: 'read', arguments: '{"x":1}' } }],
		},
		{ role: 'tool', content: 'result', tool_call_id: 'a' },
	];
	const clone = (v) => JSON.parse(JSON.stringify(v));
	const incoming = () => [
		...raw.map((m) => ({
			...clone(m),
			...(m.role === 'assistant' ? { reasoning_content: '' } : {}),
		})),
		{ role: 'user', content: SUMMARY },
	];
	const config = { maxBytes: 200000, maxEntries: 4, ttlMs: 1000, waitMs: 10 };
	const scope = buildReplayScope(options(), 'workspace', 'model-shape', 'endpoint', 'key');
	const seeded = (settings = {}) => {
		const cache = new HostSummaryReplayCache({ ...config, ...settings });
		const ticket = cache.begin(scope, raw);
		cache.complete(ticket, raw);
		return cache;
	};
	await t.test('完整历史恢复', async () =>
		assert.deepEqual((await seeded().recover(scope, incoming())).messages.slice(0, -1), raw),
	);
	await t.test('摘要先到，等待随后进入的正常请求记录', async () => {
		const cache = new HostSummaryReplayCache({ ...config, waitMs: 100 });
		const replay = cache.recover(scope, incoming());
		setTimeout(() => cache.complete(cache.begin(scope, raw), raw), 5);
		assert.deepEqual((await replay).messages?.slice(0, -1), raw);
	});
	const edits = {
		用户编辑: (m) => {
			m[1].content = 'changed task';
		},
		相同长度正文变更: (m) => {
			m[2].content = 'ANSWER';
		},
		工具ID变更: (m) => {
			m[2].tool_calls[0].id = 'b';
		},
		工具参数变更: (m) => {
			m[2].tool_calls[0].function.arguments = '{"x":2}';
		},
		工具名称变更: (m) => {
			m[2].tool_calls[0].function.name = 'write';
		},
		工具结果变更: (m) => {
			m[3].content = 'changed result';
		},
		历史顺序变更: (m) => {
			[m[1], m[2]] = [m[2], m[1]];
		},
		删除历史: (m) => {
			m.splice(1, 1);
		},
		历史插入: (m) => {
			m.splice(1, 0, { role: 'user', content: 'inserted' });
		},
		非空思考冲突: (m) => {
			m[2].reasoning_content = 'different reasoning';
		},
	};
	for (const [name, edit] of Object.entries(edits))
		await t.test(name, async () => {
			const cache = seeded();
			const m = incoming();
			edit(m);
			const before = JSON.stringify(m);
			assert.equal((await cache.recover(scope, m)).messages, undefined);
			assert.equal(JSON.stringify(m), before);
		});
	await t.test('非空相同思考保留', async () => {
		const m = incoming();
		m[2].reasoning_content = raw[2].reasoning_content;
		assert.ok((await seeded().recover(scope, m)).messages);
	});
	await t.test('身份缺失和其它宿主不猜配', () => {
		assert.equal(buildReplayScope({}, 'w', 'm', 'u', 'k'), undefined);
		assert.equal(
			buildReplayScope({ ...options(), requestInitiator: 'other' }, 'w', 'm', 'u', 'k'),
			undefined,
		);
	});
	await t.test('模型、账号、地址、工作区隔离', async () => {
		for (const args of [
			['other', 'model-shape', 'endpoint', 'key'],
			['workspace', 'other', 'endpoint', 'key'],
			['workspace', 'model-shape', 'other', 'key'],
			['workspace', 'model-shape', 'endpoint', 'other'],
		])
			assert.equal(
				(await seeded().recover(buildReplayScope(options(), ...args), incoming())).messages,
				undefined,
			);
	});
	await t.test('同形历史多份思考拒绝歧义', async () => {
		const cache = seeded(),
			other = clone(raw);
		other[2].reasoning_content = 'alternate';
		cache.complete(cache.begin(scope, other), other);
		assert.equal((await cache.recover(scope, incoming())).messages, undefined);
	});
	await t.test('字节容量淘汰', async () =>
		assert.equal((await seeded({ maxBytes: 10 }).recover(scope, incoming())).messages, undefined),
	);
	await t.test('条数容量淘汰', async () => {
		const cache = seeded({ maxEntries: 1 });
		cache.complete(cache.begin('other', raw), raw);
		assert.equal((await cache.recover(scope, incoming())).messages, undefined);
	});
	await t.test('过期记录不恢复', async () => {
		let now = 0;
		const cache = seeded({ now: () => now });
		now = 2000;
		assert.equal((await cache.recover(scope, incoming())).messages, undefined);
	});
	await t.test('新进程内存为空', async () =>
		assert.equal(
			(await new HostSummaryReplayCache(config).recover(scope, incoming())).messages,
			undefined,
		),
	);
	await t.test('前处理失败解除等待', async () => {
		const cache = new HostSummaryReplayCache(config),
			ticket = cache.begin(scope, raw);
		cache.fail(ticket);
		assert.equal((await cache.recover(scope, incoming())).messages, undefined);
	});
	await t.test('前处理超时不等待无限久', async () => {
		const cache = new HostSummaryReplayCache(config);
		cache.begin(scope, raw);
		assert.equal((await cache.recover(scope, incoming())).messages, undefined);
	});
	await t.test('取消请求不恢复', async () =>
		assert.equal(
			(await seeded().recover(scope, incoming(), { isCancellationRequested: true })).messages,
			undefined,
		),
	);
	await t.test('图片与未来字段参与校验', async () => {
		const cache = seeded(),
			m = incoming();
		m[1].content = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } }];
		assert.equal((await cache.recover(scope, m)).messages, undefined);
	});
	await t.test('返回副本不污染记录', async () => {
		const cache = seeded();
		(await cache.recover(scope, incoming())).messages[2].content = 'mutated';
		assert.deepEqual((await cache.recover(scope, incoming())).messages.slice(0, -1), raw);
	});
	await t.test('真实空思考保持空', async () => {
		const cache = new HostSummaryReplayCache(config),
			m = clone(raw);
		m[2].reasoning_content = '';
		cache.complete(cache.begin(scope, m), m);
		assert.equal((await cache.recover(scope, incoming())).messages[2].reasoning_content, '');
	});
});
