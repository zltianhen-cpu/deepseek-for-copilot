/**
 * 视觉代理接线测试 —— 防止「删模型 / 换代理」时的静默失效回归。
 *
 * 为什么必须存在：
 *   2026-09-10 精简模型时，我把 DEFAULT_VISION_MODEL_ID 切到 deepseek-flash，
 *   却顺手把它加进了 EXCLUDED_VISION_MODEL_IDS。而两者是「与」关系：
 *       isEligible(m) = isDeepSeekDefaultVisionModel(m) && !EXCLUDED.has(m.id)
 *   结果 agent 判定通过、排除清单又把它踢掉 → 代理找不到任何模型 →
 *   V4 Pro（走代理视觉）看图直接坏。且**不报错**，只在日志里静默降级。
 *
 * 这个测试把该不变量钉死：默认代理模型绝不能在排除清单里。
 *
 * 用法: node test/smoke-vision-proxy.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const failures = [];
const ROOT = path.join(__dirname, '..');

// ═══ ① 编译产物必须存在 ═══
const visionConstsPath = path.join(ROOT, 'out', 'provider', 'vision', 'consts.js');
const constsPath = path.join(ROOT, 'out', 'consts.js');
if (!fs.existsSync(visionConstsPath) || !fs.existsSync(constsPath)) {
	failures.push('编译产物缺失（先跑 npm run compile）');
	console.error('❌ 编译产物缺失');
	process.exit(1);
}

const visionConsts = require(visionConstsPath);
const { MODELS } = require(constsPath);
const DEFAULT_VISION_MODEL_ID = visionConsts.DEFAULT_VISION_MODEL_ID;

console.log('① 默认视觉代理模型');
console.log(`   DEFAULT_VISION_MODEL_ID = ${DEFAULT_VISION_MODEL_ID}`);

// ═══ ② 不变量一：默认代理模型必须是已注册模型 ═══
const proxyModel = MODELS.find((m) => m.id === DEFAULT_VISION_MODEL_ID);
if (!proxyModel) {
	failures.push(
		`默认代理模型 ${DEFAULT_VISION_MODEL_ID} 不在 MODELS 里 —— 代理将找不到模型`,
	);
	console.log('   ❌ 不在 MODELS 中（悬空引用）');
} else {
	console.log(`   ✅ 已注册：${proxyModel.name}`);
}

// ═══ ③ 不变量二：默认代理模型必须有原生图生文能力 ═══
if (proxyModel) {
	const supportsImage =
		proxyModel.capabilities.imageInput === true ||
		proxyModel.capabilities.nativeImageInput === true;
	if (!supportsImage) {
		failures.push(
			`默认代理模型 ${DEFAULT_VISION_MODEL_ID} 未声明 imageInput —— 无法描述图片`,
		);
		console.log('   ❌ 未声明图片能力');
	} else {
		console.log('   ✅ 声明了图片输入能力');
	}
}

// ═══ ④ 不变量三（核心）：默认代理模型绝不能被排除清单踢掉 ═══
// 从源码读取排除清单（编译产物里是 Set，不易反射，直接解析源码更可靠）
const indexSrc = fs.readFileSync(
	path.join(ROOT, 'src', 'provider', 'vision', 'sources', 'vscode', 'index.ts'),
	'utf8',
);
const excludedMatch = indexSrc.match(
	/EXCLUDED_VISION_MODEL_IDS\s*=\s*new Set\(\[([\s\S]*?)\]\)/,
);
console.log('');
console.log('② 排除清单与默认代理的一致性（本次 bug 的守门员）');
if (!excludedMatch) {
	failures.push('无法从源码解析 EXCLUDED_VISION_MODEL_IDS');
	console.log('   ❌ 解析失败');
} else {
	const excluded = [...excludedMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
	console.log(`   排除清单: [${excluded.join(', ')}]`);
	if (excluded.includes(DEFAULT_VISION_MODEL_ID)) {
		failures.push(
			`❌ 致命：${DEFAULT_VISION_MODEL_ID} 同时是「默认代理」又被「排除」——` +
				'两者是「与」关系，会导致代理找不到任何模型（V4 Pro 看图静默失效）',
		);
		console.log(`   ❌ ${DEFAULT_VISION_MODEL_ID} 既当代理又被排除（自相矛盾）`);
	} else {
		console.log(`   ✅ ${DEFAULT_VISION_MODEL_ID} 不在排除清单（可当代理）`);
	}
}

// ═══ ⑤ 不变量四：每个模型都必须是合法 API id（不能残留已删条目）═══
console.log('');
console.log('③ 模型清单自洽性');
console.log(`   共 ${MODELS.length} 个模型：${MODELS.map((m) => m.id).join(', ')}`);
const dupes = MODELS.map((m) => m.id).filter((id, i, a) => a.indexOf(id) !== i);
if (dupes.length > 0) {
	failures.push(`模型 id 重复：${dupes.join(', ')}`);
	console.log(`   ❌ id 重复：${dupes.join(', ')}`);
} else {
	console.log('   ✅ 无重复 id');
}
// 被删的两个旧 id 不应再出现（防止只删了一半）
for (const gone of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
	const stillThere = MODELS.some((m) => m.id === gone);
	if (stillThere) {
		failures.push(`已决定删除的模型仍存在：${gone}`);
		console.log(`   ❌ ${gone} 仍在清单里`);
	}
}

console.log('');
if (failures.length > 0) {
	console.error('❌ 视觉代理测试失败：');
	for (const f of failures) console.error(' - ' + f);
	process.exit(1);
}
console.log('✅ 视觉代理接线测试全部通过');
process.exit(0);
