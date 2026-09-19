import { newRequestId, recordRequestEvent } from './request-events';
import { bindRequestTrace } from '../send-receipt';
import {
	assessRequestBudget,
	assertRequestBudget,
	bindRequestBudget,
	DEFAULT_BUDGET_POLICY,
	type RequestBudgetPolicy,
} from '../request-budget';
import type { CancellationToken } from 'vscode';
import type { DeepSeekClient } from '../client';
import type { DeepSeekMessage, DeepSeekRequest, DeepSeekTool } from '../types';

/** 写简历最多等这么久；超时当没写成，正轮照发原文。 */
export const FOLD_LLM_TIMEOUT_MS = 60000;

/** 逐字抄 Reasonix compact.go compactionInstruction。 */
export const COMPACTION_INSTRUCTION = `Compact the preceding conversation prefix into a durable resume briefing.
Write under these exact headings, omitting a heading only if it has no content:

## Standing facts & constraints
Everything the user stated that still governs the work — names, paths, IDs, versions, tokens, preferences, and hard "never do X" rules — in their own words. Be exhaustive; this is the durable contract, so prefer over- to under-including.

## Goal
The user's request and intent.

## Decisions & rationale
Key choices made so far and why — so they are not re-litigated or reversed.

## Files & code
Files read or modified, with the specific facts that matter: signatures, line locations, data shapes, and exact edits applied. Be concrete; this is what lets the agent act without re-reading everything.

## Commands & outcomes
Commands run (builds, tests, git) and their relevant results — what passed, what failed, and the error text that matters.

## Errors & fixes
Problems hit and how they were resolved (or not), so the same dead ends are not repeated.

## Pending & next step
What is still in progress or unstarted, and the single most concrete next action to take.

Rules: be terse — bullet points and fragments, not prose. Preserve identifiers, paths, and numbers exactly. Merge valid facts from any existing <compaction-summary> and remove facts superseded by later messages. Do NOT invent anything not present in the messages; if something is unknown, leave it out rather than guessing. Output only the structured Markdown briefing. Do not call tools. Do not output reasoning.`;

export interface FoldSummarizeExtra {
	protectedPrefixCount?: number;
	prefixMessages?: unknown[];
	tools?: unknown;
}

function asMessages(rawMessages: unknown[]): DeepSeekMessage[] {
	if (!Array.isArray(rawMessages)) throw summaryError('invalid-messages');
	let seenBody = false;
	for (const raw of rawMessages) {
		if (!raw || typeof raw !== 'object') throw summaryError('invalid-messages');
		const m = raw as DeepSeekMessage;
		if (
			!['system', 'user', 'assistant', 'tool'].includes(m.role) ||
			!(typeof m.content === 'string' || Array.isArray(m.content))
		)
			throw summaryError('invalid-messages');
		if (m.role === 'system') {
			if (seenBody) throw summaryError('mid-system');
		} else seenBody = true;
	}
	return rawMessages as DeepSeekMessage[];
}

/** 唯一连续匹配才保留整轮缓存前缀，禁止猜测折区。 */
function targetRange(prefix: DeepSeekMessage[], target: DeepSeekMessage[]): number | undefined {
	if (!target.length) return undefined;
	const keys = target.map((m) => JSON.stringify(m));
	const matches: number[] = [];
	for (let i = 0; i <= prefix.length - target.length; i++) {
		if (keys.every((key, j) => JSON.stringify(prefix[i + j]) === key)) matches.push(i);
	}
	return matches.length === 1 ? matches[0] : undefined;
}

function asTools(tools: unknown): DeepSeekTool[] | undefined {
	if (!Array.isArray(tools) || tools.length === 0) return undefined;
	return tools as DeepSeekTool[];
}

