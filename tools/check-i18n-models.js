#!/usr/bin/env node
'use strict';

// 校验每个模型的 i18n 键在「中文」和「英文」下都能解析（而不是变成死键回落到硬编码）。
// i18n.js 依赖 `vscode`，这里用最小 stub 顶替。

const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');
const fakeVscode = { env: { language: 'en' } };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return fakeVscode;
	}
	return originalLoad.call(this, request, parent, isMain);
};

const { t } = require(path.join(root, 'out', 'i18n.js'));
const { MODELS } = require(path.join(root, 'out', 'consts.js'));

const FIELDS = ['name', 'detail', 'tooltip'];
let failures = 0;

for (const locale of ['en', 'zh-cn']) {
	fakeVscode.env.language = locale;
	console.log(`\n═══ locale = ${locale} ═══`);
	for (const model of MODELS) {
		console.log(`  ${model.id}`);
		for (const field of FIELDS) {
			const key = `model.${model.id}.${field}`;
			const value = t(key);
			if (value === key) {
				console.log(`    ❌ ${field.padEnd(8)} 死键（未定义，会回落到硬编码）`);
				failures += 1;
			} else {
				console.log(`    ✅ ${field.padEnd(8)} ${value}`);
			}
		}
	}
}

// 反向检查：i18n 里定义但没有任何模型使用的 model.* 键（死文案）。
fakeVscode.env.language = 'en';
const i18nSource = require('fs').readFileSync(
	path.join(root, 'src', 'i18n.ts'),
	'utf8',
);
const defined = new Set(
	[...i18nSource.matchAll(/'model\.([a-z0-9.-]+)'/g)].map((m) => m[1]),
);
const expected = new Set(
	MODELS.flatMap((m) => FIELDS.map((f) => `${m.id}.${f}`)),
);
const orphanKeys = [...defined].filter(
	(k) => !expected.has(k) && !k.startsWith('pricing.'),
);

console.log('\n═══ 定义但无人使用的 model.* 键（应为空）═══');
if (orphanKeys.length === 0) {
	console.log('  ✅ 无孤儿键');
} else {
	for (const k of orphanKeys) {
		console.log(`  ❌ model.${k}`);
		failures += 1;
	}
}

console.log(`\n结果：${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
