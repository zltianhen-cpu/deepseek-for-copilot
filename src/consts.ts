import { DEEPSEEK_TOOLS_LIMIT } from './provider/tools/consts';
import type { ModelDefinition } from './types';

/**
 * Compile-time constants shared across the extension.
 *
 * These do NOT depend on the VS Code runtime (no workspace configuration,
 * no secrets API). For run-time settings reads see `config.ts`.
 */

/**
 * VS Code configuration section prefix for all extension settings.
 *
 * 必须与上游（`deepseek-copilot`）隔离：配置节是**全局设置键**，不按扩展隔离，
 * 两个扩展声明同一节会互相串读、设置页也会打架。
 */
export const CONFIG_SECTION = 'deepseek-fork';

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

/**
 * SecretStorage key for the DeepSeek API key.
 *
 * ⚠️ 这里的 `deepseek-copilot.` 前缀是**故意保留的**，不要「顺手统一」成 `deepseek-fork.`。
 * VS Code 的 SecretStorage / globalState 是**按扩展隔离**的，不同扩展之间永远不会撞键，
 * 所以改名没有任何隔离收益；反而会让已存好的 API Key 读不出来，逼所有已安装用户重填。
 * 只有全局作用域的配置节（见 CONFIG_SECTION）才需要与上游隔离。
 */
export const API_KEY_SECRET = 'deepseek-copilot.apiKey';

/** memento key tracking whether the welcome walkthrough has been shown. 同上：按扩展隔离，不改名。 */
export const WELCOME_SHOWN_KEY = 'deepseek-copilot.welcomeShown';

// ---- Walkthrough ----

/** Walkthrough contribution ID. */
export const WALKTHROUGH_ID = 'zltianhen.deepseek-for-copilot#deepseekGettingStarted';

// ---- Model registry ----

/** Available DeepSeek models exposed through the language model provider. */
export const MODELS: ModelDefinition[] = [
	{
		// ⚠️ 名字分两层，别混：
		//   产品名 = **Flash** —— 用户看到的名字、选择器里显示的名字、我们对外说的名字。
		//   API 名 = `deepseek-flash` —— 只发给服务端的标识符，别拿它当模型名跟人讲。
		// 2026-09-10 实测：传 `deepseek-v4.1-flash` 官方直接 400
		//   （原文：The supported API model names are deepseek-flash, deepseek-v4-pro）。
		//   官方 /models 也只列这两个；v4-flash / v4.1-flash-expires-on-0910 / flash-vision-exp
		//   都被后端归一到 `deepseek-flash`，所以 API 名写它最稳（不受内测到期影响）。
		// 相比 V4 Flash 的差异：原生图片输入（nativeImageInput：只能看图，不生成图片），不再走视觉代理。
		id: 'deepseek-flash',
		name: 'DeepSeek Flash（Cache-Aware）',
		family: 'deepseek',
		version: 'v4.1',
		detail: 'Flash · 图片输入（看图，不生成图片）',
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
		// ⚠️ 2026-09-10 起 Flash 系列降价（CNY）：缓存命中 0.05→0.02、未命中 1.5→1、输出 4.5→4，
		// 高峰 = 空闲 ×2。依据不是官方价格页（当天实测仍是旧价、旧模型名，页面滞后），
		// 而是官方账单反推：本账号 deepseek-flash 当日实扣 ¥60.726，
		// 按新价算 ¥60.726（偏差 0.000），按旧价算 ¥93.228（差 ¥32.5）。
		pricing: {
			USD: {
				// 官方英文价格页 2026-09-10 实测尚未更新（仍为旧价），USD 新值无官方出处，故保留原值。
				// 本账号按 CNY 计费、界面也取 CNY；USD 只在非中文环境 / 美元账户兜底，待英文页更新再同步。
				offPeak: { cacheHitInput: 0.007, cacheMissInput: 0.22, output: 0.66 },
				peak: { cacheHitInput: 0.014, cacheMissInput: 0.44, output: 1.32 },
			},
			CNY: {
				offPeak: { cacheHitInput: 0.02, cacheMissInput: 1, output: 4 },
				peak: { cacheHitInput: 0.04, cacheMissInput: 2, output: 8 },
			},
		},
		priceCategory: 'low',
	},
	{
		id: 'deepseek-v4-pro',
		name: 'DeepSeek V4 Pro（Cache-Aware）',
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
