// 用途：请求诊断只记录枚举和关联 ID，日志故障不影响请求及发送字节。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

function eventLog() {
	return require(
		path.join(
			process.env.DEEPSEEK_HOOK_DIR ?? path.join(__dirname, '../../resources/hooks'),
			'event_log.js',
		),
	);
}

/** 过程类事件：只在非 minimal 档写（B4，2026-09-19）。警告/失败类永远写。 */
const PROCESS_EVENT_CODES = new Set([
	'SESSION_PATH_NORMALIZED',
	'SESSION_PATH_DISTINCT',
	'SESSION_PATH_FOREIGN',
	'SESSION_PATH_COLLISION',
	'SESSION_PATH_INVALID_ARGUMENTS',
	'PREPARE',
	'PROVIDER_INPUT',
	'PROVIDER_INPUT_ITEMS',
	'CONVERTED',
	'CONVERTED_ITEMS',
	'FILTERED_CANDIDATE',
	'FILTERED_CANDIDATE_ITEMS',
	'WIRE_CANDIDATE',
	'SEND_ATTEMPT',
	'HTTP_ACCEPTED',
	'USAGE_OBSERVED',
	'REQUEST_CHANGESET',
]);

let diagnosticsMode = process.env.DEEPSEEK_DEBUG_MODE ?? 'unknown';

/** 由扩展激活/配置变更时同步；'unknown' 时按现状写（不改变默认行为）。 */
export function setDiagnosticsMode(mode: string): void {
	diagnosticsMode = typeof mode === 'string' && mode ? mode : 'unknown';
}

export function getDiagnosticsMode(): string {
	return diagnosticsMode;
}
export function newRequestId(): string {
	try {
		return eventLog().createRequestId();
	} catch {
		return 'r-' + randomUUID();
	}
}
function provenance(): Record<string, string> {
	const root = path.join(__dirname, '../..');
	const dir = process.env.DEEPSEEK_HOOK_DIR ?? path.join(root, 'resources/hooks');
	const result: Record<string, string> = {
		siteId: 'extension.provider',
		extensionVersion: 'unknown',
		hookHash: 'unknown',
	};
	try {
		result.extensionVersion = JSON.parse(
			fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
		).version;
	} catch {}
	try {
		result.hookHash = createHash('sha256')
			.update(fs.readFileSync(path.join(dir, 'skill_filter.js')))
			.digest('hex');
	} catch {}
	return result;
}
function safeUsage(usage?: Record<string, unknown>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const key of ['input', 'output', 'hit', 'miss']) {
		const value = usage?.[key];
		if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) out[key] = value;
	}
	return out;
}
function safeDetails(details?: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of ['wireHash', 'historyHash', 'schemaHash', 'sessionRef']) {
		const value = details?.[key];
		if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) out[key] = value;
	}
	for (const key of ['wireBytes', 'itemCount', 'offset', 'httpStatus']) {
		const value = details?.[key];
		if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) out[key] = value;
	}
	if (Array.isArray(details?.fingerprints))
		out.fingerprints = details.fingerprints
			.filter((v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
			.slice(0, 20);
	if (Array.isArray(details?.changesetSteps)) {
		out.changesetSteps = (details.changesetSteps as unknown[])
			.filter((step): step is Record<string, unknown> => !!step && typeof step === 'object')
			.slice(0, 20)
			.map(safeChangesetStep);
		const total = details?.changesetStepsTotal;
		if (typeof total === 'number' && Number.isSafeInteger(total) && total >= 0)
			out.changesetStepsTotal = Math.min(total, 1_000_000);
		const kept = details?.changesetStepsKept;
		if (typeof kept === 'number' && Number.isSafeInteger(kept) && kept >= 0)
			out.changesetStepsKept = Math.min(kept, 1_000_000);
		if (details?.changesetTrimmed === true) out.changesetTrimmed = true;
	}
	return out;
}

/** 变化清单步（平铺一层原始值——事件日志 maxDepth=3）：只放行计数/索引/摘要哈希。 */
function safeChangesetStep(step: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const name = typeof step.name === 'string' ? step.name.slice(0, 32) : '';
	if (!name || !/^[a-zA-Z0-9_.:-]{1,32}$/.test(name)) return out;
	out.name = name;
	for (const key of [
		'bItems',
		'bChars',
		'aItems',
		'aChars',
		'rmCount',
		'rmChars',
		'adCount',
		'adChars',
		'chCount',
	]) {
		const value = step[key];
		if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) out[key] = value;
	}
	for (const key of ['bDigest', 'aDigest']) {
		const value = step[key];
		if (typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)) out[key] = value;
	}
	for (const key of ['rmIdx', 'adIdx', 'chIdx']) {
		const value = step[key];
		if (typeof value === 'string' && value.length <= 96 && /^[0-9]+(,[0-9]+)*$/.test(value))
			out[key] = value;
	}
	if (
		typeof step.note === 'string' &&
		step.note &&
		/^[a-zA-Z0-9_=;.:-]{1,120}$/.test(step.note.replace(/[\r\n]+/g, ' '))
	)
		out.note = step.note.replace(/[\r\n]+/g, ' ').slice(0, 120);
	return out;
}

