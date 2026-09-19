/**
 * 冒烟测试：token 计数按「实发口径」（技能目录折减）
 *
 * 为什么要有这个测试：
 *   VS Code 用**我们插件的 `provideTokenCount`** 结果算「上下文比例」，
 *   并据此决定是否压缩对话（起压 78–82%、紧急 90%、套用 ≥65%；见
 *   copilot 扩展 `$He` 常量与 `Q = max(渲染计数 + 工具token, 上轮真实prompt)/预算`）。
 *   而它数的是「渲染出来的全部」——里面 930 个技能块（≈34 万字符）在发请求前
 *   会被消息管线钩子剥掉（只保留命中/白名单，实测保留 5%~16%）。结果：
 *   它看到的比例虚高 → 实际 41 万就触发压缩，而同期 API 实收只有 41 万里的
 *   "真发出"部分。
 *
 *   修法：计数时把 `<skills>…</skills>` 区按「保留比例」折减（默认 10%），
 *   让宿主看到的 ≈ 我们真会发出去的。
 *
 * 断言分六类：
 *   A. 折减生效 —— 目录区按 keptShare 计入，不是全量
 *   B. 零影响   —— 没有目录的文本、图片/工具等非文本部分，一字不动
 *   C. fail-safe —— 未闭合 `<skills>` 宁可不扣
 *   D. 护栏     —— keptShare 限幅 [0.02, 0.5]，非法值不改
 *   E. 消息形态 —— content 数组里的目录同样折减
 *   F. 回退开关 —— `raw` 模式恢复全量计入（一行回滚）
 *
 * 用法: node test/smoke-token-count.js
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const ROOT = process.env.CACHE_EXTENSION_TEST_DIR || path.dirname(__dirname);

// tokens.ts 顶层 import vscode（用到几个 Part 类做 instanceof 判定），给最小桩。
class LanguageModelTextPart {
	constructor(value) {
		this.value = value;
	}
}
class LanguageModelToolCallPart {
	constructor(callId, name, input) {
		this.callId = callId;
		this.name = name;
		this.input = input;
	}
}
class LanguageModelToolResultPart {
	constructor(callId, content) {
		this.callId = callId;
		this.content = content;
	}
}
class LanguageModelDataPart {
	constructor(data, mimeType) {
		this.data = data;
		this.mimeType = mimeType;
	}
}
class LanguageModelThinkingPart {
	constructor(value) {
		this.value = value;
	}
}

const vscodeStub = {
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	LanguageModelDataPart,
	LanguageModelThinkingPart,
};

const load = Module._load;
Module._load = function (id, ...rest) {
	if (id === 'vscode') return vscodeStub;
	return load.call(this, id, ...rest);
};

const tokens = require(path.join(ROOT, 'out', 'provider', 'tokens.js'));
const {
	estimateTokenCount,
	estimateMessageChars,
	setSkillCatalogKeptShare,
	getSkillCatalogKeptShare,
	setTokenCountMode,
} = tokens;

const CPT = 4;

/** 造一个 `n` 块的技能目录区（贴近真实：名称 + 描述 + filePath） */
function catalog(n) {
	let s = '<skills>\n';
	for (let i = 0; i < n; i++) {
		s +=
			`<skill>\n<name>skill-${i}</name>\n<description>${'d'.repeat(240)}</description>\n` +
			`<filePath>/x/skills/skill-${i}/SKILL.md</filePath>\n</skill>\n`;
	}
	return s + '</skills>';
}

const cases = [];
function test(name, fn) {
	cases.push([name, fn]);
}

// ── A. 折减生效 ────────────────────────────────────────────────
test('A 技能目录：按保留比例折减（默认 10%），不再全量计入', () => {
	setTokenCountMode('real-send');
	setSkillCatalogKeptShare(0.1);
	const cat = catalog(50);
	const text = 'H'.repeat(800) + '\n' + cat + '\n' + 'T'.repeat(800);
	const raw = Math.ceil(text.length / CPT);
	const expect = Math.ceil((text.length - cat.length * 0.9) / CPT);
	const got = estimateTokenCount(text, CPT);
	assert.ok(got < raw * 0.75, `应显著小于全量口径（got=${got} raw=${raw}）`);
	assert.equal(got, expect);
});

// ── B. 零影响 ─────────────────────────────────────────────────
test('B 没有技能目录的文本：一字不动', () => {
	setTokenCountMode('real-send');
	const text = 'hello world '.repeat(100);
	assert.equal(estimateTokenCount(text, CPT), Math.ceil(text.length / CPT));
});

