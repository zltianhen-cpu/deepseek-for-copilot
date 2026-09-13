import { newRequestId, recordRequestEvent } from './request-events';
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
	prefixMessages?: unknown[];
	tools?: unknown;
}

function asMessages(foldMsgs: unknown[]): DeepSeekMessage[] {
	const out: DeepSeekMessage[] = [];
	for (const raw of foldMsgs || []) {
		if (!raw || typeof raw !== 'object') continue;
		const m = raw as DeepSeekMessage;
		if (!m.role) continue;
		out.push(m);
	}
	return out;
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
	const prefix =
		extra?.prefixMessages && extra.prefixMessages.length ? extra.prefixMessages : foldMsgs;
	const tools = asTools(extra?.tools !== undefined ? extra.tools : fallbackTools);
	return {
		model,
		messages: [...asMessages(prefix), { role: 'user', content: COMPACTION_INSTRUCTION }],
		stream: false,
		temperature: 0,
		thinking: { type: 'disabled' },
		max_tokens: 4096,
		tools,
		tool_choice: tools && tools.length > 0 ? 'none' : undefined,
	};
}

/**
 * 用当前对话已配好的钥匙写简历。失败/超时返回空串，调用方不折。
 * 绝不抛到正轮。
 */
export function makeFoldSummarize(
	client: DeepSeekClient,
	model: string,
	token?: CancellationToken,
	tools?: unknown,
	parentRequestId?: string,
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
		const requestId = newRequestId();
		const started = Date.now();
		summarize.lastDiagnostic = { ...emptyDiagnostic(), attempt: ++attempt, reason: 'unknown' };
		try {
			if (token?.isCancellationRequested) {
				summarize.lastDiagnostic.reason = 'cancelled';
				return '';
			}
			const request = buildFoldSummaryRequest(model, foldMsgs, extra, tools);
			for (const budget of [4096, 8192]) {
				request.max_tokens = budget;
				try {
					const remaining = FOLD_LLM_TIMEOUT_MS - (Date.now() - started);
					if (remaining <= 0)
						throw Object.assign(new Error('Summary timeout'), { name: 'AbortError' });
					summarize.lastDiagnostic.requests++;
					recordRequestEvent(requestId, 'SEND_ATTEMPT', 'summary', parentRequestId);
					const text = await client.completeChat(request, remaining, token);
					summarize.lastDiagnostic.reason = 'success';
					return (text || '').trim();
				} catch (error) {
					recordRequestEvent(requestId, 'REQUEST_SEND_FAILED', 'summary', parentRequestId);
					if (
						(error as { code?: string })?.code === 'truncated' &&
						budget === 4096 &&
						!token?.isCancellationRequested
					)
						continue;
					throw error;
				}
			}
			return '';
		} catch (error) {
			const e = error as { code?: string; name?: string; status?: number; statusCode?: number };
			const allowed = ['truncated', 'invalid-finish', 'empty'];
			summarize.lastDiagnostic.reason = allowed.includes(e?.code ?? '')
				? e.code!
				: token?.isCancellationRequested
					? 'cancelled'
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
			if (summarize.lastDiagnostic.requests > 0)
				recordRequestEvent(requestId, 'USAGE_UNAVAILABLE', 'summary', parentRequestId);
			summarize.lastDiagnostic.elapsedMs = Date.now() - started;
		}
	};
	summarize.lastDiagnostic = emptyDiagnostic();
	return summarize;
}
