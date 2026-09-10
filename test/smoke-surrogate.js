/**
 * 冒烟测试：孤立代理字符防护（自研二开专用）
 *
 * 为什么要有这个测试：
 *   插件靠 `safeStringify()` 在序列化前把孤立代理字符（lone surrogate）替换成
 *   U+FFFD，否则 DeepSeek 的 JSON 解析器会直接 400 拒收。**修复已实现，但此前
 *   没有任何测试保护它** —— 一次重构换回 `JSON.stringify` 就会静默回退，而且
 *   只在真实请求时才会暴露（用户侧 400，本地无感）。
 *
 * 四类断言：
 *   A. 真载荷    —— 带孤立代理的请求体必须被清理干净
 *   B. 非回归    —— 干净载荷（含合法 emoji / 中文）必须原样不动
 *   C. 检测器自检 —— 拿已知坏输入断言「确实能被检出」，防止检测逻辑本身失效
 *                    （踩过：正则写大写 \uD800 而 V8 输出小写 \ud800 → 假通过）
 *   D. 覆盖面护栏 —— 两条出网请求路径必须仍走 safeStringify，禁止换回裸 stringify
 *
 * 用法: node test/smoke-surrogate.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.dirname(__dirname);
const OUT_JSON = path.join(ROOT, 'out', 'json.js');

// ⚠️ 不在源码里写裸孤立代理字符（源文件本身含孤立代理会引发工具链问题），
//    一律运行时构造。
const LONE_HIGH = String.fromCharCode(0xd800); // \uD800 无配对低位
const LONE_LOW = String.fromCharCode(0xdc00); // \uDC00 无配对高位
const EMOJI = '\uD83D\uDE00'; // 合法代理对（必须保留）

let failures = 0;
const ok = (msg) => console.log(`  ✅ ${msg}`);
const bad = (msg, extra) => {
        failures += 1;
        console.log(`  ❌ ${msg}`);
        if (extra) console.log(`     ${extra}`);
};

/** 序列化产物里出现代理区转义吗 —— 这才是 DeepSeek 真正拒收的形态。
 *  注意大小写：V8 输出小写 `\ud800`，写成 `\\uD` 会漏检（真实踩过）。 */
const hasEscapedLoneSurrogate = (text) => /\\u[dD][0-9a-fA-F]{3}/.test(text);

/** 字符串里还有孤立代理（未配对的高位/低位）吗 —— 良构判断 */
const hasUnpairedSurrogate = (text) =>
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

if (!fs.existsSync(OUT_JSON)) {
        console.error(`❌ 找不到编译产物 ${OUT_JSON}，先跑 npm run compile`);
        process.exit(1);
}

const { safeStringify, toWellFormedString } = require(OUT_JSON);

console.log('目标产物:', OUT_JSON);
console.log();

// ═══════════════════ A. 真载荷 ═══════════════════
console.log('════ A. 真载荷（必须被清理）════');

const dirty = {
        model: 'deepseek-v4',
        stream: true,
        messages: [
                { role: 'system', content: 'You are helpful.' },
                // content 里带孤立代理
                { role: 'user', content: `粘贴来的内容${LONE_HIGH}坏字符` },
                {
                        role: 'assistant',
                        content: 'ok',
                        // 🔑 关键字段：扩展会把模型 CoT 原文挂回这里（v1 补丁时代漏的正是它）
                        reasoning_content: `推理原文${LONE_HIGH}引用文件片段`,
                        tool_calls: [
                                {
                                        id: 'call_1',
                                        type: 'function',
                                        function: {
                                                name: 'read_file',
                                                arguments: `{"path":"/tmp/${LONE_LOW}a.txt"}`,
                                        },
                                },
                        ],
                },
                { role: 'tool', tool_call_id: 'call_1', content: `结果${LONE_HIGH}` },
                // 嵌套数组里的字符串
                {
                        role: 'user',
                        content: [{ type: 'text', text: `嵌套${LONE_LOW}深一层` }],
                },
        ],
        tools: [
                {
                        type: 'function',
                        function: {
                                name: 'read_file',
                                description: `描述${LONE_HIGH}`,
                                parameters: { type: 'object', properties: { p: { type: 'string' } } },
                        },
                },
        ],
        // 自定义/未来新增字段（白名单式清理会漏掉这类字段）
        custom_future_field: `未来字段${LONE_HIGH}`,
};

const dirtyOut = safeStringify(dirty);
if (hasEscapedLoneSurrogate(dirtyOut)) {
        bad('孤立代理字符泄漏到序列化产物', dirtyOut.slice(0, 120));
} else {
        ok('序列化产物无代理区转义（含 reasoning_content / tool_calls / 嵌套 / 未来字段）');
}

// 逐个字段点名，便于定位是哪个字段漏了
for (const [label, probe] of [
        ['content', `x${LONE_HIGH}y`],
        ['reasoning_content', `x${LONE_HIGH}y`],
        ['tool_calls.arguments', `{"a":"${LONE_LOW}"}`],
        ['嵌套数组', `x${LONE_LOW}y`],
        ['未来新增字段', `x${LONE_HIGH}y`],
]) {
        const out = safeStringify({ [label]: probe });
        if (hasEscapedLoneSurrogate(out)) bad(`${label} 未清理`, out);
        else ok(`${label} 已清理`);
}

// 键名里的孤立代理也要清（deepSanitize 时代就要求清 key）
{
        const out = safeStringify({ [`key${LONE_HIGH}`]: 'v' });
        if (hasEscapedLoneSurrogate(out)) bad('键名里的孤立代理未清理', out);
        else ok('键名里的孤立代理已清理');
}