/** 组装写简历请求：正轮全文 + 末尾一句提纲。tools 与正轮同一份。 */
export function buildFoldSummaryRequest(
	model: string,
	foldMsgs: unknown[],
	extra?: FoldSummarizeExtra,
	fallbackTools?: unknown,
): DeepSeekRequest {
	const target = asMessages(foldMsgs);
	const supplied = extra?.prefixMessages?.length ? asMessages(extra.prefixMessages) : undefined;
	const range = supplied ? targetRange(supplied, target) : undefined;
	const count = extra?.protectedPrefixCount ?? 0;
	if (!Number.isSafeInteger(count) || count < 0 || count > (supplied?.length ?? 0))
		throw summaryError('invalid-messages');
	const systems =
		supplied?.slice(
			0,
			Math.max(
				count,
				supplied.findIndex((m) => m.role !== 'system') < 0
					? supplied.length
					: supplied.findIndex((m) => m.role !== 'system'),
			),
		) ?? [];
	const prefix =
		supplied && range !== undefined
			? supplied
			: [...systems.filter((m) => !target.includes(m)), ...target];
	const actualStart =
		supplied && range !== undefined ? range : systems.filter((m) => !target.includes(m)).length;
	const instruction = supplied
		? COMPACTION_INSTRUCTION +
			`\nSUMMARY_TARGET_RANGE=${actualStart}:${actualStart + target.length - 1} (zero-based inclusive message indexes). Summarize only this range. Do not summarize messages outside this range; they are context only.`
		: COMPACTION_INSTRUCTION;
	const tools = asTools(extra?.tools !== undefined ? extra.tools : fallbackTools);
	return {
		model,
		messages: [...asMessages(prefix), { role: 'user', content: instruction }],
		stream: false,
		temperature: 0,
		thinking: { type: 'disabled' },
		max_tokens: 4096,
		tools,
		tool_choice: tools && tools.length > 0 ? 'none' : undefined,
	};
}

/** 工具调用与全部对应回复不可分割；残缺或孤儿组本地拒绝。 */
function atomicGroups(messages: DeepSeekMessage[]): DeepSeekMessage[][] {
	const groups: DeepSeekMessage[][] = [];
	for (let i = 0; i < messages.length; i += 1) {
		const message = messages[i];
		if (message.role === 'tool') throw summaryError('budget');
		const group = [message];
		if (message.tool_calls?.length) {
			const pending = new Set(message.tool_calls.map((call) => call.id));
			if (message.role !== 'assistant' || pending.size !== message.tool_calls.length)
				throw summaryError('budget');
			while (i + 1 < messages.length && messages[i + 1].role === 'tool') {
				const reply = messages[++i];
				if (!reply.tool_call_id || !pending.delete(reply.tool_call_id))
					throw summaryError('budget');
				group.push(reply);
			}
			if (pending.size) throw summaryError('budget');
		}
		groups.push(group);
	}
	return groups;
}

function summaryError(code: string): Error {
	return Object.assign(new Error(`Summary ${code}`), { code });
}

