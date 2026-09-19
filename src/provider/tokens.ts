import vscode from 'vscode';
import { REPLAY_MARKER_MIME } from './replay';

const IMAGE_PART_FIXED_TOKENS = 384;

/**
 * 技能目录区（`<skills>…</skills>`）在出站请求里只保留命中/白名单块，
 * 其余由消息管线钩子在发请求前剥掉（本机实测：保留 5%~16%）。
 *
 * 宿主（VS Code）用我们的 `provideTokenCount` 结果算「上下文比例」，
 * 并据此决定是否压缩对话（起压 78–82%、紧急 90%、套用 ≥65%）。若把整段
 * 目录都算进去，比例会虚高 → 实际内容还没到线就先触发压缩（2026-09-17
 * 实测：它记录的渲染计数 ≈ 实发 + 目录块）。所以这里按「实发口径」计数：
 * 目录区只按保留比例计入。
 */
const SKILLS_SECTION_RE = /<skills>[\s\S]*?<\/skills>/;
const DEFAULT_SKILL_CATALOG_KEPT_SHARE = 0.1;
const MIN_SKILL_CATALOG_KEPT_SHARE = 0.02;
const MAX_SKILL_CATALOG_KEPT_SHARE = 0.5;

let skillCatalogKeptShare = DEFAULT_SKILL_CATALOG_KEPT_SHARE;
let tokenCountMode: 'real-send' | 'raw' =
	process.env.DEEPSEEK_TOKEN_COUNT_MODE === 'raw' ? 'raw' : 'real-send';

/** 无会话身份的宿主计数不能借用其它请求的压缩比例；保留兼容导出。 */
export function setRealSendRatio(_ratio: number): void {}
export function resetRealSendRatio(): void {}
export function getRealSendRatio(): number {
	return 1;
}
export function isRealSendRatioActive(): boolean {
	return false;
}
function applyRealSendRatio(tokens: number): number {
	return tokens;
}

/** 目录区保留比例（钩子实际保留多少就报多少）；越界值限幅，非法值忽略。 */
export function setSkillCatalogKeptShare(share: number): void {
	if (!Number.isFinite(share)) {
		return;
	}
	skillCatalogKeptShare = Math.min(
		MAX_SKILL_CATALOG_KEPT_SHARE,
		Math.max(MIN_SKILL_CATALOG_KEPT_SHARE, share),
	);
}

export function getSkillCatalogKeptShare(): number {
	return skillCatalogKeptShare;
}

/** 回退开关：`raw` = 恢复旧的全量计入（一行回滚）。 */
export function setTokenCountMode(mode: 'real-send' | 'raw'): void {
	tokenCountMode = mode;
}

export function getTokenCountMode(): 'real-send' | 'raw' {
	return tokenCountMode;
}

/** 实发口径字符数：技能目录区按保留比例折减；无目录 / 未闭合 → 原样返回。 */
function effectiveTextChars(text: string): number {
	if (tokenCountMode === 'raw' || text.indexOf('<skills>') === -1) {
		return text.length;
	}
	// 实发比生效时按原文计——技能目录的节约已经含在 r 里，不能再折一次（双重打折）
	if (isRealSendRatioActive()) {
		return text.length;
	}
	const matched = SKILLS_SECTION_RE.exec(text);
	if (!matched) {
		return text.length; // 未闭合：宁可不扣，也不误伤正文
	}
	return text.length - matched[0].length * (1 - skillCatalogKeptShare);
}

interface PartTokenEstimate {
	textChars: number;
	fixedTokens: number;
}

/**
 * Recursively estimate text chars and fixed token parts for a single content part.
 */