export function recordRequestEvent(
	requestId: string,
	eventCode: string,
	requestKind: string,
	parentRequestId?: string,
	usage?: Record<string, unknown>,
	details?: Record<string, unknown>,
): void {
	try {
		if (process.env.DEEPSEEK_HOOKS_OFF === '1') return;
		if (diagnosticsMode === 'minimal' && PROCESS_EVENT_CODES.has(eventCode)) return;
		eventLog().reportEvent({
			...provenance(),
			...safeUsage(usage),
			...safeDetails(details),
			requestId,
			parentRequestId,
			eventCode,
			requestKind,
			severity:
				eventCode === 'REQUEST_SEND_FAILED'
					? 'error'
					: eventCode === 'USAGE_UNAVAILABLE'
						? 'warning'
						: 'info',
			category: requestKind === 'summary' ? 'summary' : 'request',
			incidentKey: [requestId, eventCode, randomUUID()].join('|'),
		});
	} catch {
		/* 诊断失败不得中断聊天。 */
	}
}
export interface ErrorSummaryFilter {
	since?: string;
	requestId?: string;
	eventCode?: string;
	includeInfo?: boolean;
}
export interface ErrorSummaryResult {
	rows: Record<string, string | number>[];
	status: 'ok' | 'missing' | 'disabled' | 'partial' | 'unreadable';
	badLines: number;
	unreadableFiles: number;
	truncated: number;
}
export function readErrorSummary(filter: ErrorSummaryFilter = {}): ErrorSummaryResult {
	const since = filter.since ? Date.parse(filter.since) : 0;
	if (!Number.isFinite(since)) throw new Error('Invalid ISO timestamp');
	const result: ErrorSummaryResult = {
		rows: [],
		status: 'ok',
		badLines: 0,
		unreadableFiles: 0,
		truncated: 0,
	};
	const disabled =
		process.env.DEEPSEEK_DIAG_DISABLE === '1' || process.env.DEEPSEEK_HOOKS_OFF === '1';
	if (disabled) result.status = 'disabled';
	try {
		const dir = eventLog().diagDir();
		const names = fs
			.readdirSync(dir)
			.filter((n) => /^host-.*\.jsonl(?:\.\d+\.bak)?$/.test(n))
			.sort();
		result.truncated += Math.max(0, names.length - 64);
		let remaining = 16 * 1024 * 1024;
		for (const name of names.slice(-64)) {
			try {
				const file = path.join(dir, name);
				const st = fs.lstatSync(file);
				if (!st.isFile()) {
					result.unreadableFiles++;
					continue;
				}
				if (st.size > remaining) {
					result.truncated++;
					continue;
				}
				remaining -= st.size;
				for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
					if (!line.trim()) continue;
					try {
						const r = JSON.parse(line);
						if (!r || !Number.isFinite(Date.parse(r.timestampUtc))) {
							result.badLines++;
							continue;
						}
						if (Date.parse(r.timestampUtc) < since) continue;
						if (
							!filter.includeInfo &&
							!filter.requestId &&
							!['error', 'warning', 'warn'].includes(r.severity) &&
							!/FAIL|ERROR|UNAVAILABLE/.test(r.eventCode)
						)
							continue;
						if (
							filter.requestId &&
							r.requestId !== filter.requestId &&
							r.parentRequestId !== filter.requestId
						)
							continue;
						if (filter.eventCode && r.eventCode !== filter.eventCode) continue;
						const safe: Record<string, string | number> = {
							timestampUtc: new Date(r.timestampUtc).toISOString(),
							...safeUsage(r),
						};
						for (const key of [
							'eventCode',
							'requestId',
							'parentRequestId',
							'requestKind',
							'severity',
							'category',
							'siteId',
							'extensionVersion',
							'hookHash',
							'wireHash',
							'historyHash',
							'schemaHash',
							'sessionRef',
						]) {
							if (typeof r[key] === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(r[key]))
								safe[key] = r[key];
						}
						if (Number.isSafeInteger(r.itemCount) && r.itemCount >= 0) safe.itemCount = r.itemCount;
						result.rows.push(safe);
					} catch {
						result.badLines++;
					}
				}
			} catch {
				result.unreadableFiles++;
			}
		}
	} catch (error) {
		result.status = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable';
		if (result.status === 'unreadable') result.unreadableFiles++;
	}
	result.rows.sort((a, b) => String(b.timestampUtc).localeCompare(String(a.timestampUtc)));
	result.truncated += Math.max(0, result.rows.length - 500);
	result.rows = result.rows.slice(0, 500);
	if (result.status === 'ok' && (result.badLines || result.unreadableFiles || result.truncated))
		result.status = 'partial';
	return result;
}
