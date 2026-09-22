// 用途：出站会话路径统一，并为当前请求的工具参数恢复真实路径。
import type { DeepSeekMessage } from '../types';

const PATH =
	/(?<![\w-])(debug-logs|chat-session-resources)([/\\])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[/\\\s"'`<>?#)\]])/g;
const RESERVED = '__copilot_session_';
const ALIAS =
	/(?<![\w-])(?:debug-logs|chat-session-resources)[/\\]__copilot_session_\d+(?:_alt\d+)?__(?=$|[/\\\s"'`<>?#)\]])/g;

// 只登记完整名字；保护字段也会被模型引用，因此只读扫描、不改内容。
function collectAliases(value: unknown, occupied: Set<string>): void {
	if (typeof value === 'string') {
		for (const match of value.matchAll(ALIAS)) occupied.add(match[0]);
	} else if (Array.isArray(value)) {
		for (const item of value) collectAliases(item, occupied);
	} else if (value && typeof value === 'object') {
		for (const [key, item] of Object.entries(value)) {
			collectAliases(key, occupied);
			collectAliases(item, occupied);
		}
	}
}

function mapValues(value: unknown, transform: (text: string) => string): unknown {
	if (typeof value === 'string') return transform(value);
	if (Array.isArray(value)) return value.map((item) => mapValues(item, transform));
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, mapValues(item, transform)]),
		);
	return value;
}

function mapArguments(args: string, transform: (text: string) => string): string {
	try {
		const original: unknown = JSON.parse(args);
		const result = mapValues(original, transform);
		return JSON.stringify(original) === JSON.stringify(result) ? args : JSON.stringify(result);
	} catch {
		return args;
	}
}

export function normalizeSessionPaths(messages: DeepSeekMessage[]): {
	messages: DeepSeekMessage[];
	restoreArguments: (args: string) => string;
	restoreText: (text: string) => string;
	stats: {
		normalizedPaths: number;
		distinctPaths: number;
		foreignAliases: number;
		collisionPaths: number;
		invalidToolArguments: number;
	};
} {
	// 外来名字仅用于还原歧义检查，不能反过来改变已发历史的命名。
	const occupied = new Set<string>();
	collectAliases(messages, occupied);
	let invalidToolArguments = 0;
	for (const message of messages) {
		for (const call of message.tool_calls ?? []) {
			try {
				collectAliases(JSON.parse(call.function.arguments), occupied);
			} catch {
				invalidToolArguments++;
			}
		}
	}
	const stats = {
		normalizedPaths: 0,
		distinctPaths: 0,
		foreignAliases: occupied.size,
		collisionPaths: 0,
		invalidToolArguments,
	};
	const forward = new Map<string, string>();
	const reverse = new Map<string, string>();
	const counts = new Map<string, number>();
	const normalize = (text: string): string =>
		text.replace(PATH, (path, kind: string, separator: string) => {
			stats.normalizedPaths++;
			let alias = forward.get(path);
			if (!alias) {
				const count = (counts.get(kind) ?? 0) + 1;
				counts.set(kind, count);
				const base = `${kind}${separator}${RESERVED}${count}`;
				alias = `${base}__`;
				if (occupied.has(alias)) stats.collisionPaths++;
				stats.distinctPaths++;
				forward.set(path, alias);
				reverse.set(alias, path);
			}
			return alias;
		});
	const normalized = messages.map((message) => ({
		...message,
		content:
			typeof message.content === 'string'
				? normalize(message.content)
				: message.content.map((part) =>
						part.type === 'text' ? { ...part, text: normalize(part.text) } : part,
					),
		...(message.reasoning_content !== undefined
			? { reasoning_content: normalize(message.reasoning_content) }
			: {}),
		...(message.tool_calls
			? {
					tool_calls: message.tool_calls.map((call) => ({
						...call,
						function: {
							...call.function,
							arguments: mapArguments(call.function.arguments, normalize),
						},
					})),
				}
			: {}),
	}));
	const restore = (text: string): string =>
		text.replace(ALIAS, (alias) => (occupied.has(alias) ? alias : (reverse.get(alias) ?? alias)));
	return {
		messages: normalized,
		stats,
		restoreArguments: (args) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(args);
			} catch {
				return args;
			}
			const aliases = new Set<string>();
			collectAliases(parsed, aliases);
			if ([...aliases].some((alias) => occupied.has(alias) && reverse.has(alias))) {
				throw Object.assign(
					new Error(
						'SESSION_PATH_AMBIGUOUS: 工具参数中的会话路径与历史引用同名，无法确定真实目标；请使用明确的真实路径。',
					),
					{ code: 'SESSION_PATH_AMBIGUOUS' },
				);
			}
			return mapArguments(args, restore);
		},
		restoreText: restore,
	};
}

// 保留短尾巴，避免路径被流式分片切开；完成或中断时都交还已收到的文字。
export function createSessionTextStream(
	restore: (text: string) => string,
	emit: (text: string) => void,
) {
	let pending = '';
	const send = (text: string) => {
		if (text) emit(restore(text));
	};
	return {
		push(text: string) {
			pending += text;
			let cut = Math.max(0, pending.length - 128);
			for (const prefix of ['debug-logs', 'chat-session-resources']) {
				const start = pending.lastIndexOf(prefix, cut);
				if (start >= 0 && start + 128 >= cut) cut = Math.max(0, start - 1);
			}
			send(pending.slice(0, cut));
			pending = pending.slice(cut);
		},
		flush() {
			const text = pending;
			pending = '';
			send(text);
		},
	};
}
