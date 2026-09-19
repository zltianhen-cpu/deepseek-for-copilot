/**
 * 冒烟测试：可配置额外模型（`deepseek-fork.customModels`）
 *
 * 为什么要有这个测试：
 *   内置模型表 `MODELS` 是编译进扩展的常量；自建网关（NewAPI / 火山方舟 / 企业
 *   网关）新接一个模型，过去必须改代码 + 发版。这个设置项就是把它变成配置项。
 *   它同时是**新的攻击面**：用户填错东西不能让 provider 崩、不能弄坏模型选择器、
 *   更不能顺手把内置模型挤掉。所以这里的断言分两类：
 *     A. 接受   —— 合法条目的解析、默认值、顺序、与内置重名时的顶替规则
 *     B. 拒绝   —— 非法条目被跳过（缺 id/name、token 非正整数、pricing 乱填），
 *                  且**坏一条不牵连其他条**、配置本身是脏类型时也不崩
 *
 * 用法: node test/smoke-custom-models.js
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.dirname(__dirname);

/** 由各用例改写；`customModels` 的读取就是读这个变量。 */
let customModelsValue;
/** 收 logger.warn 的字符串，用来断言「警告了没 / 警告几次」。 */
const warns = [];
const vscodeStub = {
	env: { language: 'en' },
	workspace: {
		getConfiguration: () => ({
			get: (key, fallback) => (key === 'customModels' ? customModelsValue : fallback),
		}),
	},
	window: {
		createOutputChannel: () => ({
			info() {},
			warn: (message) => warns.push(String(message)),
			error() {},
			debug() {},
			appendLine() {},
		}),
	},
};
const load = Module._load;
Module._load = function (id, ...rest) {
	if (id === 'vscode') return vscodeStub;
	return load.call(this, id, ...rest);
};

const { getAllModels, getCustomModels, _resetCustomModelWarningsForTest } = require(
	path.join(ROOT, 'out', 'provider', 'custom-models.js'),
);
const { MODELS } = require(path.join(ROOT, 'out', 'consts.js'));

const builtinIds = MODELS.map((m) => m.id);

const cases = [];
function test(name, fn) {
	cases.push([name, fn]);
}

test('空配置：行为与加此功能前完全一致（只返回内置）', () => {
	customModelsValue = undefined;
	assert.deepEqual(getAllModels(), MODELS);

	customModelsValue = [];
	assert.deepEqual(getAllModels(), MODELS);

	customModelsValue = 'not-an-array';
	assert.deepEqual(getCustomModels(), []);
	assert.deepEqual(getAllModels(), MODELS);
});

test('合法条目：追加在内置之后 + 保守默认值', () => {
	customModelsValue = [
		{
			id: 'deepseek-v4-1-flash-260910',
			name: 'Volcengine DeepSeek v4.1 Flash',
			maxInputTokens: 655360,
			maxOutputTokens: 393216,
		},
	];
	const models = getAllModels();
	const added = models[models.length - 1];
	assert.equal(models.length, MODELS.length + 1, '应有且仅有一个自定义模型');
	assert.equal(added.id, 'deepseek-v4-1-flash-260910');
	assert.equal(added.name, 'Volcengine DeepSeek v4.1 Flash');
	assert.equal(added.family, 'deepseek', 'family 默认 deepseek');
	assert.equal(added.requiresThinkingParam, true, 'requiresThinkingParam 默认 true');
	assert.equal(added.capabilities.toolCalling, true, 'toolCalling 默认 true');
	assert.equal(added.capabilities.imageInput, false, 'imageInput 默认 false');
	assert.equal(added.capabilities.thinking, false, 'thinking 默认不支持');
	assert.equal(added.pricing, undefined, '未配价格时不带 pricing');
	// 内置顺序不许被这次追加打乱
	assert.deepEqual(models.slice(0, MODELS.length).map((m) => m.id), builtinIds);
});

test('多个条目：按配置顺序排在内置之后', () => {
	customModelsValue = [
		{ id: 'zz-custom-b', name: 'B', maxInputTokens: 1000, maxOutputTokens: 1000 },
		{ id: 'aa-custom-a', name: 'A', maxInputTokens: 1000, maxOutputTokens: 1000 },
	];
	const ids = getAllModels().map((m) => m.id);
	assert.deepEqual(ids.slice(-2), ['zz-custom-b', 'aa-custom-a'], '顺序必须按配置数组');
});

