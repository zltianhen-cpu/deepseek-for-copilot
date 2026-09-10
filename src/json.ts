const REPLACEMENT_CHARACTER = '\uFFFD';
const LONE_SURROGATE_PATTERN = /([\uD800-\uDBFF][\uDC00-\uDFFF])|[\uD800-\uDFFF]/g;
/**
 * 序列化产物里是否残留孤立代理转义（\ud800-\udfff）。
 *
 * 用途：值清理走 replacer，但 **replacer 改不了键名**。所以序列化后若仍有代理区
 * 转义，来源必是键名 —— 据此决定是否再走一遍键名清理。干净载荷零额外开销。
 *
 * ⚠️ 大小写敏感：V8 输出小写 `\ud800`，只匹配大写会漏检（真实踩过这个坑）。
 */
const LONE_SURROGATE_ESCAPE = /\\u[dD][0-9a-fA-F]{3}/;

type WellFormedString = string & {
	toWellFormed?: () => string;
};

/** 值清理器：所有字符串值转良构（JSON.stringify 的 replacer） */
function wellFormedReplacer(_key: string, entryValue: unknown): unknown {
	return typeof entryValue === 'string' ? toWellFormedString(entryValue) : entryValue;
}

/**
 * 递归清理**键名**里的孤立代理字符。
 *
 * 为什么需要：`JSON.stringify` 的 replacer 只能替换值，**改不了键名**。而键名可以
 * 来自数据 —— 视觉代理的「额外请求体 JSON」是用户粘贴的、工具 inputSchema 的属性名
 * 来自工具定义 —— 键名一旦含孤立代理，请求体就是非法 JSON，DeepSeek 直接 400。
 *
 * 安全边界（刻意收窄，避免破坏语义）：
 *  - 只重建**普通对象**（原型为 Object.prototype / null）；类实例、Date、Map 等原样
 *    返回，保留它们自己的 toJSON 语义
 *  - **仅在确有改动时**才重建（否则返回原引用），干净载荷的对象身份不变
 */
function sanitizeKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item) => {
			const cleaned = sanitizeKeysDeep(item);
			if (cleaned !== item) {
				changed = true;
			}
			return cleaned;
		});
		return changed ? next : value;
	}

	if (value === null || typeof value !== 'object') {
		return value;
	}

	const proto: unknown = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		return value;
	}

	let changed = false;
	const next: Record<string, unknown> = {};
	for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
		const cleanKey = toWellFormedString(key);
		if (cleanKey !== key) {
			changed = true;
		}
		const cleanValue = sanitizeKeysDeep(entryValue);
		if (cleanValue !== entryValue) {
			changed = true;
		}
		next[cleanKey] = cleanValue;
	}

	return changed ? next : value;
}

export function safeStringify(value: unknown): string {
	const json = JSON.stringify(value, wellFormedReplacer);

	if (json === undefined) {
		throw new TypeError('Value cannot be serialized as JSON');
	}

	// 快路径：值与键名都干净 —— 零额外开销（绝大多数请求走这里）
	if (!LONE_SURROGATE_ESCAPE.test(json)) {
		return json;
	}

	// 慢路径：仍有代理区转义 ⇒ 值已由 replacer 清理，来源只能是键名。
	// 走结构化键名清理后重新序列化 —— 不对文本做替换，避免误伤内容里合法的
	// `\ud800` 字面量（例如用户在对话中讨论转义序列）。
	return JSON.stringify(sanitizeKeysDeep(value), wellFormedReplacer) ?? json;
}

export function toWellFormedString(value: string): string {
	const toWellFormed = (value as WellFormedString).toWellFormed;
	if (typeof toWellFormed === 'function') {
		return toWellFormed.call(value);
	}

	return value.replace(LONE_SURROGATE_PATTERN, (_match, pair: string | undefined) =>
		pair ? pair : REPLACEMENT_CHARACTER,
	);
}
