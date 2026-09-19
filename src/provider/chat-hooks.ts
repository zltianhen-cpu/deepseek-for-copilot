/**
 * 消息管线钩子（技能块筛选 + 上下文体检）。
 *
 * 调用点内建在 `request.ts`（请求发出前）与 `stream.ts`（用量回报时），
 * 逻辑本身外置成可替换模块，见下方「可替换单元」。
 *
 * 本文件随扩展包分发，因此**不允许**出现：具体项目的技能名、本机特定目录、绝对家目录路径。
 * 本机特有的名单（必留技能、系统指令特征词）一律放 <本机数据目录> 下的配置文件。
 *
 * ────────────────────────────────────────────────────────────────
 * 三道设计约束：
 *
 * 1. **永不抛错** —— 任何钩子失败都必须被吞掉。宁可让技能列表臃肿，
 *    也绝不能弄坏用户的每一轮对话。
 *
 * 2. **不打补丁** —— 逻辑外置在可替换模块里，换算法 = 换文件，
 *    不需要在构建时替换源码，也没有「构建中断导致残留」这一类事故。
 *
 * 3. **不带数据** —— 包内只有算法；技能清单在本机现场生成（首次自动建），
 *    所以「包干净」不靠人工记得排除哪些文件，而是结构上就没什么可排除的。
 *
 * ────────────────────────────────────────────────────────────────
 * 可替换单元（换算法不用动本文件）：
 *   `skill_filter.js`     → `filterOpenAIMessages(messages)`
 *   `context_monitor.js`  → `logComposition()` / `logUsage()`
 * 模块目录解析顺序：
 *   ① 环境变量 `DEEPSEEK_HOOK_DIR`（开发者旁路：指向正在迭代的目录，改完即时生效）
 *   ② 包内 `resources/hooks/`（随包分发的快照）
 * 单项替换：`DEEPSEEK_FILTER_FILE` / `DEEPSEEK_MONITOR_FILE` 可各指定一个文件名。
 */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import vscode from 'vscode';
import { logger } from '../logger';
import type { DeepSeekMessage } from '../types';
import { countMessageChars } from './convert';

// ---- 路径解析（包内相对定位，不写任何绝对路径）----

/** 编译产物在 <扩展根>/out/provider/，上跳两级即扩展根。 */
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const EXTENSION_VERSION: string = (() => {
	try {
		return JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, 'package.json'), 'utf8')).version;
	} catch {
		return 'unknown';
	}
})();
const BUNDLED_HOOK_DIR = path.join(EXTENSION_ROOT, 'resources', 'hooks');

const HOOK_SCRIPT_DIR = process.env.DEEPSEEK_HOOK_DIR ?? BUNDLED_HOOK_DIR;
const FILTER_FILE = process.env.DEEPSEEK_FILTER_FILE ?? 'skill_filter.js';
const MONITOR_FILE = process.env.DEEPSEEK_MONITOR_FILE ?? 'context_monitor.js';

/** 总开关：设 `DEEPSEEK_HOOKS_OFF=1` 可临时全关。 */
const HOOKS_ENABLED = process.env.DEEPSEEK_HOOKS_OFF !== '1';
/** 自动建索引（首次即用即建）。设 `DEEPSEEK_AUTOBUILD_OFF=1` 可关。 */
const AUTOBUILD_ENABLED = process.env.DEEPSEEK_AUTOBUILD_OFF !== '1';

/** 被视作「真实用户轮次」的 requestKind（用于探针过滤掉内部预检请求）。 */
export const REAL_TURN_KIND = 'main-agent';

// ---- 外置模块的类型契约 ----

/** 出门前折叠用的会话钥匙。空串 = 钩子退回 fp:首条 user。 */
export interface MessageFilterContext {
	requestId?: string;
	workspaceId?: string;
	runtime?: { extensionVersion: string };
	/** 来自 convert 阶段的来源侧车厢数据，用于区分 user-host 与 unproven。 */
	sourceSidecar?: unknown;
	sessionKey?: string;
	storePath?: string;
	segment?: { reason?: string; segmentId?: string };
	model?: string;
	summarize?: (
		foldMsgs: unknown[],
		extra?: { prefixMessages?: unknown[]; tools?: unknown; protectedPrefixCount?: number },
	) => string | Promise<string>;
	tools?: unknown;
	/** convert 之前的宿主口径字符数（实发比的分母；缺省退回「转换后」的本地量）。 */
	hostMessageChars?: number;
	fitsBudget?: (messages: unknown[]) => boolean;
	protectedPrefixCount?: number;
}

interface FilterModule {
	filterOpenAIMessages?: (messages: unknown[], opts?: MessageFilterContext) => unknown;
}