function estimatePartTokens(part: unknown): PartTokenEstimate {
	// 1. LanguageModelTextPart — the most common case（技能目录区按实发口径折减）
	if (part instanceof vscode.LanguageModelTextPart) {
		return { textChars: effectiveTextChars(part.value), fixedTokens: 0 };
	}

	// 2. LanguageModelToolCallPart — count callId + name + JSON-serialized input
	if (part instanceof vscode.LanguageModelToolCallPart) {
		let chars = part.callId.length + part.name.length;
		try {
			chars += JSON.stringify(part.input).length;
		} catch {
			// If input can't be stringified (e.g. contains circular refs), fall back to a rough estimate
			chars += 2;
		}
		return { textChars: chars, fixedTokens: 0 };
	}

	// 3. LanguageModelToolResultPart — recursively count nested content parts
	if (part instanceof vscode.LanguageModelToolResultPart) {
		let textChars = part.callId.length;
		let fixedTokens = 0;
		if (Array.isArray(part.content)) {
			for (const item of part.content) {
				const nested = estimatePartTokens(item);
				textChars += nested.textChars;
				fixedTokens += nested.fixedTokens;
			}
		}
		return { textChars, fixedTokens };
	}

	// 4. LanguageModelDataPart — use a capped heuristic because our model never
	//    receives binary data directly. Images are resolved to text descriptions
	//    by the vision pipeline; raw byteLength would massively overestimate.
	if (part instanceof vscode.LanguageModelDataPart) {
		const mime = part.mimeType;
		if (mime === REPLAY_MARKER_MIME) {
			// Marker metadata is not sent as assistant content. Its vision text belongs
			// logically to a previous user image message, but provideTokenCount only
			// receives one message at a time and cannot safely bind history here.
			return { textChars: 0, fixedTokens: 0 };
		}

		// Keep image estimation conservative and independent from charsPerToken
		// so native-image requests do not distort adaptive text calibration.
		if (mime.startsWith('image/')) {
			return { textChars: 0, fixedTokens: IMAGE_PART_FIXED_TOKENS };
		}
		// PDFs and other documents: use byteLength as a rough proxy but cap it
		// to prevent a single large attachment from dominating the budget.
		return {
			textChars: Math.min(part.data?.byteLength ?? 0, 10000),
			fixedTokens: 0,
		};
	}

	// 5. LanguageModelThinkingPart (proposed API) — handle string | string[]
	if (isLanguageModelThinkingPart(part)) {
		if (typeof part.value === 'string') {
			return { textChars: part.value.length, fixedTokens: 0 };
		}
		if (Array.isArray(part.value)) {
			let textChars = 0;
			for (const s of part.value) {
				textChars += s.length;
			}
			return { textChars, fixedTokens: 0 };
		}
		return { textChars: 0, fixedTokens: 0 };
	}

	// 6. LanguageModelPromptTsxPart — stringify the value if present
	// Duck-type check since PromptTsxPart may not always be available
	if (
		part &&
		typeof part === 'object' &&
		'value' in part &&
		part.constructor?.name === 'LanguageModelPromptTsxPart'
	) {
		try {
			return {
				textChars: JSON.stringify((part as { value: unknown }).value).length,
				fixedTokens: 0,
			};
		} catch {
			return { textChars: 0, fixedTokens: 0 };
		}
	}

	// Fallback: try to stringify unknown part types
	if (part && typeof part === 'object') {
		try {
			return { textChars: JSON.stringify(part).length, fixedTokens: 0 };
		} catch {
			return { textChars: 0, fixedTokens: 0 };
		}
	}

	return { textChars: 0, fixedTokens: 0 };
}

/**
 * Check for LanguageModelThinkingPart (proposed API, may not be available at runtime).
 */
function isLanguageModelThinkingPart(part: unknown): part is vscode.LanguageModelThinkingPart {
	return (
		typeof (vscode as Record<string, unknown>).LanguageModelThinkingPart === 'function' &&
		part instanceof vscode.LanguageModelThinkingPart
	);
}

export function estimateTokenCount(
	text: string | vscode.LanguageModelChatRequestMessage,
	charsPerToken: number,
): number {
	if (typeof text === 'string') {
		return applyRealSendRatio(Math.max(1, Math.ceil(effectiveTextChars(text) / charsPerToken)));
	}

	if (!text?.content || !Array.isArray(text.content)) {
		return 1;
	}

	let totalChars = 0;
	let fixedTokens = 0;
	for (const part of text.content) {
		const estimate = estimatePartTokens(part);
		totalChars += estimate.textChars;
		fixedTokens += estimate.fixedTokens;
	}

	const textTokens = totalChars > 0 ? Math.ceil(totalChars / charsPerToken) : 0;
	return applyRealSendRatio(Math.max(1, textTokens + fixedTokens));
}

/**
 * 量「转换前」（宿主口径）消息的总字符数：复用 estimatePartTokens 的口径，
 * 只数文本 / 思考 / 工具参数，图片像素不计。
 *
 * 用途：把「实发比」的分母从「转换后」换到「转换前」——r ≈ 实发 ÷ 宿主原始量，
 * 把 convert 阶段丢掉的那一刀（思考块 / 标记等）也算进账，宿主的尺子量到的就
 * ≈ 我们真正发出去的。任何异常都安全返回 0（调用方会退回旧口径）。
 */
export function estimateMessageChars(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): number {
	try {
		if (!Array.isArray(messages)) {
			return 0;
		}
		let total = 0;
		for (const msg of messages) {
			const content: unknown = (msg as { content?: unknown } | undefined)?.content;
			if (!Array.isArray(content)) {
				continue;
			}
			for (const part of content) {
				total += estimatePartTokens(part).textChars;
			}
		}
		return total;
	} catch {
		return 0;
	}
}