/** 有界完整摘要：任意块失败即返回空，调用方保留全部原文。 */
export function makeFoldSummarize(
	client: DeepSeekClient,
	model: string,
	token?: CancellationToken,
	tools?: unknown,
	parentRequestId?: string,
	policy: RequestBudgetPolicy = DEFAULT_BUDGET_POLICY,
) {
	let attempt = 0;
	const emptyDiagnostic = () => ({
		attempt: 0,
		reason: 'not-called',
		elapsedMs: 0,
		requests: 0,
		httpStatus: 0,
	});
	const summarize = async (foldMsgs: unknown[], extra?: FoldSummarizeExtra) => {
		const started = Date.now();
		summarize.lastDiagnostic = { ...emptyDiagnostic(), attempt: ++attempt, reason: 'unknown' };
		const checkActive = () => {
			if (token?.isCancellationRequested) throw summaryError('cancelled');
			if (Date.now() - started >= FOLD_LLM_TIMEOUT_MS) throw summaryError('timeout');
		};
		const actualTools = extra?.tools !== undefined ? extra.tools : tools;
		let fixed: DeepSeekMessage[] = [];
		const build = (messages: DeepSeekMessage[]) =>
			buildFoldSummaryRequest(model, messages, {
				tools: actualTools,
				...(fixed.length
					? { prefixMessages: [...fixed, ...messages], protectedPrefixCount: fixed.length }
					: {}),
			});
		const fits = (request: DeepSeekRequest) => assessRequestBudget(request, policy).ok;
		const send = async (base: DeepSeekRequest): Promise<string> => {
			for (const outputTokens of [4096, 8192]) {
				checkActive();
				if (summarize.lastDiagnostic.requests >= 12) throw summaryError('request-limit');
				const request = bindRequestBudget({ ...base, max_tokens: outputTokens }, policy);
				assertRequestBudget(request, policy);
				const requestId = newRequestId();
				summarize.lastDiagnostic.requests += 1;
				bindRequestTrace(request, { requestId, requestKind: 'summary', parentRequestId });
				recordRequestEvent(requestId, 'PREPARE', 'summary', parentRequestId);
				try {
					const text = await client.completeChat(
						request,
						FOLD_LLM_TIMEOUT_MS - (Date.now() - started),
						token,
					);
					checkActive();
					if (typeof text !== 'string' || !text.trim()) throw summaryError('empty');
					return text.trim();
				} catch (error) {
					checkActive();
					if ((error as { code?: string })?.code === 'truncated' && outputTokens === 4096) continue;
					throw error;
				}
			}
			throw summaryError('truncated');
		};
		try {
			checkActive();
			const full = buildFoldSummaryRequest(model, foldMsgs, extra, tools);
			atomicGroups(full.messages);
			if (fits(full)) {
				const result = await send(full);
				summarize.lastDiagnostic.reason = 'success';
				return result;
			}

			// 完整 prefix 超线后只按 foldMsgs 切块；固定 system 仍保留。
			const source = asMessages(foldMsgs);
			const leadingEnd = full.messages.findIndex((m) => m.role !== 'system');
			fixed = full.messages.slice(
				0,
				Math.max(
					extra?.protectedPrefixCount ?? 0,
					leadingEnd < 0 ? full.messages.length : leadingEnd,
				),
			);
			for (const message of source.filter((m) => m.role === 'system')) {
				if (!fixed.some((existing) => JSON.stringify(existing) === JSON.stringify(message)))
					fixed.push(message);
			}
			const groups = atomicGroups(source)
				.map((group) => group.filter((message) => message.role !== 'system'))
				.filter((group) => group.length);
			const pack = (input: DeepSeekMessage[][]): DeepSeekRequest[] => {
				if (!fits(build([]))) throw summaryError('budget');
				const requests: DeepSeekRequest[] = [];
				let current: DeepSeekMessage[] = [];
				for (const group of input) {
					checkActive();
					if (!fits(build(group))) throw summaryError('budget');
					if (current.length && !fits(build([...current, ...group]))) {
						requests.push(build(current));
						current = [];
					}
					current.push(...group);
				}
				if (current.length) requests.push(build(current));
				if (!requests.length) throw summaryError('budget');
				return requests;
			};
			const run = async (requests: DeepSeekRequest[]): Promise<string[]> => {
				if (requests.length + summarize.lastDiagnostic.requests > 12)
					throw summaryError('request-limit');
				const results: string[] = [];
				for (const request of requests) results.push(await send(request));
				return results;
			};
			const join = (parts: string[]) =>
				parts.length === 1
					? parts[0]
					: parts
							.map((part, i) => `### Summary part ${i + 1}/${parts.length}\n${part}`)
							.join('\n\n');
			let parts = await run(pack(groups));
			let result = join(parts);
			if (!fits(build([{ role: 'user', content: result }]))) {
				// 仅再缩减一层；每个首层摘要仍作为原子组，不截字。
				parts = await run(
					pack(
						parts.map((part, i) => [
							{ role: 'user', content: `Summary part ${i + 1}/${parts.length}\n${part}` },
						]),
					),
				);
				result = join(parts);
				if (!fits(build([{ role: 'user', content: result }]))) throw summaryError('budget');
			}
			checkActive();
			summarize.lastDiagnostic.reason = 'success';
			return result;
		} catch (error) {
			const e = error as { code?: string; name?: string; status?: number; statusCode?: number };
			const allowed = [
				'invalid-messages',
				'mid-system',
				'truncated',
				'invalid-finish',
				'empty',
				'budget',
				'request-limit',
				'cancelled',
				'timeout',
			];
			summarize.lastDiagnostic.reason = token?.isCancellationRequested
				? 'cancelled'
				: allowed.includes(e?.code ?? '')
					? e.code!
					: ['request-budget-exceeded', 'invalid-request-budget'].includes(e?.code ?? '')
						? 'budget'
						: e?.name === 'AbortError'
							? 'timeout'
							: e?.name === 'TypeError'
								? 'network'
								: e?.status || e?.statusCode
									? 'http'
									: 'unknown';
			const status = e?.status || e?.statusCode;
			summarize.lastDiagnostic.httpStatus =
				Number.isInteger(status) && status! >= 100 && status! <= 599 ? status! : 0;
			return '';
		} finally {
			summarize.lastDiagnostic.elapsedMs = Date.now() - started;
		}
	};
	summarize.lastDiagnostic = emptyDiagnostic();
	return summarize;
}