interface MonitorModule {
	logComposition?: (messages: unknown[], extra?: unknown) => unknown;
	logUsage?: (record: Record<string, unknown>) => unknown;
}

/** 传给探针的单轮用量记录（字段名与 `context_monitor.logUsage` 对齐）。 */
export interface UsageRecord {
	prompt: number;
	cacheHit: number;
	/** 官方响应里可缺省；探针侧会用 prompt - cacheHit 兜底。 */
	cacheMiss: number | undefined;
	completion: number;
	/** 推理 token：DeepSeek 运行时会返回，但官方类型定义里未声明。 */
	reasoning: number | undefined;
	kind: string;
	isRealTurn: boolean;
	charsPerToken: number;
	model: string;
}

let skillFilter: FilterModule | null = null;
let contextMonitor: MonitorModule | null = null;
let autoBuildScheduled = false;
let lastBuildAt = 0;
/** 两次全量重建之间的最小间隔（毫秒）——避免每轮都去 stat 上百个目录。 */
const REBUILD_INTERVAL_MS = 10 * 60 * 1000;

function load<T>(file: string): T | null {
	try {
		return require(path.join(HOOK_SCRIPT_DIR, file)) as T;
	} catch {
		// 目录不存在 / 脚本报错 / 权限问题 —— 静默降级，下轮自动重试
		return null;
	}
}

function getFilterModule(): FilterModule | null {
	if (!skillFilter) {
		skillFilter = load<FilterModule>(FILTER_FILE);
	}
	return skillFilter;
}

function getMonitorModule(): MonitorModule | null {
	if (!contextMonitor) {
		contextMonitor = load<MonitorModule>(MONITOR_FILE);
	}
	return contextMonitor;
}

// ---- 首次自动初始化：本机技能清单 ----

function workspaceRoots(): string[] {
	try {
		return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
	} catch {
		return [];
	}
}

/**
 * 在本机现场生成技能清单（并做「技能目录变了就重建」的自愈）。
 *
 * ⛔ 刻意放在后台执行、绝不阻塞当前这一轮请求：
 *    首次装上时清单还不存在，这一轮就按「筛不动」原样放行，下一轮开始生效。
 */
function ensureLocalIndex(): void {
	try {
		if (lastBuildAt && Date.now() - lastBuildAt < REBUILD_INTERVAL_MS) return;
		lastBuildAt = Date.now();
		const builder = load<{
			resolveIndexPath: () => string;
			build: (opts: unknown) => unknown;
			writeIndex: (payload: unknown, outPath: string) => string;
			needsRebuild: (current: unknown, next: unknown) => boolean;
		}>('build_index.js');
		if (!builder) return;
		const outPath = builder.resolveIndexPath();
		const next = builder.build({ workspaceRoots: workspaceRoots() });
		let current: unknown = null;
		try {
			current = JSON.parse(fs.readFileSync(outPath, 'utf8'));
		} catch {
			/* 首次运行：没有旧清单，直接建 */
		}
		if (builder.needsRebuild(current, next)) {
			builder.writeIndex(next, outPath);
		}
	} catch {
		/* hook: never break chat */
	}
}

function scheduleAutoBuild(): void {
	if (!AUTOBUILD_ENABLED || autoBuildScheduled) return;
	autoBuildScheduled = true;
	// 放到事件循环下一拍：不占用当前这一轮请求的时间
	setTimeout(ensureLocalIndex, 0);
}

// ---- 暴露给调用点的三个钩子 ----

/**
 * 技能块筛选：按当前用户问题把全量技能块筛成 Top-K + 全部总入口 hub + 本机必留。
 * 插入位置：`convertMessages()` 之后、请求真正发出之前。
 */
function foldSessionKey(ctx?: MessageFilterContext): string {
	if (ctx?.sessionKey) {
		return ctx.sessionKey;
	}
	const model = ctx?.model ?? '';
	const seg = ctx?.segment;
	if (seg?.reason === 'markerFound' && seg.segmentId) {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
		return `${workspaceRoot}|${seg.segmentId}|${model}`;
	}
	return '';
}

/** 真实工作区 URI 的稳定标识；未知保持空，不替代会话 ID。 */
export function workspaceIdentity(): string {
	try {
		const roots = (vscode.workspace.workspaceFolders ?? [])
			.map((folder) => folder.uri.toString())
			.filter(Boolean)
			.sort();
		return roots.length ? createHash('sha256').update(JSON.stringify(roots)).digest('hex') : '';
	} catch {
		return '';
	}
}
/** 实发比的最小样本量（字符）：太小会引入取整噪声，不值一算。 */
const MIN_RATIO_SAMPLE_CHARS = 2000;

