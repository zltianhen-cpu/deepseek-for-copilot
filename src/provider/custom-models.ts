import vscode from 'vscode';
import { CONFIG_SECTION, MODELS } from '../consts';
import { logger } from '../logger';
import type {
	ModelDefinition,
	ModelPricing,
	ModelPricingSchedule,
	PriceCategory,
	PricingCurrency,
	ReasoningEffort,
} from '../types';

/**
 * 用户可配置的「额外模型」（设置项 `deepseek-fork.customModels`）。
 *
 * 为什么要它：内置模型表 `MODELS` 是编译进扩展的常量，要让插件支持自建网关
 * （NewAPI / 火山方舟 / 企业 LLM 网关…）新接的模型，过去必须改代码 + 发版；
 * `modelIdOverrides` 只能改已有模型的 API ID，加不了新条目。这里读设置、做防御性
 * 校验，把通过的条目**按配置顺序追加在内置模型之后**。
 *
 * 校验口径（故意保守——坏条目绝不能弄坏模型选择器，更不能让 provider 崩）：
 *   - `id` / `name` 必须是非空字符串；
 *   - `maxInputTokens` / `maxOutputTokens` 必须是正整数；
 *   - `capabilities` 缺省给安全默认：`toolCalling: true`、`imageInput: false`、不支持思考；
 *   - `pricing` 可选；价格表格式不对就丢掉价格（宁可不显示，也不能显示错价）；
 *   - 自定义条目的 `id` 与内置重名时**以自定义为准**（方便临时改名调试）；
 *   - 顺序稳定：内置在前（去掉被顶掉的），自定义按配置数组顺序追加——不打乱前缀。
 *
 * ⛔ 本文件只读设置、不写设置；空配置（默认 `[]`）时行为与加此功能前**完全一致**。
 */

/** 设置的原始形状：一切都当未知处理，逐字段校验。 */
interface RawCustomModel {
	id?: unknown;
	name?: unknown;
	detail?: unknown;
	tooltip?: unknown;
	family?: unknown;
	version?: unknown;
	maxInputTokens?: unknown;
	maxOutputTokens?: unknown;
	capabilities?: unknown;
	requiresThinkingParam?: unknown;
	pricing?: unknown;
	priceCategory?: unknown;
}

const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'high', 'max'];
const PRICE_CATEGORIES: readonly PriceCategory[] = ['low', 'medium', 'high', 'very_high'];
const PRICING_CURRENCIES: readonly PricingCurrency[] = ['USD', 'CNY'];

/** 模型选择器里显示的兜底副标题（未配置 `detail` 时用）。 */
const DEFAULT_DETAIL = 'Custom model (configured locally)';
/** 未配置 `version` 时的兜底版本号。 */
const DEFAULT_VERSION = 'custom';

/**
 * 读设置里的自定义模型。非法条目跳过并记一条 warning，绝不抛错。
 */
export function getCustomModels(): ModelDefinition[] {
	const raw = readRawSetting();
	if (raw.length === 0) {
		return [];
	}
	const models: ModelDefinition[] = [];
	for (let index = 0; index < raw.length; index += 1) {
		const parsed = parseCustomModel(raw[index], index);
		if (parsed) {
			models.push(parsed);
		}
	}
	return models;
}

/**
 * 内置 + 自定义的完整模型表。
 *
 * 自定义条目的 `id` 与内置重名时以自定义为准（内置同 id 项被顶掉），
 * 其余内置保持原顺序、自定义按配置顺序排在末尾 —— 顺序稳定，避免影响缓存前缀。
 */
export function getAllModels(): ModelDefinition[] {
	const custom = getCustomModels();
	if (custom.length === 0) {
		return MODELS;
	}
	const customIds = new Set(custom.map((model) => model.id));
	return [...MODELS.filter((model) => !customIds.has(model.id)), ...custom];
}

function readRawSetting(): RawCustomModel[] {
	try {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const value = config.get<unknown>('customModels');
		if (!Array.isArray(value)) {
			return [];
		}
		const entries: RawCustomModel[] = [];
		for (let index = 0; index < value.length; index += 1) {
			const entry: unknown = value[index];
			if (isPlainObject(entry)) {
				entries.push(entry);
			} else {
				warn(index, '不是对象（应为 `{ id, name, … }`），已跳过该条目');
			}
		}
		return entries;
	} catch (error) {
		logger.warn('Failed to read deepseek-fork.customModels', error);
		return [];
	}
}

function parseCustomModel(entry: RawCustomModel, index: number): ModelDefinition | undefined {
	const id = readNonEmptyString(entry.id);
	const name = readNonEmptyString(entry.name);
	if (!id || !name) {
		warn(index, '需要非空字符串的 `id` 与 `name`，已跳过该条目');
		return undefined;
	}
	const maxInputTokens = readPositiveInt(entry.maxInputTokens);
	const maxOutputTokens = readPositiveInt(entry.maxOutputTokens);
	if (!maxInputTokens || !maxOutputTokens) {
		warn(index, '`maxInputTokens` / `maxOutputTokens` 需为正整数，已跳过该条目');
		return undefined;
	}

	const { capabilities, requiresThinkingParam } = parseCapabilities(entry.capabilities, index);
	const pricing = parsePricing(entry.pricing, index);

	return {
		id,
		name,
		family: readNonEmptyString(entry.family) ?? 'deepseek',
		version: readNonEmptyString(entry.version) ?? DEFAULT_VERSION,
		detail: readNonEmptyString(entry.detail) ?? DEFAULT_DETAIL,
		maxInputTokens,
		maxOutputTokens,
		capabilities,
		requiresThinkingParam,
		...(pricing ? { pricing } : {}),
		...(isPriceCategory(entry.priceCategory) ? { priceCategory: entry.priceCategory } : {}),
	};
}