// toWellFormedString 单独验（两个方向的孤立都要处理）
for (const [label, input] of [
        ['孤立高位 \\uD800', `a${LONE_HIGH}b`],
        ['孤立低位 \\uDC00', `a${LONE_LOW}b`],
        ['连续多个', `${LONE_HIGH}${LONE_HIGH}x${LONE_LOW}`],
        ['末尾孤立', `abc${LONE_HIGH}`],
        ['仅代理字符', LONE_HIGH],
]) {
        const got = toWellFormedString(input);
        if (hasUnpairedSurrogate(got)) {
                bad(`toWellFormedString 未处理 ${label}`, JSON.stringify(got));
        } else {
                ok(`toWellFormedString 处理 ${label}`);
        }
}

console.log();

// ═══════════════════ B. 非回归 ═══════════════════
console.log('════ B. 非回归（干净载荷必须原样不动）════');

const clean = {
        model: 'deepseek-v4',
        messages: [
                { role: 'user', content: `看图 emoji ${EMOJI} 和中文，还有制表符\t换行\n` },
                { role: 'assistant', reasoning_content: '正常推理内容', tool_calls: [] },
        ],
        tools: [{ type: 'function', function: { name: 'f', description: '读取文件' } }],
        temperature: 0.3,
        max_tokens: 4096,
};

const cleanOut = safeStringify(clean);
const plainOut = JSON.stringify(clean);
if (cleanOut === plainOut) {
        ok('干净载荷 safeStringify 输出与 JSON.stringify 完全一致');
} else {
        bad('干净载荷被改动了（有误伤正常数据的风险）');
        const i = [...plainOut].findIndex((c, idx) => c !== cleanOut[idx]);
        console.log(`     首个差异 @${i}`);
        console.log(`     期望: ...${plainOut.slice(Math.max(0, i - 50), i + 50)}...`);
        console.log(`     实际: ...${cleanOut.slice(Math.max(0, i - 50), i + 50)}...`);
}

if (cleanOut.includes(EMOJI)) ok('合法 emoji 代理对原样保留');
else bad('合法 emoji 被误伤', cleanOut);

if (toWellFormedString(`emoji ${EMOJI} ok`) === `emoji ${EMOJI} ok`) {
        ok('toWellFormedString 不误伤合法代理对');
} else {
        bad('toWellFormedString 误伤合法代理对');
}

// 🔑 关键边界：内容里「字面量 \ud800 六个字符」必须原样保留。
// 这正是键名清理走「结构化重建」而不是「对序列化文本做正则替换」的原因——
// 文本替换会把用户正在讨论的转义序列（如对话中贴的代码）改成 U+FFFD。
{
        const literal = String.raw`内容里有转义写法 \ud800 六个字符`;
        const got = safeStringify({ text: literal });
        const want = JSON.stringify({ text: literal });
        if (got === want) ok('内容里字面量 `\\ud800` 未被误改（不做文本替换的收益）');
        else bad('字面量 `\\ud800` 被改动了', `期望 ${want} / 实际 ${got}`);
}

console.log();

// ═══════════════════ C. 检测器自检 ═══════════════════
console.log('════ C. 检测器自检（防止检测逻辑本身失效）════');

// 用一个「已知含孤立代理」的原始序列化结果，断言检测器确实能检出。
// 若这条失败，说明 hasEscapedLoneSurrogate 坏了 —— 上面所有 ✅ 都不可信。
const knownBad = JSON.stringify({ x: LONE_HIGH });
if (hasEscapedLoneSurrogate(knownBad)) {
        ok('检测器对已知坏输入确实报警（上面的 ✅ 可信）');
} else {
        bad('检测器失效：已知坏输入未检出，上面所有结论都不可信', knownBad);
}

if (!hasEscapedLoneSurrogate(JSON.stringify({ x: EMOJI }))) {
        ok('检测器不误报合法 emoji');
} else {
        bad('检测器把合法 emoji 误报为泄漏');
}

console.log();

// ═══════════════════ D. 覆盖面护栏 ═══════════════════
console.log('════ D. 覆盖面护栏（禁止回退为裸 JSON.stringify）════');

/** 检查一条出网请求路径是否仍走 safeStringify */
function guardRequestPath(relPath, requiredCall, forbidden) {
        const abs = path.join(ROOT, relPath);
        if (!fs.existsSync(abs)) {
                bad(`${relPath} 不存在（路径变了？护栏需同步）`);
                return;
        }
        const src = fs.readFileSync(abs, 'utf8');
        if (!src.includes(requiredCall)) {
                bad(`${relPath} 不再调用 ${requiredCall}`, '—— 请求体可能未做代理字符清理');
                return;
        }
        const hit = forbidden.find((f) => src.includes(f));
        if (hit) {
                bad(`${relPath} 出现裸序列化 ${hit}`, '—— 必须走 safeStringify');
                return;
        }
        ok(`${relPath} → ${requiredCall}`);
}

// 主对话链路（POST /chat/completions）
guardRequestPath('src/client/core.ts', 'safeStringify(requestBody)', [
        'JSON.stringify(requestBody',
]);
// 视觉链路
guardRequestPath('src/provider/vision/protocols/client.ts', 'safeStringify(options.body)', [
        'JSON.stringify(options.body',
]);

console.log();

// ═══════════════════ 汇总 ═══════════════════
if (failures === 0) {
        console.log('✅ 全部通过：孤立代理字符防护有效，且未被绕过。');
        process.exit(0);
}

console.log(`❌ ${failures} 项失败 —— 代理字符防护可能已回退，别发布。`);
process.exit(1);
