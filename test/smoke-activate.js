/**
 * 冒烟测试：不启动 VS Code，直接把 `vscode` API 打桩，跑一遍 activate()。
 *
 * 目的（自研二开专用）：
 *  1. 证明编译产物能正常加载、activate 不抛异常
 *  2. 证明注册的 vendor / 命令 ID 都是我们改过的 `deepseek-fork`（不是别人的 `deepseek` / `deepseek-copilot`）
 *     —— 命令 ID 撞车 VS Code 会直接抛 `command 'x' already exists`，导致插件启动失败
 *
 * 用法: node test/smoke-activate.js
 */
'use strict';

const path = require('node:path');
const Module = require('node:module');

const record = { commands: [], vendors: [], tools: [], uriHandlers: 0, channels: [] };

/** 未知 API 的兜底：返回一个「万能替身」，任何取值/调用/构造都不炸 */
function fallback(name) {
	const target = function () {};
	return new Proxy(target, {
		get(t, p) {
			if (p === 'then') return undefined; // 防止被当成 thenable
			if (p === Symbol.toPrimitive) return () => `<stub:${name}>`;
			if (p === 'toString') return () => `<stub:${name}>`;
			if (!(p in t)) t[p] = fallback(`${name}.${String(p)}`);
			return t[p];
		},
		apply() {
			return fallback(`${name}()`);
		},
		construct() {
			return fallback(`new ${name}`);
		},
	});
}


class Disposable {
	constructor(fn) {
		this._fn = fn;
	}
	dispose() {
		if (typeof this._fn === 'function') this._fn();
	}
}

function uriLike(s) {
	const str = String(s);
	return {
		scheme: 'file',
		path: str,
		fsPath: str,
		toString: () => str,
		with: (x) => uriLike(x && x.path ? x.path : str),
	};
}

const configStub = {
	get: (_key, def) => def,
	has: () => false,
	update: async () => {},
	inspect: () => undefined,
};

const outputChannel = {
	info() {},
	warn() {},
	error() {},
	debug() {},
	trace() {},
	appendLine() {},
	show() {},
	dispose() {},
};

const vscodeStub = {
	version: '1.136.1',
	Disposable,
	Uri: {
		parse: uriLike,
		file: uriLike,
		from: (components) =>
			uriLike(
				components && (components.path || components.fsPath || components.authority || ''),
			),
		joinPath: (base, ...rest) =>
			uriLike([base && base.fsPath ? base.fsPath : base, ...rest].join('/')),
	},
	EventEmitter: class {
		constructor() {
			this.event = () => new Disposable();
		}
		fire() {}
		dispose() {}
	},
	ThemeIcon: class {
		constructor(id) {
			this.id = id;
		}
	},
	env: {
		language: 'zh-cn',
		remoteName: undefined,
		uiKind: 1,
		appName: 'Visual Studio Code',
		openExternal: async () => true,
		asExternalUri: async (u) => u,
		clipboard: { writeText: async () => {} },
	},
	commands: {
		registerCommand: (id) => {
			record.commands.push(id);
			return new Disposable();
		},
		executeCommand: async () => undefined,
		getCommands: async () => [],
	},
	lm: {
		registerLanguageModelChatProvider: (vendor) => {
			record.vendors.push(vendor);
			return new Disposable();
		},
		registerTool: (id) => {
			record.tools.push(typeof id === 'string' ? id : id && id.id);
			return new Disposable();
		},
		selectChatModels: async () => [],
		tools: [],
	},
	window: {
		createOutputChannel: (name) => {
			record.channels.push(name);
			return outputChannel;
		},
		registerUriHandler: () => {
			record.uriHandlers += 1;
			return new Disposable();
		},
		showErrorMessage: async () => undefined,
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showQuickPick: async () => undefined,
		showInputBox: async () => undefined,
		showOpenDialog: async () => undefined,
		withProgress: async (_opts, cb) =>
			cb({ report() {} }, { onCancellationRequested: () => new Disposable() }),
		activeTextEditor: undefined,
		visibleTextEditors: [],
		tabGroups: { all: [] },
	},
	workspace: {
		getConfiguration: () => configStub,
		onDidChangeConfiguration: () => new Disposable(),
		onDidChangeTextDocument: () => new Disposable(),
		onDidSaveTextDocument: () => new Disposable(),
		workspaceFolders: [],
		textDocuments: [],
		fs: {
			readFile: async () => new Uint8Array(),
			writeFile: async () => {},
			createDirectory: async () => {},
			stat: async () => ({ type: 1 }),
		},
	},
	extensions: { getExtension: () => undefined, all: [] },
	LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
	LanguageModelTextPart: class {
		constructor(value) {
			this.value = value;
		}
	},
	LanguageModelToolCallPart: class {
		constructor(callId, name, input) {
			this.callId = callId;
			this.name = name;
			this.input = input;
		}
	},
	LanguageModelToolResultPart: class {
		constructor(callId, content) {
			this.callId = callId;
			this.content = content;
		}
	},
	LanguageModelDataPart: class {
		constructor(data, mimeType) {
			this.data = data;
			this.mimeType = mimeType;
		}
	},
	LanguageModelError: class extends Error {},
	LanguageModelChatMessage: class {},
	lm_: undefined,
};

