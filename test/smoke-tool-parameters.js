/**
 * 冒烟测试：工具参数兜底（`toToolParameters`）
 *
 * 为什么要有这个测试：
 *   VS Code 有 10 个内置工具**不带 `inputSchema`**（无参数工具，例如
 *   `terminal_last_command`、`activate_*_tools`）。旧实现原样透传 undefined，
 *   而 JSON.stringify 会**丢掉值为 undefined 的键** → 请求里这些工具只剩
 *   name + description。DeepSeek 官方接口宽容（忽略），但严格校验的上游
 *   （NewAPI 中转的火山方舟通道等）直接 400：
 *   `tools[47].***.parameters must be valid JSON (line 1, column 1)`。
 *
 * 断言分四类：
 *   A. 兜底    —— undefined / null / 空串 / 非法串 / 数组 → 补空 object schema
 *   B. 透传    —— 合法对象原样（官方渠道零影响）；字符串先去 JSON.parse
 *   C. 出网形态 —— convertTools 出来的每个工具**都必须带 parameters 键**，
 *                 且 JSON.stringify 后真的能在字节里看到
 *   D. 非回归  —— 无工具时仍是 undefined（不凭空造工具）
 *
 * 用法: node test/smoke-tool-parameters.js
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.dirname(__dirname);

// convert.ts 顶层 import vscode（运行时也用），这里给最小桩。
const vscodeStub = { env: { language: 'en' } };
const load = Module._load;
Module._load = function (id, ...rest) {
	if (id === 'vscode') return vscodeStub;
	return load.call(this, id, ...rest);
};

const { convertTools, toToolParameters } = require(path.join(
	ROOT, 'out', 'provider', 'convert.js',
));

const EMPTY_SCHEMA = { type: 'object', properties: {} };

const cases = [];
function test(name, fn) {
	cases.push([name, fn]);
}

test('A. 不可用形态一律补空 object schema', () => {
	for (const raw of [undefined, null, '', 'not json', [], [1, 2], 42, true]) {
		const out = toToolParameters(raw);
		assert.deepEqual(out, EMPTY_SCHEMA, `${JSON.stringify(raw)} 应补空 schema`);
	}
});

test('B. 合法对象原样透传（官方渠道零影响）', () => {
	const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
	assert.deepEqual(toToolParameters(schema), schema);
});

test('B. 字符串形态先尝试 JSON.parse', () => {
	const schema = { type: 'object', properties: { q: { type: 'string' } } };
	assert.deepEqual(toToolParameters(JSON.stringify(schema)), schema);
	assert.deepEqual(toToolParameters('[]'), EMPTY_SCHEMA, '数组不算合法 schema');
});

test('C. 缺 inputSchema 的工具出网必须带 parameters 键', () => {
	const tools = [
		{ name: 'terminal_last_command', description: '无参数工具（VS Code 不给 inputSchema）' },
		{ name: 'terminal_selection', description: '同上' },
		{ name: 'with_schema', description: '正常工具', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } },
	];
	const converted = convertTools(tools);
	assert.equal(converted.length, 3);
	for (const tool of converted) {
		assert.equal(typeof tool.function.parameters, 'object', `${tool.function.name} 缺 parameters`);
		assert.notEqual(tool.function.parameters, null);
	}
	// 真正的病根是序列化后丢键——这里按字节断言，防"对象上有、发出去没了"
	const wire = JSON.stringify(converted);
	assert.equal(wire.includes('"parameters":null'), false, '不允许出现 null parameters');
	assert.equal((wire.match(/"parameters":/g) || []).length, 3, '每个工具都要有 parameters');
	// 合法 schema 不许被改
	const keep = converted.find((t) => t.function.name === 'with_schema');
	assert.deepEqual(keep.function.parameters, { type: 'object', properties: { a: { type: 'string' } } });
});

test('D. 非回归：无工具时仍是 undefined', () => {
	assert.equal(convertTools(undefined), undefined);
	assert.equal(convertTools([]), undefined);
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
