#!/usr/bin/env node
/**
 * 发布前一致性检查（自研二开专用）
 *
 * 背景：本仓库是从上游 `Vizards/deepseek-v4-for-copilot` 二开而来，已把
 * 扩展 ID / vendor / 命令 ID 改成自研命名空间。**但改名很容易只做一半** ——
 * 命令 ID 改了、README 里的安装链接还指着上游；配置项前缀没改，市场文案
 * 说的又是另一套。
 *
 * 这个脚本不替你做决定，只把**不一致**摊开：
 *   1. ID 引用一致性：凡是出现「另一个扩展 ID」的地方（README 徽章 / 安装链接 /
 *      vsce login / repository），全部点名。**发布前必须为 0**，否则用户点你的
 *      「安装」按钮会装成别人的扩展。
 *   2. 命名空间一致性：package.json 声明的命令 ID / 配置项 必须与代码里注册、
 *      读取的完全一致（不一致 = 命令点了没反应、设置改了不生效）。
 *   3. 配置命名空间是否仍沿用上游（**这不是错，是要你明确知道**：沿用=老用户设置
 *      无缝迁移、但与上游同时安装会互相影响）。
 *
 * 用法:
 *   node tools/check-publish.mjs           # 人读报告
 *   node tools/check-publish.mjs --json    # 机器读
 *   退出码：有 ERROR = 1，仅 WARN/INFO = 0
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

const errors = [];
const warnings = [];
const infos = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);
const info = (m) => infos.push(m);

const read = (rel) => {
	const abs = path.join(ROOT, rel);
	return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
};

const pkg = JSON.parse(read('package.json'));
const publisher = pkg.publisher;
const extName = pkg.name;
const expectedId = `${publisher}.${extName}`;

// ══════════════ 1. ID 引用一致性 ══════════════
// 只查「会引导用户/发布流程」的文件；CHANGELOG 是有意保留的上游历史，排除。
const SCAN_FILES = [
	'README.md',
	'README.zh-cn.md',
	'package.json',
	'package.nls.json',
	'package.nls.zh-cn.json',
	'dist/README.marketplace.md',
	'.github/workflows/release.yml',
	'.github/workflows/publish.yml',
];

// 匹配各种「另一个扩展 ID」的写法
const ID_PATTERNS = [
	// Marketplace 安装链接
	{ re: /marketplace\.visualstudio\.com\/items\?itemName=([\w.-]+)/g, what: 'Marketplace 安装链接' },
	// Open VSX
	{ re: /open-vsx\.org\/extension\/([\w.-]+\/[\w.-]+)/g, what: 'Open VSX 链接' },
	// 市场徽章（installs/downloads/rating）
	{ re: /vsmarketplacebadges\.dev\/[\w-]+\/([\w.-]+)\.svg/g, what: '市场徽章' },
	// GitHub 徽章里的仓库 owner/repo
	{ re: /img\.shields\.io\/github\/[\w-]+\/([\w.-]+\/[\w.-]+)\?/g, what: 'GitHub 徽章' },
	// vsce login <publisher>
	{ re: /vsce\s+login\s+([\w.-]+)/g, what: 'vsce login 的 publisher' },
];

const idRefs = [];
for (const rel of SCAN_FILES) {
	const text = read(rel);
	if (text === null) continue;
	const lineOf = (index) => text.slice(0, index).split('\n').length;
	for (const { re, what } of ID_PATTERNS) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(text)) !== null) {
			idRefs.push({ file: rel, line: lineOf(m.index), what, found: m[1] });
		}
	}
	// repository.url（GitHub 仓库地址，另算：它是"代码在哪"，不是"扩展是谁"）
}

for (const ref of idRefs) {
	const found = ref.found.replace('/', '.');
	const isLogin = ref.what.includes('vsce login');
	const isGithubRepo = ref.what.includes('GitHub 徽章');

	if (isLogin) {
		if (ref.found !== publisher) {
			err(
				`${ref.file}:${ref.line} ${ref.what} = \`${ref.found}\`，` +
					`但 package.json 的 publisher 是 \`${publisher}\` —— ` +
					'`vsce login` 必须与 publisher 一致，否则发布会失败，或发到别人的账号下。',
			);
		} else {
			info(`${ref.file}:${ref.line} ${ref.what} 一致（${ref.found}）`);
		}
		continue;
	}

	if (isGithubRepo) {
		// GitHub owner 与 Marketplace publisher 本来就是两回事，只提示
		info(`${ref.file}:${ref.line} ${ref.what} = ${ref.found}（仓库位置，非扩展 ID）`);
		continue;
	}

	if (found !== expectedId) {
		err(
			`${ref.file}:${ref.line} ${ref.what} 指向 \`${found}\`，` +
				`但本扩展是 \`${expectedId}\` —— ` +
				'用户点这个链接会装成**另一个扩展**（或跳到不存在的页面）。',
		);
	} else {
		info(`${ref.file}:${ref.line} ${ref.what} 正确（${expectedId}）`);
	}
}

// ══════════════ 2. 命名空间一致性 ══════════════
const contributes = pkg.contributes ?? {};

/** 取 package.json 声明的东西 */
const declaredCommands = (contributes.commands ?? []).map((c) => c.command);
const cfgEntries = Array.isArray(contributes.configuration)
	? contributes.configuration
	: contributes.configuration
		? [contributes.configuration]
		: [];
