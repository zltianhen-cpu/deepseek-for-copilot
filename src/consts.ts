import { DEEPSEEK_TOOLS_LIMIT } from './provider/tools/consts';
import type { ModelDefinition } from './types';

/**
 * Compile-time constants shared across the extension.
 *
 * These do NOT depend on the VS Code runtime (no workspace configuration,
 * no secrets API). For run-time settings reads see `config.ts`.
 */

/** VS Code configuration section prefix for all extension settings. */
export const CONFIG_SECTION = 'deepseek-copilot';

export const EXTERNAL_URLS = {
	deepseek: {
		apiKeys: 'https://platform.deepseek.com/api_keys',
		usage: 'https://platform.deepseek.com/usage',
		status: 'https://status.deepseek.com',
	},
} as const;

/** URI path handled by this extension to reveal the output log. */
export const SHOW_LOGS_URI_PATH = '/showLogs';

/** URI path handled by this extension to open API key configuration. */
export const CONFIGURE_API_KEY_URI_PATH = '/setApiKey';

/** URI path handled by this extension to open vision model configuration. */
export const SET_VISION_MODEL_URI_PATH = '/setVisionModel';

// VS Code's internal LanguageModelChatMessageRole.System is not exposed in @types/vscode.
export const LANGUAGE_MODEL_CHAT_SYSTEM_ROLE = 3;

// ---- Secret keys ----

/** SecretStorage key for the DeepSeek API key. */
export const API_KEY_SECRET = 'deepseek-copilot.apiKey';

/** memento key tracking whether the welcome walkthrough has been shown. */
export const WELCOME_SHOWN_KEY = 'deepseek-copilot.welcomeShown';

// ---- Walkthrough ----

/** Walkthrough contribution ID. */
export const WALKTHROUGH_ID = 'zltianhen.deepseek-for-copilot#deepseekGettingStarted';

// ---- Model registry ----

/** Available DeepSeek models exposed through the language model provider. */
export const MODELS: ModelDefinition[] = [
	{
		// V4.1 Flash：内测期 API 名是 `deepseek-v4.1-flash-expires-on-0910`（带过期日期），
		// 2026-09-10 实测已转正 —— 官方 /models 列出的正式名就是 `deepseek-flash`。
		// 同日后端把 v4-flash / v4.1-flash / flash-vision-exp 全部归一到 `deepseek-flash`，
		// 所以这里用官方正式名（长期有效，不受内测到期影响）。
		// 相比 V4 Flash 的差异：原生多模态直传（nativeImageInput），不再走视觉代理。
		id: 'deepseek-flash',
		name: 'DeepSeek V4.1 Flash（自研版）',
		family: 'deepseek',
		version: 'v4.1',
		detail: '官方正式名 deepseek-flash · 原生多模态',
		maxInputTokens: 655360,
		maxOutputTokens: 393216,
		capabilities: {
			toolCalling: DEEPSEEK_TOOLS_LIMIT,
			imageInput: true,
			nativeImageInput: true,
			thinking: {
				supportedEfforts: ['low', 'high', 'max'],
				defaultEffort: 'high',
				canDisable: true,
			},
		},
		requiresThinkingParam: true,
		// 与 V4 Flash 同价：服务端归一后本就是同一个后端模型
		pricing: {
			USD: {
				offPeak: { cacheHitInput: 0.007, cacheMissInput: 0.22, output: 0.66 },
				peak: { cacheHitInput: 0.014, cacheMissInput: 0.44, output: 1.32 },
			},
			CNY: {
				offPeak: { cacheHitInput: 0.05, cacheMissInput: 1.5, output: 4.5 },
				peak: { cacheHitInput: 0.1, cacheMissInput: 3, output: 9 },
			},
		},
		priceCategory: 'low',
	},
	{
		id: 'deepseek-v4-pro',
		name: 'DeepSeek V4 Pro（自研版）',
		family: 'deepseek',
		version: 'v4',
		detail: 'Most capable reasoning model',
		maxInputTokens: 655360,
		maxOutputTokens: 393216,
		capabilities: {
			toolCalling: DEEPSEEK_TOOLS_LIMIT,
			imageInput: true,
			nativeImageInput: false,
			thinking: {
				supportedEfforts: ['low', 'high', 'max'],
				defaultEffort: 'high',
				canDisable: true,
			},
		},
		requiresThinkingParam: true,
		pricing: {
			USD: {
				offPeak: { cacheHitInput: 0.022, cacheMissInput: 0.66, output: 1.98 },
				peak: { cacheHitInput: 0.044, cacheMissInput: 1.32, output: 3.96 },
			},
			CNY: {
				offPeak: { cacheHitInput: 0.15, cacheMissInput: 4.5, output: 13.5 },
				peak: { cacheHitInput: 0.3, cacheMissInput: 9, output: 27 },
			},
		},
		priceCategory: 'low',
	},
];