/** capabilities 缺省给安全默认：可工具调用、不支持图片、不支持思考。 */
function parseCapabilities(
	raw: unknown,
	index: number,
): Pick<ModelDefinition, 'capabilities' | 'requiresThinkingParam'> {
	const defaults = {
		capabilities: {
			toolCalling: true,
			imageInput: false,
			thinking: false as const,
		},
		requiresThinkingParam: true,
	};
	if (!isPlainObject(raw)) {
		return defaults;
	}
	const toolCalling = raw.toolCalling;
	const imageInput = raw.imageInput;
	return {
		capabilities: {
			toolCalling:
				typeof toolCalling === 'number'
					? toolCalling
					: typeof toolCalling === 'boolean'
						? toolCalling
						: true,
			imageInput: typeof imageInput === 'boolean' ? imageInput : false,
			nativeImageInput: raw.nativeImageInput === true,
			thinking: parseThinking(raw.thinking, index),
		},
		requiresThinkingParam:
			typeof raw.requiresThinkingParam === 'boolean' ? raw.requiresThinkingParam : true,
	};
}

function parseThinking(raw: unknown, index: number): ModelDefinition['capabilities']['thinking'] {
	if (!isPlainObject(raw)) {
		return false;
	}
	const supported = Array.isArray(raw.supportedEfforts)
		? raw.supportedEfforts.filter(isReasoningEffort)
		: [];
	if (supported.length === 0) {
		warn(index, '`capabilities.thinking.supportedEfforts` 为空或非法，按“不支持思考”处理');
		return false;
	}
	const defaultEffort =
		isReasoningEffort(raw.defaultEffort) && supported.includes(raw.defaultEffort)
			? raw.defaultEffort
			: supported[0];
	return {
		supportedEfforts: supported,
		defaultEffort,
		canDisable: raw.canDisable === true,
	};
}

/** 价格表可选；任一处格式不对就整块丢掉（宁可不显示价格，也不能显示错价）。 */
function parsePricing(
	raw: unknown,
	index: number,
): Readonly<Record<PricingCurrency, ModelPricingSchedule>> | undefined {
	if (raw === undefined || raw === null) {
		return undefined;
	}
	if (!isPlainObject(raw)) {
		warn(index, '`pricing` 不是对象，已忽略价格（模型仍可用）');
		return undefined;
	}
	const result: Partial<Record<PricingCurrency, ModelPricingSchedule>> = {};
	for (const currency of PRICING_CURRENCIES) {
		const schedule = parsePricingSchedule(raw[currency]);
		if (schedule) {
			result[currency] = schedule;
		}
	}
	if (!result.USD && !result.CNY) {
		warn(index, '`pricing` 里没有可用的 USD/CNY 价目表，已忽略价格（模型仍可用）');
		return undefined;
	}
	return result as Readonly<Record<PricingCurrency, ModelPricingSchedule>>;
}

function parsePricingSchedule(raw: unknown): ModelPricingSchedule | undefined {
	if (!isPlainObject(raw)) {
		return undefined;
	}
	const offPeak = parsePricingTier(raw.offPeak);
	const peak = parsePricingTier(raw.peak);
	return offPeak && peak ? { offPeak, peak } : undefined;
}

function parsePricingTier(raw: unknown): ModelPricing | undefined {
	if (!isPlainObject(raw)) {
		return undefined;
	}
	const cacheHitInput = readNonNegativeNumber(raw.cacheHitInput);
	const cacheMissInput = readNonNegativeNumber(raw.cacheMissInput);
	const output = readNonNegativeNumber(raw.output);
	if (cacheHitInput === undefined || cacheMissInput === undefined || output === undefined) {
		return undefined;
	}
	return { cacheHitInput, cacheMissInput, output };
}

/** 已警告过的消息：解析会在**每次请求**跑一遍，不去重会把输出日志刷屏。 */
const warnedMessages = new Set<string>();

function warn(index: number, message: string): void {
	const text = `deepseek-fork.customModels[${index}]: ${message}`;
	if (warnedMessages.has(text)) {
		return;
	}
	warnedMessages.add(text);
	logger.warn(text);
}

/** 测试口：清掉「已警告」记录（模拟新会话）。 */
export function _resetCustomModelWarningsForTest(): void {
	warnedMessages.clear();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readPositiveInt(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
	return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

function isPriceCategory(value: unknown): value is PriceCategory {
	return typeof value === 'string' && (PRICE_CATEGORIES as readonly string[]).includes(value);
}