test('非法条目：跳过该条，不牵连其他条（坏输入不崩）', () => {
	customModelsValue = [
		{ name: '缺 id', maxInputTokens: 1, maxOutputTokens: 1 },
		{ id: 'no-name', maxInputTokens: 1, maxOutputTokens: 1 },
		{ id: 'bad-tokens', name: 'tokens 非法', maxInputTokens: 0, maxOutputTokens: -5 },
		{ id: 'float-tokens', name: 'tokens 非整数', maxInputTokens: 1.5, maxOutputTokens: 100 },
		{ id: '  ', name: '   ', maxInputTokens: 10, maxOutputTokens: 10 },
		null,
		'甲',
		{ id: 'good-one', name: '合格', maxInputTokens: 100, maxOutputTokens: 100 },
	];
	const ids = getCustomModels().map((m) => m.id);
	assert.deepEqual(ids, ['good-one'], '只应留下唯一合格条目');
});

test('与内置重名：以自定义为准，且排到末尾', () => {
	customModelsValue = [
		{ id: builtinIds[0], name: '改名调试用', maxInputTokens: 100, maxOutputTokens: 100 },
	];
	const models = getAllModels();
	assert.equal(models.length, MODELS.length, '顶替而不是新增');
	assert.equal(models.map((m) => m.id).includes(builtinIds[0]), true);
	assert.equal(models[models.length - 1].name, '改名调试用', '自定义应排在末尾');
});

test('thinking：合法能解析，空 supportedEfforts 降级为不支持', () => {
	customModelsValue = [
		{
			id: 'with-thinking',
			name: '带思考',
			maxInputTokens: 100,
			maxOutputTokens: 100,
			capabilities: {
				thinking: { supportedEfforts: ['low', 'high'], defaultEffort: 'high', canDisable: true },
			},
		},
		{
			id: 'empty-thinking',
			name: '空档位',
			maxInputTokens: 100,
			maxOutputTokens: 100,
			capabilities: { thinking: { supportedEfforts: [] } },
		},
		{
			id: 'bad-default',
			name: '默认档非法',
			maxInputTokens: 100,
			maxOutputTokens: 100,
			capabilities: { thinking: { supportedEfforts: ['max'], defaultEffort: 'low' } },
		},
	];
	const [withThinking, emptyThinking, badDefault] = getCustomModels();
	assert.deepEqual(withThinking.capabilities.thinking, {
		supportedEfforts: ['low', 'high'],
		defaultEffort: 'high',
		canDisable: true,
	});
	assert.equal(emptyThinking.capabilities.thinking, false);
	assert.equal(badDefault.capabilities.thinking.defaultEffort, 'max', '非法默认档回落首个可用档');
});

test('pricing：乱填只丢价格、模型保留；合法价格原样带上', () => {
	customModelsValue = [
		{
			id: 'bad-pricing',
			name: '价格乱填',
			maxInputTokens: 100,
			maxOutputTokens: 100,
			pricing: { CNY: { offPeak: { cacheHitInput: 'x' } } },
		},
		{
			id: 'good-pricing',
			name: '价格正常',
			maxInputTokens: 100,
			maxOutputTokens: 100,
			pricing: {
				CNY: {
					offPeak: { cacheHitInput: 0.02, cacheMissInput: 1, output: 4 },
					peak: { cacheHitInput: 0.04, cacheMissInput: 2, output: 8 },
				},
			},
		},
	];
	const [bad, good] = getCustomModels();
	assert.equal(bad.pricing, undefined, '坏价格表必须被丢掉');
	assert.equal(bad.id, 'bad-pricing', '但模型仍可用');
	assert.deepEqual(good.pricing.CNY.peak, { cacheHitInput: 0.04, cacheMissInput: 2, output: 8 });
});

test('非对象条目：跳过并留一条告警（需求：非法项都要告警）', () => {
	_resetCustomModelWarningsForTest();
	warns.length = 0;
	customModelsValue = [
		null,
		'甲',
		{ id: 'ok-x', name: 'X', maxInputTokens: 1, maxOutputTokens: 1 },
	];
	assert.deepEqual(getCustomModels().map((m) => m.id), ['ok-x']);
	assert.ok(
		warns.some((w) => w.includes('不是对象')),
		'非对象条目应被告警：' + JSON.stringify(warns),
	);
});

test('坏配置重复读取：只警告一次（每次请求都会解析，不去重会刷屏）', () => {
	_resetCustomModelWarningsForTest();
	warns.length = 0;
	customModelsValue = [{ name: '缺 id' }];
	getAllModels();
	getAllModels();
	getAllModels();
	assert.equal(warns.length, 1, '三次解析应只警告一次，实际 ' + warns.length);
	_resetCustomModelWarningsForTest();
	warns.length = 0;
	getAllModels();
	assert.equal(warns.length, 1, '新会话应重新允许告警');
});

let pass = 0;
let fail = 0;
for (const [name, fn] of cases) {
	try {
		fn();
		console.log('  ✓', name);
		pass += 1;
	} catch (error) {
		console.error('  ✗', name, '\n     ', error.message);
		fail += 1;
	}
}
console.log(`\n${pass} 通过 / ${fail} 失败（共 ${cases.length}）`);
process.exit(fail ? 1 : 0);