/** 量「出门前/后」的总字符数；任何异常都不影响筛选（只是不发布比值）。 */
function safeCountMessageChars(messages: unknown[]): number {
	try {
		return countMessageChars(messages as DeepSeekMessage[]);
	} catch {
		return 0;
	}
}

export async function applyMessageFilter(
	messages: unknown[],
	ctx?: MessageFilterContext,
): Promise<void> {
	if (!HOOKS_ENABLED) {
		return;
	}
	scheduleAutoBuild();
	try {
		const beforeChars = safeCountMessageChars(messages);
		const beforeCount = messages.length;
		const sessionKey = foldSessionKey(ctx);
		const out = getFilterModule()?.filterOpenAIMessages?.(messages, {
			sessionKey,
			requestId: ctx?.requestId,
			workspaceId: ctx?.workspaceId ?? workspaceIdentity(),
			runtime: { extensionVersion: EXTENSION_VERSION },
			storePath: ctx?.storePath,
			summarize: ctx?.summarize,
			fitsBudget: ctx?.fitsBudget,
			protectedPrefixCount: ctx?.protectedPrefixCount,
			tools: ctx?.tools,
			sourceSidecar: ctx?.sourceSidecar,
		});
		if (out && typeof (out as Promise<unknown>).then === 'function') {
			await out;
		}

		// 只观察前后体积；不向无会话身份的宿主计数发布折扣。
		// 宿主数的是未折叠的原文，折叠/筛选省下的量它看不见 → 它会在原文很大时就
		// 提前压缩；报出真实比值后，它的尺子量到的就 ≈ 我们真正发出去的。
		// 分母优先用「转换前的宿主口径」（hostMessageChars，request.ts 传入）——
		// 它含 convert 阶段丢掉的那一刀（思考块/标记等），r ≈ 实发 ÷ 宿主原始量；
		// 缺省（未传 / 样本太小）退回「转换后」的本地量（与旧口径一致）。
		const afterChars = safeCountMessageChars(messages);
		const hostChars = ctx?.hostMessageChars ?? 0;
		const baseChars = hostChars >= MIN_RATIO_SAMPLE_CHARS ? hostChars : beforeChars;
		if (baseChars >= MIN_RATIO_SAMPLE_CHARS && afterChars > 0) {
			const ratio = afterChars / baseChars;
			logger.info(
				'[fold-ratio]',
				`host=${hostChars} conv=${beforeChars} out=${afterChars} r=${ratio.toFixed(3)} msgs=${beforeCount}->${messages.length}`,
			);
		}
	} catch {
		// 钩子异常 → 比值清零，退回「技能目录折减」口径（宁可多算，不冒撞上限的险）
		/* HOOK: never break chat */
	}
}

/**
 * 上下文组成探针（只读）：记录筛选后真正发出去的组成与真实 token。
 * 插入位置：紧跟在 `applyMessageFilter()` 之后。
 * tools 一并交给探针：工具 schema 同属 provider 前缀，schema 漂移会静默打断缓存，
 * 探针据此算 ToolsHash 并在变化时点名（对齐 Reasonix cache_shape.go 的 ToolsHash）。
 */
export function logMessageComposition(messages: unknown[], tools?: unknown): void {
	if (!HOOKS_ENABLED) {
		return;
	}
	try {
		// ⛔ 不给 tools 时不能传「值为 undefined 的 tools 键」——探针用 'tools' in opts
		//    区分「调用方没采集」和「本轮真的没有工具」，带 undefined 键会把两者混成
		//    后者（空集哈希），排查时会误判成「工具全没了」。
		const opts: { vscode: unknown; tools?: unknown } = { vscode };
		if (tools !== undefined) {
			opts.tools = tools;
		}
		getMonitorModule()?.logComposition?.(messages, opts);
	} catch {
		/* CTX-MON: never break chat */
	}
}

/**
 * 真实 token 探针（只读）：记录官方口径的 prompt / 缓存命中 / 输出 / 推理 token。
 * 插入位置：`onUsage` 回调里，紧挨原有用量上报。
 */
export function logUsage(record: UsageRecord): void {
	if (!HOOKS_ENABLED) {
		return;
	}
	try {
		getMonitorModule()?.logUsage?.({ ...record });
	} catch {
		/* CTX-MON: never break chat */
	}
}

/** 供排障用：当前实际生效的钩子目录与开关状态（不涉及任何私有信息）。 */
export function hookStatus(): Record<string, unknown> {
	return {
		hookDir: HOOK_SCRIPT_DIR,
		bundledDir: BUNDLED_HOOK_DIR,
		usedEnvDir: Boolean(process.env.DEEPSEEK_HOOK_DIR),
		filterFile: FILTER_FILE,
		monitorFile: MONITOR_FILE,
		hooksEnabled: HOOKS_ENABLED,
		autoBuild: AUTOBUILD_ENABLED,
	};
}