// 顶层也套兜底 + 兼容 __importDefault/default 互操作
const vscode = new Proxy(vscodeStub, {
	get(t, p) {
		if (p === '__esModule') return true;
		if (p === 'default') return vscode; // 自引用
		if (p in t) return t[p];
		if (p === 'then') return undefined;
		return fallback(`vscode.${String(p)}`);
	},
});

// 让 require('vscode') 拿到打桩对象
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === 'vscode') return vscode;
	return originalLoad.call(this, request, ...rest);
};

function makeContext() {
	const pkg = require(path.join(__dirname, '..', 'package.json'));
	return {
		subscriptions: [],
		extension: {
			id: `${pkg.publisher}.${pkg.name}`,
			extensionUri: uriLike('/tmp/deepseek-fork'),
			extensionKind: 1,
			packageJSON: pkg,
		},
		secrets: {
			get: async () => undefined,
			store: async () => {},
			delete: async () => {},
			onDidChange: () => new Disposable(),
		},
		globalState: { get: () => undefined, update: async () => {}, keys: () => [] },
		workspaceState: { get: () => undefined, update: async () => {}, keys: () => [] },
		globalStorageUri: uriLike('/tmp/deepseek-fork-storage'),
		storageUri: uriLike('/tmp/deepseek-fork-storage-ws'),
		logUri: uriLike('/tmp/deepseek-fork-log'),
		extensionMode: 3,
		asAbsolutePath: (p) => path.join('/tmp/deepseek-fork', p),
	};
}

(async () => {
	const failures = [];

	try {
		const ext = require(path.join(__dirname, '..', 'out', 'extension.js'));
		const context = makeContext();
		if (typeof ext.activate !== 'function') throw new Error('out/extension.js 没有导出 activate');
		await ext.activate(context);
		console.log('[1/2] activate() 执行成功，未抛异常 ✅');
	} catch (error) {
		failures.push(`activate() 抛异常: ${error && error.stack ? error.stack : error}`);
	}

	// 断言：vendor 必须是我们的
	if (record.vendors.length !== 1) {
		failures.push(`vendor 注册数量异常：期望 1，实际 ${record.vendors.length} (${record.vendors})`);
	} else if (record.vendors[0] !== 'deepseek-fork') {
		failures.push(`vendor 应为我们自己的 'deepseek-fork'，实际 '${record.vendors[0]}'（会跟别人撞车）`);
	} else {
		console.log(`[2/2] vendor = ${record.vendors[0]} ✅`);
	}

	// 断言：命令 ID 全部用我们自己的前缀
	const wrongPrefix = record.commands.filter((id) => !id.startsWith('deepseek-fork.'));
	if (wrongPrefix.length > 0) {
		failures.push(`有命令 ID 不是 deepseek-fork 前缀（会与原插件撞车导致启动失败）：${wrongPrefix.join(', ')}`);
	}

	console.log('');
	console.log('--- 实测注册结果 ---');
	console.log(`vendor        : ${record.vendors.join(', ') || '(无)'}`);
	console.log(`command (${record.commands.length})     : ${record.commands.join(', ') || '(无)'}`);
	console.log(`uriHandler    : ${record.uriHandlers}`);
	console.log(`outputChannel : ${record.channels.join(', ') || '(无)'}`);

	if (failures.length > 0) {
		console.log('');
		console.error('❌ 冒烟测试失败：');
		for (const f of failures) console.error(' - ' + f);
		process.exit(1);
	}
	console.log('');
	console.log('✅ 冒烟测试全部通过');
	// 扩展内部会留常驻定时器/句柄，不主动退出脚本会一直挂着
	process.exit(0);
})();
