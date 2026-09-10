/**
 * 错误消息保真测试：**上游真实原因必须透传给用户**。
 *
 * 为什么需要这个测试（2026-09-10 实测）：
 *   400 时上游返回 `Content Exists Risk`（内容风险），但用户看到的是本地通用文案
 *   「请求体格式错误。请根据错误信息提示修改请求体。」
 *   → 上游原因被丢弃，用户被误导去改请求体（改了根本没用，因为请求体没错）。
 *
 * 三层验证：
 *   ① 上游有 message 时 —— 用户可见消息必须包含它（保真）
 *   ② 上游无 message 时 —— 回退本地文案，不能空/脏
 *   ③ 边界 —— 401 不回归、非 JSON 响应体不崩
 *
 * 用法: node test/smoke-error-message.js
 */
'use strict';

const Module = require('node:module');
const path = require('node:path');

// ---- 打桩 vscode（i18n 读 vscode.env.language）----
const vscodeStub = { version: 'smoke', env: { language: 'zh-cn' } };
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === 'vscode') return vscodeStub;
	return originalLoad.call(this, request, ...rest);
};

const { createHttpError, createUserFacingError } = require(
	path.join(__dirname, '..', 'out', 'client', 'error', 'index.js'),
);

const failures = [];

function mockResponse(status, statusText, bodyText) {
	return { status, statusText, ok: false, text: async () => bodyText };
}

function ctx(baseUrl = 'https://api.deepseek.com') {
	return {
		baseUrl,
		request: {
			model: 'deepseek-flash',
			stream: true,
			messages: [{ role: 'user', content: 'hi' }],
		},
	};
}

function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

async function check(name, fn) {
	try {
		await fn();
		console.log(`   ✅ ${name}`);
	} catch (error) {
		failures.push(`${name} — ${error.message}`);
		console.log(`   ❌ ${name} — ${error.message}`);
	}
}

// 2026-09-10 实测的真实响应体（原文照抄，勿"美化"）
const REAL_400_BODY = JSON.stringify({
	error: {
		message: 'Content Exists Risk',
		type: 'invalid_request_error',
		param: null,
		code: 'invalid_request_error',
	},
});

(async () => {
	console.log('① 上游 400「Content Exists Risk」→ 用户必须看到它');
	await check('Content Exists Risk 出现在用户可见消息里', async () => {
		const err = await createHttpError(
			mockResponse(400, 'Bad Request', REAL_400_BODY),
			ctx(),
		);
		const userMessage = createUserFacingError(err).message;
		assert(
			userMessage.includes('Content Exists Risk'),
			`用户消息没带上游原因。实际: ${userMessage.slice(0, 140)}`,
		);
	});

	console.log();
	console.log('② 上游无 message → 回退本地文案（不空、不脏）');
	await check('空响应体回退本地文案', async () => {
		const err = await createHttpError(
			mockResponse(400, 'Bad Request', ''),
			ctx(),
		);
		const userMessage = createUserFacingError(err).message;
		assert(userMessage.length > 0, '用户消息为空');
		assert(
			!userMessage.includes('undefined') && !userMessage.includes('null'),
			`回退文案含脏字段: ${userMessage.slice(0, 140)}`,
		);
	});

	console.log();
	console.log('③ 边界：不回归、不崩');
	await check('401 文案仍包含 401', async () => {
		const err = await createHttpError(
			mockResponse(401, 'Unauthorized', '{"error":{"message":"Authentication Fails"}}'),
			ctx(),
		);
		const userMessage = createUserFacingError(err).message;
		assert(userMessage.includes('401'), `401 文案丢了状态码: ${userMessage.slice(0, 140)}`);
	});

	await check('非 JSON 响应体不崩', async () => {
		const err = await createHttpError(
			mockResponse(502, 'Bad Gateway', '<html>gateway boom</html>'),
			ctx(),
		);
		const userMessage = createUserFacingError(err).message;
		assert(userMessage.length > 0, '用户消息为空');
	});

	console.log();
	if (failures.length === 0) {
		console.log('✅ 全部通过');
		process.exit(0);
	}
	console.log(`❌ ${failures.length} 项失败：`);
	failures.forEach((f) => console.log(`   - ${f}`));
	process.exit(1);
})();
