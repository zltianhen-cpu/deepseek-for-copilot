// 用途：宿主摘要借用经过完整历史认证的请求快照；只驻留内存，不改主聊天状态。
import { createHash } from 'node:crypto';
import type { DeepSeekMessage } from '../../types';

const digest = (value: unknown): string =>
	createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function buildReplayScope(
	options: { requestInitiator?: unknown; modelOptions?: unknown },
	workspace: string,
	modelShape: string,
	endpoint: string,
	apiKey: string,
): string | undefined {
	const id = (options.modelOptions as { _conversationId?: unknown } | undefined)?._conversationId;
	if (
		options.requestInitiator !== 'github.copilot-chat' ||
		typeof id !== 'string' ||
		!/^[\w.:-]{1,256}$/.test(id) ||
		!workspace
	)
		return undefined;
	return digest([workspace, id, modelShape, endpoint, digest(apiKey)]);
}

interface Entry {
	scope: string;
	created: number;
	bytes: number;
	shapes: string[];
	reasoning: Array<string | undefined>;
	output?: DeepSeekMessage[];
}
interface CacheOptions {
	maxBytes?: number;
	maxEntries?: number;
	ttlMs?: number;
	waitMs?: number;
	now?: () => number;
}
interface Cancellation {
	isCancellationRequested: boolean;
	onCancellationRequested?: (fn: () => void) => { dispose(): void };
}
type ReplayStatus = 'restored' | 'unavailable' | 'conflict' | 'pending' | 'cancelled';
export interface SummaryReplayResult {
	status: ReplayStatus;
	messages?: DeepSeekMessage[];
	restored: number;
}

function shape(message: DeepSeekMessage): string {
	const { reasoning_content: _reasoning, ...rest } = message;
	return digest(rest);
}

export class HostSummaryReplayCache {
	private readonly entries = new Set<Entry>();
	private readonly listeners = new Set<() => void>();
	private readonly config: Required<CacheOptions>;

	constructor(options: CacheOptions = {}) {
		this.config = {
			maxBytes: 48 * 1024 * 1024,
			maxEntries: 32,
			ttlMs: 30 * 60 * 1000,
			waitMs: 5000,
			now: Date.now,
			...options,
		};
	}

	begin(scope: string | undefined, messages: readonly DeepSeekMessage[]): Entry | undefined {
		if (!scope || !messages.some((message) => message.role === 'assistant')) return undefined;
		const shapes = messages.map(shape);
		const reasoning = messages.map((message) => message.reasoning_content);
		const entry = {
			scope,
			shapes,
			reasoning,
			created: this.config.now(),
			bytes: Buffer.byteLength(JSON.stringify([shapes, reasoning])),
		};
		this.entries.add(entry);
		// 每个对话只留最近四份，防止一个长聊天挤掉所有其它对话。
		const same = [...this.entries].filter((item) => item.scope === scope);
		for (const old of same.slice(0, Math.max(0, same.length - 4))) this.remove(old);
		this.trim();
		this.changed();
		return this.entries.has(entry) ? entry : undefined;
	}

	complete(entry: Entry | undefined, messages: readonly DeepSeekMessage[]): void {
		if (!entry || !this.entries.has(entry) || entry.output) return;
		entry.output = copy([...messages]);
		entry.bytes += Buffer.byteLength(JSON.stringify(entry.output));
		this.trim();
		this.changed();
	}

	fail(entry: Entry | undefined): void {
		if (entry) this.remove(entry);
	}

	async recover(
		scope: string | undefined,
		messages: readonly DeepSeekMessage[],
		token?: Cancellation,
	): Promise<SummaryReplayResult> {
		const no = (status: ReplayStatus): SummaryReplayResult => ({ status, restored: 0 });
		if (!scope || messages.length < 2 || messages.at(-1)?.role !== 'user') return no('unavailable');
		const history = messages.slice(0, -1);
		const shapes = history.map(shape);
		const deadline = Date.now() + this.config.waitMs;
		for (;;) {
			if (token?.isCancellationRequested) return no('cancelled');
			this.trim();
			const candidates = [...this.entries].filter(
				(entry) =>
					entry.scope === scope &&
					entry.shapes.length === shapes.length &&
					entry.shapes.every((hash, i) => hash === shapes[i]),
			);
			if (new Set(candidates.map((entry) => digest(entry.reasoning))).size > 1)
				return no('conflict');
			const entry = candidates.at(-1);
			if (entry) {
				if (
					history.some(
						(message, i) =>
							message.reasoning_content && message.reasoning_content !== entry.reasoning[i],
					)
				)
					return no('conflict');
				if (entry.output)
					return {
						status: 'restored',
						restored: history.filter(
							(message, i) => !message.reasoning_content && entry.reasoning[i],
						).length,
						messages: [...copy(entry.output), copy(messages.at(-1)!)],
					};
			}
			if (Date.now() >= deadline) return no(entry ? 'pending' : 'unavailable');
			// 摘要和正常请求可任意先后到达；只等前处理，绝不等模型生成回复。
			await this.waitForChange(deadline - Date.now(), token);
		}
	}

	private changed(): void {
		for (const notify of this.listeners) notify();
	}
	private waitForChange(ms: number, token?: Cancellation): Promise<void> {
		return new Promise((resolve) => {
			let subscription: { dispose(): void } | undefined;
			const done = () => {
				clearTimeout(timer);
				this.listeners.delete(done);
				subscription?.dispose();
				resolve();
			};
			const timer = setTimeout(done, Math.max(0, ms));
			this.listeners.add(done);
			subscription = token?.onCancellationRequested?.(done);
			if (token?.isCancellationRequested) done();
		});
	}

	private remove(entry: Entry): void {
		this.entries.delete(entry);
		this.changed();
	}
	private trim(): void {
		for (const entry of this.entries)
			if (this.config.now() - entry.created >= this.config.ttlMs) this.remove(entry);
		let bytes = [...this.entries].reduce((total, entry) => total + entry.bytes, 0);
		for (const entry of this.entries) {
			if (bytes <= this.config.maxBytes && this.entries.size <= this.config.maxEntries) break;
			bytes -= entry.bytes;
			this.remove(entry);
		}
	}
}

export const hostSummaryReplay = new HostSummaryReplayCache();
