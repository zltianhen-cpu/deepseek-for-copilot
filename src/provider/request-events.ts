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
export function recordRequestEvent(
	requestId: string,
	eventCode: string,
	requestKind: string,
	parentRequestId?: string,
	usage?: Record<string, unknown>,
): void {
	try {
		if (process.env.DEEPSEEK_HOOKS_OFF === '1') return;
		eventLog().reportEvent({
			...provenance(),
			...safeUsage(usage),
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
						]) {
							if (typeof r[key] === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(r[key]))
								safe[key] = r[key];
						}
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
