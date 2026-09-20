/**
 * 用途：把钩子五步（剪枝/补全/替换/底片柜/折叠）的变化指纹聚成一条 REQUEST_CHANGESET。
 * 只记数字、索引与摘要哈希——正文不出门、不进日志。
 * 纪律：观测失败不影响请求（全 try/catch）；开关关闭时静默（默认只在 verbose 或 DEEPSEEK_CHANGESET=1 开）。
 */
import { recordRequestEvent } from './request-events';

export interface ChangesetSidePayload {
	items?: unknown;
	chars?: unknown;
	digest?: unknown;
}

export interface ChangesetBucketPayload {
	count?: unknown;
	chars?: unknown;
	indexes?: unknown;
}

export interface ChangesetStepPayload {
	name?: unknown;
	before?: ChangesetSidePayload;
	after?: ChangesetSidePayload;
	removed?: ChangesetBucketPayload;
	added?: ChangesetBucketPayload;
	changed?: ChangesetBucketPayload;
	extra?: unknown;
	ts?: unknown;
}

export interface ChangesetCollectorOptions {
	requestId: string;
	requestKind: string;
	parentRequestId?: string;
	enabled: boolean;
}
const MAX_STEPS = 20; // 事件日志 maxArrayItems=20，超出会被切掉——按写入口径封顶
const MAX_IDX_IN_LOG = 8; // 日志里每组索引只留前 8 个（防整行超 8KB 被降级）
const MAX_NOTE = 120;

function safeCount(value: unknown): number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeDigest(value: unknown): string {
	return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : '';
}

function shortIndexes(value: unknown): string {
	if (!Array.isArray(value)) return '';
	const out: number[] = [];
	for (const item of value) {
		if (out.length >= MAX_IDX_IN_LOG) break;
		if (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0) out.push(item);
	}
	return out.join(',');
}

function sideItems(value: unknown): number {
	return safeCount((value as { items?: unknown } | undefined)?.items);
}

function sideChars(value: unknown): number {
	return safeCount((value as { chars?: unknown } | undefined)?.chars);
}

function sideDigest(value: unknown): string {
	return safeDigest((value as { digest?: unknown } | undefined)?.digest);
}

function bucketCount(value: unknown): number {
	return safeCount((value as { count?: unknown } | undefined)?.count);
}

function bucketChars(value: unknown): number {
	return safeCount((value as { chars?: unknown } | undefined)?.chars);
}

function bucketIndexes(value: unknown): string {
	return shortIndexes((value as { indexes?: unknown } | undefined)?.indexes);
}

/** 备注压成一行短串（folded=true;reason=...）：只放行枚举样式的短值（防正文混入）。 */
function shortNote(value: unknown): string {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
	const parts: string[] = [];
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (parts.length >= 4) break;
		if (!/^[a-zA-Z][a-zA-Z0-9_]{0,24}$/.test(key)) continue;
		if (typeof item === 'boolean' || typeof item === 'number') parts.push(`${key}=${item}`);
		else if (typeof item === 'string' && /^[a-zA-Z0-9_.:-]{1,40}$/.test(item)) parts.push(`${key}=${item}`);
	}
	return parts.join(';').slice(0, MAX_NOTE);
}

/** 估算一行事件大小（ASCII 为主：note 与 digest/索引都是 ASCII）。 */
function estimateBytes(steps: Record<string, unknown>[]): number {
	try {
		return JSON.stringify(steps).length;
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

/**
 * 行预算：事件日志单行 ≤8KB，超了会降级成「只剩事件码」的残行（独立审查 MINOR-1 实测）。
 * 逐级瘦身：丢 note → 丢索引 → 从尾部砍步（保前几步，最先发生的剪枝/替换最有信息量）。
 */
function budgetSteps(steps: Record<string, unknown>[]): { steps: Record<string, unknown>[]; trimmed: boolean } {
	const LIMIT = 6000; // 留 2KB 给公共字段与日志自身字段
	let current = steps;
	let trimmed = false;
	if (estimateBytes(current) > LIMIT) {
		current = current.map((step) => {
			const { note, ...rest } = step;
			void note;
			return rest;
		});
		trimmed = true;
	}
	if (estimateBytes(current) > LIMIT) {
		current = current.map((step) => {
			const { rmIdx, adIdx, chIdx, ...rest } = step;
			void rmIdx;
			void adIdx;
			void chIdx;
			return rest;
		});
	}
	while (current.length > 1 && estimateBytes(current) > LIMIT) {
		current = current.slice(0, current.length - 1);
		trimmed = true;
	}
	return { steps: current, trimmed };
}

/**
 * 平铺成一层原始值——事件日志 maxDepth=3：嵌套对象会被写成 "[omitted-depth]"（2026-09-19 实测）。
 */
function flatStep(payload: ChangesetStepPayload): Record<string, unknown> | null {
	const name = typeof payload?.name === 'string' ? payload.name.slice(0, 32) : '';
	if (!name || !/^[a-zA-Z0-9_.:-]{1,32}$/.test(name)) return null;
	const step: Record<string, unknown> = {
		name,
		bItems: sideItems(payload.before),
		bChars: sideChars(payload.before),
		aItems: sideItems(payload.after),
		aChars: sideChars(payload.after),
		rmCount: bucketCount(payload.removed),
		rmChars: bucketChars(payload.removed),
		adCount: bucketCount(payload.added),
		adChars: bucketChars(payload.added),
		chCount: bucketCount(payload.changed),
	};
	const bDigest = sideDigest(payload.before);
	const aDigest = sideDigest(payload.after);
	if (bDigest) step.bDigest = bDigest;
	if (aDigest) step.aDigest = aDigest;
	const rmIdx = bucketIndexes(payload.removed);
	const adIdx = bucketIndexes(payload.added);
	const chIdx = bucketIndexes(payload.changed);
	if (rmIdx) step.rmIdx = rmIdx;
	if (adIdx) step.adIdx = adIdx;
	if (chIdx) step.chIdx = chIdx;
	const note = shortNote(payload.extra);
	if (note) step.note = note;
	return step;
}

export function createChangesetCollector(options: ChangesetCollectorOptions) {
	const steps: Record<string, unknown>[] = [];
	let attempts = 0;
	const trace = (code: string): void => {
		try {
			recordRequestEvent(options.requestId, code, options.requestKind, options.parentRequestId);
		} catch {
			/* 留痕自身不得影响请求。 */
		}
	};
	const reportStep = (payload: unknown): void => {
		try {
			attempts += 1;
			if (!options.enabled || steps.length >= MAX_STEPS) return;
			const step = flatStep((payload ?? {}) as ChangesetStepPayload);
			if (step) steps.push(step);
		} catch {
			trace('REQUEST_CHANGESET_FAILED');
		}
	};
	const finish = (): void => {
		try {
			if (!options.enabled || steps.length === 0) return;
			const { steps: kept, trimmed } = budgetSteps(steps);
			recordRequestEvent(
				options.requestId,
				'REQUEST_CHANGESET',
				options.requestKind,
				options.parentRequestId,
				undefined,
				{
					changesetSteps: kept,
					changesetStepsTotal: attempts,
					changesetStepsKept: kept.length,
					changesetTrimmed: trimmed || kept.length < attempts,
				},
			);
		} catch {
			trace('REQUEST_CHANGESET_FAILED');
		}
	};
	return { reportStep, finish, size: () => steps.length };
}