const declaredConfigKeys = cfgEntries.flatMap((c) =>
	Object.keys(c.properties ?? {}),
);
const declaredVendors = (contributes.languageModelChatProviders ?? []).map(
	(p) => p.vendor,
);

/** 取代码里注册/读取的东西 */
const consts = read('src/consts.ts') ?? '';

/** 递归收集 src/ 下的 .ts —— 命令可能注册在任意模块里。
 *  （踩过：只扫 commands.ts 会漏掉 provider.ts 注册的 3 个命令 → 误报"未注册"。） */
function walkTs(dir, out = []) {
	const abs = path.join(ROOT, dir);
	if (!fs.existsSync(abs)) return out;
	for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
		const rel = path.join(dir, entry.name);
		if (entry.isDirectory()) walkTs(rel, out);
		else if (entry.name.endsWith('.ts')) out.push(rel);
	}
	return out;
}

const tsSources = walkTs('src').map((rel) => ({ rel, text: read(rel) ?? '' }));

const srcConfigSection = /CONFIG_SECTION\s*=\s*'([^']+)'/.exec(consts)?.[1];

const srcRegisteredCommands = tsSources.flatMap(({ text }) =>
	[...text.matchAll(/registerCommand\(\s*'([^']+)'/g)].map((m) => m[1]),
);

const prefixOf = (id) => id.split('.').slice(0, -1).join('.') || id;

// 2a. 命令：声明 vs 注册
const missingReg = declaredCommands.filter((c) => !srcRegisteredCommands.includes(c));
const undeclaredReg = srcRegisteredCommands.filter((c) => !declaredCommands.includes(c));
if (missingReg.length) {
	err(
		`package.json 声明了但代码未注册的命令：${missingReg.join(', ')} —— ` +
			'用户点击会报 `command not found`。',
	);
}
if (undeclaredReg.length) {
	err(
		`代码注册了但 package.json 未声明的命令：${undeclaredReg.join(', ')} —— ` +
			'这些命令不会出现在命令面板，也没法绑定快捷键。',
	);
}
if (!missingReg.length && !undeclaredReg.length) {
	info(`命令声明与注册一致（${declaredCommands.length} 条，扫了 ${tsSources.length} 个源文件）`);
}

// 2b. 配置项：声明的键必须都在代码读取的 section 下
if (srcConfigSection) {
	const outsideSection = declaredConfigKeys.filter(
		(key) => !key.startsWith(`${srcConfigSection}.`),
	);
	if (outsideSection.length) {
		err(
			`这些配置项不在代码读取的 section \`${srcConfigSection}\` 下：` +
				`${outsideSection.join(', ')} —— 用户改了不生效。`,
		);
	} else {
		info(`配置项声明（${declaredConfigKeys.length} 个）全部位于 \`${srcConfigSection}\` 下`);
	}
} else {
	warn('未在 src/consts.ts 找到 CONFIG_SECTION，跳过配置项校验');
}

// ══════════════ 3. 命名空间是否统一（提示，非错误）══════════════
// 「自研命名空间」以**命令 ID 前缀**为准（它必须改，否则与上游命令撞车导致插件
// 启动失败）。其余命名空间若与它不一致 = 改了一半，需要你明确是否刻意为之。
const commandPrefixes = [...new Set(declaredCommands.map(prefixOf))];
const selfNs = commandPrefixes[0];
const namespaceMap = [
	{ name: '命令 ID', value: commandPrefixes.join(' / ') },
	{ name: '配置项(section)', value: srcConfigSection ?? '(未找到)' },
	{ name: '模型 vendor', value: declaredVendors.join(' / ') || '(无)' },
];

for (const ns of namespaceMap.slice(1)) {
	if (ns.value && ns.value !== '(未找到)' && ns.value !== '(无)' && ns.value !== selfNs) {
		warn(
			`命名空间不统一：命令用 \`${selfNs}\`，${ns.name} 用 \`${ns.value}\`。\n` +
				'      若刻意沿用上游（例如让老用户设置无缝迁移），请在此备注确认；\n' +
				`      若要隔离，把它们一并改成 \`${selfNs}\`（记得同步 package.nls 文案）。`,
		);
	}
}
if (commandPrefixes.length > 1) {
	warn(`命令 ID 前缀不统一：${commandPrefixes.join(' / ')}`);
}
if (declaredVendors.length > 1) {
	warn(`languageModelChatProviders vendor 不唯一：${declaredVendors.join(' / ')}`);
}

// ══════════════ 4. 仍指向**上游仓库**的引用（可见但不阻塞）══════════════
// 扩展 ID 已改成自己的，但 `repository.url`、README 的 GitHub 链接、i18n 的文档链接
// 仍指向上游仓库。这些**不能自动改** —— 需要先定你自己的仓库地址，所以只报出来。
//
// 不处理的后果（都不是报错，但都影响真实用户）：
//   · 市场页「Repository」链接挂到原作者仓库
//   · README 里的「提交 Issue」会把 issue 提给上游
//   · `repository.url` 会让 vsce 把 README 相对图片改写成上游仓库的 raw 链接
//   · GitHub 版本徽章会显示**上游**的版本号（不是你的）
const UPSTREAM_REPO_MARKER = /Vizards/g;
const REPO_SCAN_ROOTS = [
	'package.json',
	'README.md',
	'README.zh-cn.md',
	'src/i18n.ts',
	'docs',
	'resources',
	'.github',
];

const repoTextFiles = (() => {
	const out = [];
	const walk = (rel) => {
		const abs = path.join(ROOT, rel);
		if (!fs.existsSync(abs)) return;
		if (fs.statSync(abs).isDirectory()) {
			for (const entry of fs.readdirSync(abs)) walk(path.join(rel, entry));
			return;
		}
		if (!/\.(ts|js|md|json|ya?ml)$/.test(rel)) return;
		if (/CHANGELOG/i.test(rel)) return; // 上游发布历史，刻意保留
		out.push(rel);
	};
	for (const root of REPO_SCAN_ROOTS) walk(root);
	return out;
})();

const upstreamRefs = [];
for (const rel of repoTextFiles) {
	const text = read(rel);
	if (text === null) continue;
	UPSTREAM_REPO_MARKER.lastIndex = 0;
	let m;
	while ((m = UPSTREAM_REPO_MARKER.exec(text)) !== null) {
		upstreamRefs.push(`${rel}:${text.slice(0, m.index).split('\n').length}`);
	}
}

if (upstreamRefs.length) {
	const byFile = new Map();
	for (const ref of upstreamRefs) {
		const file = ref.split(':')[0];
		byFile.set(file, (byFile.get(file) ?? 0) + 1);
	}
	warn(
		`仍有 ${upstreamRefs.length} 处引用上游仓库 Vizards（${byFile.size} 个文件）：\n` +
			[...byFile.entries()].map(([f, n]) => `        ${f} (${n} 处)`).join('\n') +
			'\n      这些**无法自动改** —— 需先定你自己的仓库地址。不处理的后果：\n' +
			'      · 市场页「Repository」链接指向原作者仓库\n' +
			'      · README 里的「提交 Issue」会把 issue 提给上游\n' +
			'      · `repository.url` 会让 vsce 把 README 相对图片改写成上游 raw 链接\n' +
			'      · GitHub 版本徽章显示的是**上游**的版本号\n' +
			'      定好仓库后，改 package.json 的 repository.url 并全局替换这些链接即可。',
	);
} else {
	info('无上游仓库引用');
}

// ══════════════ 报告 ══════════════
const result = {
	extensionId: expectedId,
	publisher,
	name: extName,
	namespaces: {
		commands: commandPrefixes,
		configSectionInCode: srcConfigSection,
		configKeysDeclared: declaredConfigKeys.length,
		vendors: declaredVendors,
	},
	upstreamRefs,
	errors,
	warnings,
	infos,
	ok: errors.length === 0,
};

if (asJson) {
	console.log(JSON.stringify(result, null, 2));
	process.exit(result.ok ? 0 : 1);
}

console.log(`扩展 ID: ${expectedId}`);
console.log();
console.log('命名空间');
console.log(`  命令      : ${commandPrefixes.join(', ') || '(无)'}`);
console.log(`  代码读配置: ${srcConfigSection ?? '(未找到 CONFIG_SECTION)'}`);
console.log(`  配置项    : ${declaredConfigKeys.length} 个`);
console.log(`  模型 vendor: ${declaredVendors.join(', ') || '(无)'}`);
console.log();

if (errors.length) {
	console.log(`❌ ERROR（${errors.length}）—— 发布前必须清零`);
	for (const m of errors) console.log(`   · ${m}`);
	console.log();
}
if (warnings.length) {
	console.log(`⚠️  WARN（${warnings.length}）—— 需要你明确决定，不阻塞发布`);
	for (const m of warnings) console.log(`   · ${m}`);
	console.log();
}
if (infos.length) {
	console.log(`ℹ️  INFO（${infos.length}）`);
	for (const m of infos) console.log(`   · ${m}`);
	console.log();
}
console.log(result.ok ? '✅ 无阻塞项' : '❌ 存在阻塞项，先修完再发布');
process.exit(result.ok ? 0 : 1);
