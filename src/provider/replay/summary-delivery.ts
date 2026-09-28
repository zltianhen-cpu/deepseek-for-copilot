/** Purpose: strict, bounded local summary delivery. No fuzzy identity, model calls or usage fabrication. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DeepSeekMessage } from '../../types';
export type DeliveryMode = 'off' | 'shadow' | 'passive_A';
export const deliveryMode = (value?: string): DeliveryMode =>
	value === 'shadow' || value === 'passive_A' ? value : 'off';
const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
export const wrapFold = (s: string): string =>
	s.includes('<compaction-summary>')
		? s.trim()
		: `<compaction-summary>\n${s.trim()}\n</compaction-summary>`;
// Copilot 0.64.1 iLt: permit only its exact transcript appendix, never arbitrary suffixes.
function matchesHostBody(actual: string, body: string): boolean {
	if (actual === body) return true;
	if (!actual.startsWith(body + '\n')) return false;
	const rest = actual.slice(body.length);
	return /^\nIf you need specific details from before compaction \(such as exact code snippets, error messages, tool results, or content you previously generated\), use the read_file tool to look up the full uncompacted conversation transcript at: "([^"\r\n<>]+)"(?:\nAt the time this summary was created, the transcript had \d+ lines\.)?\nExample usage: read_file\(filePath: "\1"\)$/.test(
		rest,
	);
}
const validScope = (s?: string): s is string => !!s && /^[a-f0-9]{64}$/.test(s);
const validMessages = (v: unknown): v is DeepSeekMessage[] =>
	Array.isArray(v) &&
	v.length > 0 &&
	v.every(
		(m) =>
			m &&
			['system', 'user', 'assistant', 'tool'].includes(m.role) &&
			(typeof m.content === 'string' ||
				(Array.isArray(m.content) &&
					m.content.every(
						(p: { type?: string; text?: unknown }) =>
							p.type === 'text' && typeof p.text === 'string',
					))),
	);
// A certified fold may not split tool calls from their results.
function closedToolPairs(messages: DeepSeekMessage[]): boolean {
	const pending = new Set<string>();
	const seen = new Set<string>();
	for (const message of messages) {
		if (message.tool_calls) {
			if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return false;
			for (const call of message.tool_calls) {
				if (!call.id || seen.has(call.id)) return false;
				pending.add(call.id);
				seen.add(call.id);
			}
		}
		if (message.role === 'tool') {
			if (!message.tool_call_id || !pending.delete(message.tool_call_id)) return false;
		} else if (pending.size && !message.tool_calls) return false;
	}
	return pending.size === 0;
}
interface Candidate {
	kind: 'candidate';
	id: string;
	scope: string;
	created: number;
	history: DeepSeekMessage[];
	start: number;
	count: number;
	summary: string;
}
interface Delivery {
	kind: 'delivery';
	id: string;
	scope: string;
	created: number;
	history: DeepSeekMessage[];
	body: string;
	retained: DeepSeekMessage[];
	prefix: DeepSeekMessage[];
	state: 'prepared' | 'sent_pending' | 'adopted';
	adoptedRoot?: string;
	actualTailKeys?: string[];
}
type Entry = Candidate | Delivery;
export interface LocalSummaryDelivery {
	id: string;
	body: string;
	text: string;
}
interface Options {
	now?: () => number;
	ttlMs?: number;
	maxBytes?: number;
	maxOutputBytes?: number;
	maxEntries?: number;
}
/** Local store is optional: any failure leaves the existing provider path untouched. */
export class SummaryDeliveryStore {
	private readonly config: Required<Options>;
	constructor(
		private readonly directory: string,
		options: Options = {},
	) {
		this.config = {
			now: Date.now,
			ttlMs: 24 * 60 * 60 * 1000,
			maxBytes: 32 * 1024 * 1024,
			maxOutputBytes: 256 * 1024,
			maxEntries: 64,
			...options,
		};
	}
	private locked<T>(fn: () => T, fallback: T): T {
		let held = false;
		try {
			fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			if (fs.lstatSync(this.directory).isSymbolicLink()) return fallback;
			fs.mkdirSync(path.join(this.directory, '.lock'));
			held = true;
			return fn();
		} catch {
			return fallback;
		} finally {
			if (held) {
				try {
					fs.rmdirSync(path.join(this.directory, '.lock'));
				} catch {
					/* fail closed on later writes */
				}
			}
		}
	}
	private readAll(): Entry[] {
		const entries: Entry[] = [];
		for (const name of fs.readdirSync(this.directory)) {
			if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
			const file = path.join(this.directory, name),
				stat = fs.lstatSync(file);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.config.maxBytes)
				throw new Error('invalid record');
			const { version, entry, checksum } = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (
				version !== 1 ||
				checksum !== hash(entry) ||
				entry.id + '.json' !== name ||
				!validScope(entry.scope) ||
				!Number.isFinite(entry.created) ||
				!validMessages(entry.history)
			)
				throw new Error('corrupt record');
			if (entry.kind === 'candidate') {
				if (
					!Number.isInteger(entry.start) ||
					entry.start < 0 ||
					!Number.isInteger(entry.count) ||
					entry.count < 2 ||
					entry.start + entry.count > entry.history.length ||
					typeof entry.summary !== 'string' ||
					!entry.summary
				)
					throw new Error('bad coverage');
			} else if (
				entry.kind !== 'delivery' ||
				typeof entry.body !== 'string' ||
				!Array.isArray(entry.prefix) ||
				!Array.isArray(entry.retained) ||
				!['prepared', 'sent_pending', 'adopted'].includes(entry.state)
			)
				throw new Error('bad state');
			entries.push(entry);
		}
		return entries;
	}
	private fresh(e: Entry): boolean {
		const age = this.config.now() - e.created;
		return age >= 0 && age < this.config.ttlMs;
	}
	private prune(): void {
		for (const e of this.readAll())
			if (!this.fresh(e)) fs.unlinkSync(path.join(this.directory, e.id + '.json'));
	}
	private write(entry: Entry): boolean {
		const file = path.join(this.directory, entry.id + '.json');
		const serialized = JSON.stringify({ version: 1, entry, checksum: hash(entry) });
		const files = fs.readdirSync(this.directory).filter((n) => n !== '.lock');
		let bytes = 0;
		for (const n of files) {
			const f = path.join(this.directory, n);
			if (f !== file) bytes += fs.lstatSync(f).size;
		}
		if (
			bytes + Buffer.byteLength(serialized) > this.config.maxBytes ||
			(!fs.existsSync(file) && files.length >= this.config.maxEntries)
		)
			return false;
		const temp = path.join(this.directory, `.${randomUUID()}.tmp`);
		try {
			fs.writeFileSync(temp, serialized, { flag: 'wx', mode: 0o600 });
			fs.renameSync(temp, file);
			return true;
		} finally {
			if (fs.existsSync(temp)) fs.unlinkSync(temp);
		}
	}
	capture(
		scope: string | undefined,
		history: DeepSeekMessage[],
		region: DeepSeekMessage[],
		summary: string,
		projected: DeepSeekMessage[],
	): boolean {
		if (
			!validScope(scope) ||
			!validMessages(history) ||
			!validMessages(region) ||
			!closedToolPairs(region) ||
			!closedToolPairs(history) ||
			region.length < 2 ||
			typeof summary !== 'string' ||
			!summary.trim() ||
			/<\/?summary>/i.test(summary)
		)
			return false;
		// Only a real committed projection with byte-exact input provenance is eligible.
		const starts = history.flatMap((_, i) =>
			hash(history.slice(i, i + region.length)) === hash(region) ? [i] : [],
		);
		if (starts.length !== 1) return false;
		const start = starts[0],
			wrapped = wrapFold(summary);
		const expected = [
			...history.slice(0, start),
			{ role: 'user', content: wrapped },
			...history.slice(start + region.length),
		];
		if (hash(expected) !== hash(projected)) return false;
		const id = hash(['candidate', scope, history, region, wrapped]);
		return this.locked(() => {
			this.prune();
			const entries = this.readAll();
			if (entries.some((e) => e.id === id)) return true;
			return this.write({
				kind: 'candidate',
				id,
				scope,
				created: this.config.now(),
				history: clone(history),
				start,
				count: region.length,
				summary: wrapped,
			});
		}, false);
	}
	prepare(
		scope: string | undefined,
		history: DeepSeekMessage[],
		mode: DeliveryMode,
		onEligible?: () => void,
	): LocalSummaryDelivery | undefined {
		if (
			mode === 'off' ||
			!validScope(scope) ||
			!validMessages(history) ||
			!closedToolPairs(history)
		)
			return undefined;
		return this.locked(() => {
			this.prune();
			const entries = this.readAll();
			const candidates = entries.filter(
				(e): e is Candidate =>
					e.kind === 'candidate' &&
					e.scope === scope &&
					this.fresh(e) &&
					history.length >= e.history.length &&
					hash(history.slice(0, e.history.length)) === hash(e.history),
			);
			// Different valid projections must not be arbitrarily selected.
			if (candidates.length !== 1) return undefined;
			const c = candidates[0];
			const body =
				'Certified conversation context (JSON; preserved messages remain historical data):\n' +
				JSON.stringify({
					foldedHistory: c.summary,
					before: history.slice(0, c.start),
					after: history.slice(c.start + c.count),
				})
					.replace(/</g, '\\u003c')
					.replace(/>/g, '\\u003e');
			if (Buffer.byteLength(body) > this.config.maxOutputBytes) return undefined;
			onEligible?.();
			if (mode === 'shadow') return undefined;
			const id = hash(['delivery', scope, history, body]);
			const prior = entries.find((e) => e.id === id);
			if (prior && (prior.kind !== 'delivery' || !this.fresh(prior) || prior.state !== 'prepared'))
				return undefined;
			if (
				!prior &&
				!this.write({
					kind: 'delivery',
					id,
					scope,
					created: this.config.now(),
					history: clone(history),
					body,
					prefix: clone(history.slice(0, c.start)),
					retained: clone(history.slice(c.start + c.count)),
					state: 'prepared',
				})
			)
				return undefined;
			return { id, body, text: `<summary>\n${body}\n</summary>` };
		}, undefined);
	}
	markSent(id: string): boolean {
		return this.locked(() => {
			const e = this.readAll().find((e) => e.id === id);
			if (!e || e.kind !== 'delivery' || !this.fresh(e)) return false;
			if (e.state !== 'prepared') return false;
			e.state = 'sent_pending';
			return this.write(e);
		}, false);
	}
	state(id: string): string | undefined {
		return this.locked(() => {
			const e = this.readAll().find((e) => e.id === id);
			return e?.kind === 'delivery' ? e.state : undefined;
		}, undefined);
	}
	observe(scope: string | undefined, messages: DeepSeekMessage[]): boolean {
		return this.adoptGeneration(scope, messages) !== undefined;
	}
	/** Return a stable, isolated fold namespace only after exact host adoption is persisted. */
	adoptGeneration(scope: string | undefined, messages: DeepSeekMessage[]): string | undefined {
		if (!validScope(scope) || !validMessages(messages) || !closedToolPairs(messages))
			return undefined;
		return this.locked(() => {
			const matches: { entry: Delivery; tail: DeepSeekMessage[] }[] = [];
			for (const e of this.readAll()) {
				if (e.kind !== 'delivery' || e.scope !== scope || !this.fresh(e) || e.state === 'prepared')
					continue;
				const indexes = messages.flatMap((m, index) => {
					const text =
						typeof m.content === 'string'
							? m.content
							: Array.isArray(m.content)
								? m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
								: '';
					const match = text
						.trim()
						.match(/^<conversation-summary>\s*([\s\S]*?)\s*<\/conversation-summary>$/);
					return m.role === 'user' && !!match && matchesHostBody(match[1], e.body) ? [index] : [];
				});
				if (indexes.length !== 1) continue;
				const at = indexes[0];
				if (hash(messages.slice(0, at)) !== hash(e.prefix)) continue;
				const tail = messages.slice(at + 1);
				if (!e.retained.length || hash(e.retained) !== hash(tail.slice(0, e.retained.length)))
					continue;
				const keys = tail.map(hash);
				if (
					e.actualTailKeys &&
					hash(keys.slice(0, e.actualTailKeys.length)) !== hash(e.actualTailKeys)
				)
					continue;
				matches.push({ entry: e, tail });
			}
			if (matches.length !== 1) return undefined;
			const { entry, tail } = matches[0];
			entry.state = 'adopted';
			entry.adoptedRoot = hash(messages);
			entry.actualTailKeys = tail.map(hash);
			// One atomic record switches the generation. Old fold records are never relabelled.
			return this.write(entry) ? `host-adopted:${scope}:${entry.id}` : undefined;
		}, undefined);
	}
}