test('B 图片部分：固定 384，不受折减影响', () => {
	setSkillCatalogKeptShare(0.1);
	const message = {
		role: 'user',
		content: [new LanguageModelDataPart(new Uint8Array(1024), 'image/png')],
	};
	assert.equal(estimateTokenCount(message, CPT), 384);
});

// ── C. fail-safe ──────────────────────────────────────────────
test('C 未闭合 <skills>：宁可不扣', () => {
	const bad = '<skills>\n<skill><name>a</name></skill>\n' + 'x'.repeat(500);
	assert.equal(estimateTokenCount(bad, CPT), Math.ceil(bad.length / CPT));
});

// ── D. 护栏 ───────────────────────────────────────────────────
test('D 保留比例限幅 [0.02, 0.5]，非法值不改', () => {
	setSkillCatalogKeptShare(0);
	assert.equal(getSkillCatalogKeptShare(), 0.02);
	setSkillCatalogKeptShare(9);
	assert.equal(getSkillCatalogKeptShare(), 0.5);
	setSkillCatalogKeptShare(Number.NaN);
	assert.equal(getSkillCatalogKeptShare(), 0.5);
	setSkillCatalogKeptShare(0.1);
	assert.equal(getSkillCatalogKeptShare(), 0.1);
});

// ── E. 消息形态 ───────────────────────────────────────────────
test('E 消息形态（content 数组）里的技能目录同样折减', () => {
	setSkillCatalogKeptShare(0.1);
	const cat = catalog(40);
	const message = {
		role: 'system',
		content: [new LanguageModelTextPart('P'.repeat(400) + cat)],
	};
	const rawChars = 400 + cat.length;
	const expect = Math.ceil((rawChars - cat.length * 0.9) / CPT);
	assert.equal(estimateTokenCount(message, CPT), expect);
});

// ── F. 回退开关 ───────────────────────────────────────────────
test('F raw 模式：恢复全量计入（一行回滚）', () => {
	const text = catalog(20);
	setTokenCountMode('raw');
	assert.equal(estimateTokenCount(text, CPT), Math.ceil(text.length / CPT));
	setTokenCountMode('real-send');
	setSkillCatalogKeptShare(0.1);
	assert.ok(estimateTokenCount(text, CPT) < Math.ceil(text.length / CPT));
});

// 无会话身份的计数不能使用任何其它请求发布的比例。
for (const ratio of [0.05,0.5,3,NaN]) test('全局比例不污染其它请求 '+ratio,()=>{
 setTokenCountMode('real-send');setSkillCatalogKeptShare(0.1);
 const text='X'.repeat(4000)+catalog(30),before=estimateTokenCount(text,CPT);
 tokens.setRealSendRatio(ratio);assert.equal(estimateTokenCount(text,CPT),before);
 assert.equal(tokens.getRealSendRatio(),1);assert.equal(tokens.isRealSendRatioActive(),false);
 tokens.resetRealSendRatio();
});
test('raw 不受比例污染',()=>{setTokenCountMode('raw');tokens.setRealSendRatio(0.05);assert.equal(estimateTokenCount('x'.repeat(1000),CPT),250);setTokenCountMode('real-send')});

// ── K. 转换前口径（estimateMessageChars）──────────────────────
// 实发比的分母从「转换后」换到「转换前」（宿主口径）：estimateMessageChars
// 量 convert 之前的消息字符数——只数文本/思考/工具参数，图片像素不计。
test('K 转换前口径：只数文本/思考/工具参数，图片不计、异常不炸', () => {
	const msgs = [
		{ role: 1, content: [new LanguageModelTextPart('a'.repeat(120))] },
		{
			role: 2,
			content: [
				new LanguageModelTextPart('b'.repeat(80)),
				new LanguageModelToolCallPart('call_1', 'read_file', { path: 'x.md' }),
			],
		},
		{
			role: 1,
			content: [
				new LanguageModelToolResultPart('call_1', [new LanguageModelTextPart('c'.repeat(40))]),
				new LanguageModelDataPart(new Uint8Array(2048), 'image/png'),
			],
		},
	];
	const expected =
		120 +
		80 +
		('call_1'.length + 'read_file'.length + JSON.stringify({ path: 'x.md' }).length) +
		('call_1'.length + 40);
	assert.equal(estimateMessageChars(msgs), expected);
	assert.equal(estimateMessageChars(null), 0);
	assert.equal(estimateMessageChars([{}]), 0);
});

let pass = 0;
let fail = 0;
for (const [name, fn] of cases) {
	try {
		fn();
		pass++;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		fail++;
		console.log(`  ✗ ${name}\n    ${e && e.message}`);
	}
}
console.log(`\n${pass} 通过 / ${fail} 失败（共 ${cases.length}）`);
process.exit(fail ? 1 : 0);
