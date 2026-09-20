/** 验证宿主画图工具忽有忽无时，发给模型的工具清单仍逐字相同。 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const root = path.dirname(__dirname);
const originalLoad = Module._load;
class LanguageModelTextPart { constructor(value) { this.value = value; } }
class LanguageModelToolCallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
Module._load = function (id, ...rest) {
	if (id === 'vscode') return { env: { language: 'en' }, LanguageModelTextPart, LanguageModelToolCallPart };
	return originalLoad.call(this, id, ...rest);
};

const { prepareRequestTools } = require(path.join(root, 'out/provider/tools/request.js'));
const { streamChatCompletion } = require(path.join(root, 'out/provider/stream.js'));
const schema = { type: 'object', properties: {} };
const hostTool = (name, description = name, inputSchema = schema) => ({ name, description, inputSchema });
const withoutMermaid = [
	hostTool('read_file'),
	hostTool('read_page'),
	hostTool('run_in_terminal'),
	hostTool('write_file'),
];
const withMermaid = [
	...withoutMermaid.slice(0, 2),
	hostTool('renderMermaidDiagram', 'Renders a Mermaid diagram from Mermaid.js markup.', {
		type: 'object',
		properties: {
			markup: {
				type: 'string',
				description: 'The mermaid diagram markup to render as a Mermaid diagram. This should only be the markup of the diagram. Do not include a wrapping code block.',
			},
			title: { type: 'string', description: 'A short title that describes the diagram.' },
		},
	}),
	...withoutMermaid.slice(2),
];

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('57→58→57：出门工具逐字相同', () => {
	const first = prepareRequestTools(true, { tools: withoutMermaid });
	const second = prepareRequestTools(true, { tools: withMermaid });
	const third = prepareRequestTools(true, { tools: withoutMermaid });
	assert.equal(JSON.stringify(first), JSON.stringify(second));
	assert.equal(JSON.stringify(second), JSON.stringify(third));
	assert.deepEqual(first.map((t) => t.function.name), [
		'read_file', 'read_page', 'renderMermaidDiagram', 'run_in_terminal', 'write_file',
	]);
	assert.equal(first.filter((t) => t.function.name === 'renderMermaidDiagram').length, 1);
});

test('不修改宿主输入，保留其它工具定义', () => {
	const input = JSON.stringify(withoutMermaid);
	const output = prepareRequestTools(true, { tools: withoutMermaid });
	assert.equal(JSON.stringify(withoutMermaid), input);
	assert.deepEqual(output[0].function.parameters, schema);
	assert.equal(output[0].function.description, 'read_file');
});

test('非 Agent 请求和不支持工具的模型不凭空加工具', () => {
	assert.equal(prepareRequestTools(true, { tools: [] }), undefined);
	assert.equal(prepareRequestTools(false, { tools: withoutMermaid }), undefined);
	assert.deepEqual(prepareRequestTools(true, { tools: [hostTool('read_file')] }).map((t) => t.function.name), ['read_file']);
});

test('补齐后超出模型工具上限仍报错', () => {
	assert.throws(() => prepareRequestTools(withoutMermaid.length, { tools: withoutMermaid }));
});

test('宿主未提供画图工具时，模型的画图调用仍输出 Mermaid 图', async () => {
	const emitted = [];
	await streamChatCompletion({
		prepared: {
			request: { model: 'test', messages: [], stream: true },
			client: {
				streamChatCompletion(_request, callbacks) {
					callbacks.onToolCall({
						id: 'draw-1', type: 'function',
						function: { name: 'renderMermaidDiagram', arguments: JSON.stringify({ markup: 'graph TD\nA-->B' }) },
					});
					return Promise.resolve();
				},
			},
			cacheDiagnostics: {},
		},
		progress: { report: (part) => emitted.push(part) },
		token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
		getCharsPerToken: () => 4,
		setCharsPerToken() {},
	});
	assert.equal(emitted.some((part) => part instanceof LanguageModelToolCallPart), false);
	assert.ok(emitted.some((part) => part instanceof LanguageModelTextPart && part.value.includes('```mermaid\ngraph TD\nA-->B\n```')));
});

async function main() {
	let passed = 0;
	for (const [name, fn] of cases) {
		try {
			await fn();
			console.log('✓', name);
			passed += 1;
		} catch (error) {
			console.error('✗', name, error);
			process.exitCode = 1;
		}
	}
	console.log(`${passed}/${cases.length} passed`);
}
main();
