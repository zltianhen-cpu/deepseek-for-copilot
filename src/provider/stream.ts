import { createSessionTextStream } from './session-paths';
import vscode from 'vscode';
import { createUserFacingError } from '../client';
import { logger } from '../logger';
import type { DeepSeekToolCall, DeepSeekUsage } from '../types';
import {
	observeCancellationToken,
	type CacheDiagnosticsRun,
	type ReplayMarkerReportTrigger,
} from './debug';
import {
	createReplayMarkerPart,
	hasReplayMarkerMetadata,
	type ReplayMarkerMetadata,
} from './replay';
import type { PreparedChatRequest } from './request';
import { formatRequestLogLine, type RequestKind } from './routing';
import { logUsage, REAL_TURN_KIND } from './chat-hooks';

interface ResponseStreamState {
	accumulatedReasoning: string;
	emittedToolCallIds: string[];
	initialResponseNoticeReported: boolean;
	replayMarkerReported: boolean;
}

const COPILOT_USAGE_DATA_PART_MIME = 'usage';

export interface StreamChatCompletionOptions {
	prepared: PreparedChatRequest;
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	token: vscode.CancellationToken;
	initialResponseNotice?: string;
	getCharsPerToken: () => number;
	setCharsPerToken: (charsPerToken: number) => void;
}

export function streamChatCompletion({
	prepared,
	progress,
	token,
	initialResponseNotice,
	getCharsPerToken,
	setCharsPerToken,
}: StreamChatCompletionOptions): Promise<void> {
	const state: ResponseStreamState = {
		accumulatedReasoning: '',
		emittedToolCallIds: [],
		initialResponseNoticeReported: false,
		replayMarkerReported: false,
	};
	const cancelListener = observeCancellationToken(token, prepared.cacheDiagnostics);
	const restoreText = prepared.restoreSessionText ?? ((text: string) => text);
	const contentStream = createSessionTextStream(restoreText, (text) =>
		progress.report(new vscode.LanguageModelTextPart(text)),
	);
	const thinkingStream = createSessionTextStream(restoreText, (text) =>
		handleThinking(text, state, progress),
	);
	const flushText = () => {
		thinkingStream.flush();
		contentStream.flush();
	};

	return prepared.client
		.streamChatCompletion(
			prepared.request,
			{
				onContent: (content: string) => {
					reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
					thinkingStream.flush();
					contentStream.push(content);
				},

				onThinking: (text: string) => {
					reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
					contentStream.flush();
					thinkingStream.push(text);
				},

				onToolCall: (toolCall: DeepSeekToolCall) => {
					flushText();
					reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
					handleToolCall(
						prepared.restoreSessionArguments
							? {
									...toolCall,
									function: {
										...toolCall.function,
										arguments: prepared.restoreSessionArguments(toolCall.function.arguments),
									},
								}
							: toolCall,
						state,
						progress,
					);
				},

				onError: (error: Error) => {
					throw createUserFacingError(error);
				},

				onDone: () => {
					flushText();
					reportReplayMarkerOnce(prepared, progress, state, 'done');
					finalizeReplayDiagnostics(
						prepared.trailingToolResultIds,
						state,
						prepared.cacheDiagnostics,
					);
				},

				onUsage: (usage) => {
					const charsPerToken = prepared.hasNativeImages
						? getCharsPerToken()
						: updateCharsPerToken(prepared.totalRequestChars, usage, getCharsPerToken());
					if (!prepared.hasNativeImages) {
						setCharsPerToken(charsPerToken);
					}
					prepared.cacheDiagnostics.onUsage(usage, charsPerToken);
					// 本扩展内建钩子：真实用量上报（只读）
					// 推理 token 只出现在运行时响应里，官方类型未声明 → 安全断言取用
					const reasoningTokens = (
						usage as unknown as {
							completion_tokens_details?: { reasoning_tokens?: number };
						}
					).completion_tokens_details?.reasoning_tokens;
					logUsage({
						prompt: usage.prompt_tokens,
						cacheHit: usage.prompt_cache_hit_tokens ?? 0,
						cacheMiss: usage.prompt_cache_miss_tokens,
						completion: usage.completion_tokens,
						reasoning: reasoningTokens,
						kind: prepared.requestKind,
						isRealTurn: prepared.requestKind === REAL_TURN_KIND,
						charsPerToken: getCharsPerToken(),
						model: prepared.request.model,
					});
					reportCopilotContextUsage(progress, usage, prepared.requestKind);
				},
			},
			token,
		)
		.then(undefined, (error) => {
			flushText();
			reportSkippedReplayMarkerIfNeeded(
				prepared,
				state,
				token.isCancellationRequested ? 'cancelled' : 'stream-error',
				error,
			);
			throw error;
		})
		.then(() => {
			flushText();
			if (token.isCancellationRequested) {
				reportSkippedReplayMarkerIfNeeded(prepared, state, 'cancelled');
			}
		})
		.finally(() => {
			cancelListener.dispose();
		});
}

function reportInitialResponseNoticeOnce(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	state: ResponseStreamState,
	initialResponseNotice: string | undefined,
): void {
	if (!initialResponseNotice || state.initialResponseNoticeReported) {
		return;
	}
	state.initialResponseNoticeReported = true;
	progress.report(new vscode.LanguageModelTextPart(initialResponseNotice));
}

function reportReplayMarkerOnce(
	prepared: PreparedChatRequest,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	state: ResponseStreamState,
	trigger: ReplayMarkerReportTrigger,
): void {
	if (state.replayMarkerReported) {
		return;
	}
	state.replayMarkerReported = true;
	reportReplayMarker(prepared, progress, state, trigger);
}

function reportSkippedReplayMarkerIfNeeded(
	prepared: PreparedChatRequest,
	state: ResponseStreamState,
	reason: 'cancelled' | 'stream-error',
	error?: unknown,
): void {
	if (state.replayMarkerReported) {
		return;
	}
	state.replayMarkerReported = true;
	prepared.cacheDiagnostics.onReplayMarkerReport({
		status: 'skipped',
		reason,
		visionTextChars: prepared.visionMarkerTextChars,
		reasoningTextChars: state.accumulatedReasoning.length || undefined,
		error,
	});
}

function reportReplayMarker(
	prepared: PreparedChatRequest,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	state: ResponseStreamState,
	trigger: ReplayMarkerReportTrigger,
): void {
	const metadata = getReplayMarkerMetadata(prepared, state);
	// 2026-09-13：即使没有 vision/reasoning 数据，也带 segmentId 上报最小 marker——
	// 让 stateful_marker 回读通道激活（对话身份闭环，折叠/柜子钥匙随之稳定）。
	if (!hasReplayMarkerMetadata(metadata) && !metadata.segmentId) {
		prepared.cacheDiagnostics.onReplayMarkerReport({
			status: 'skipped',
			trigger,
			reason: 'no-replay-data',
			visionTextChars: prepared.visionMarkerTextChars,
			reasoningTextChars: state.accumulatedReasoning.length || undefined,
		});
		return;
	}

	try {
		const markerPart = createReplayMarkerPart(metadata);
		progress.report(markerPart);
		prepared.cacheDiagnostics.onReplayMarkerReport({
			status: 'reported',
			trigger,
			markerBytes: markerPart.data.byteLength,
			visionTextChars: prepared.visionMarkerTextChars,
			reasoningTextChars: state.accumulatedReasoning.length || undefined,
		});
	} catch (error) {
		prepared.cacheDiagnostics.onReplayMarkerReport({
			status: 'failed',
			trigger,
			visionTextChars: prepared.visionMarkerTextChars,
			reasoningTextChars: state.accumulatedReasoning.length || undefined,
			error,
		});
		logger.warn(
			formatRequestLogLine(prepared.requestKind, 'Failed to report replay marker'),
			error,
		);
	}
}

function getReplayMarkerMetadata(
	prepared: PreparedChatRequest,
	state: ResponseStreamState,
): ReplayMarkerMetadata {
	return {
		...prepared.replayMarkerMetadata,
		reasoningText: state.accumulatedReasoning || undefined,
	};
}

function handleThinking(
	text: string,
	state: ResponseStreamState,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	state.accumulatedReasoning += text;

	// LanguageModelThinkingPart is a proposed API; the project root augmentation provides types.
	progress.report(
		new vscode.LanguageModelThinkingPart(text) as unknown as vscode.LanguageModelResponsePart,
	);
}

function handleToolCall(
	toolCall: DeepSeekToolCall,
	state: ResponseStreamState,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	if (toolCall.function.name === 'renderMermaidDiagram') {
		// 宿主未列出该工具时会拒绝执行（即使注册表里有）。直接交给
		// VS Code 的 Mermaid 代码块渲染器，避免出现「模型能选、宿主不能调」。
		try {
			const args: unknown = JSON.parse(toolCall.function.arguments);
			const markup =
				args && typeof args === 'object' && 'markup' in args
					? (args as { markup: unknown }).markup
					: undefined;
			if (typeof markup !== 'string' || !markup.trim()) {
				throw new Error('missing markup');
			}
			const runs = [...markup.matchAll(/`+/g)].map((match) => match[0].length);
			const fence = '`'.repeat(Math.max(3, ...runs.map((length) => length + 1)));
			progress.report(new vscode.LanguageModelTextPart(`\n${fence}mermaid\n${markup}\n${fence}\n`));
		} catch {
			progress.report(new vscode.LanguageModelTextPart('\nMermaid 图未生成：图形内容无效。\n'));
		}
		return;
	}
	state.emittedToolCallIds.push(toolCall.id);

	try {
		const args = JSON.parse(toolCall.function.arguments);
		progress.report(
			new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, args),
		);
	} catch {
		progress.report(new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, {}));
	}
}

function finalizeReplayDiagnostics(
	trailingToolResultIds: readonly string[],
	state: ResponseStreamState,
	cacheDiagnostics: CacheDiagnosticsRun,
): void {
	cacheDiagnostics.onDone({
		reasoningTextChars: state.accumulatedReasoning.length,
		emittedToolCalls: state.emittedToolCallIds.length,
		trailingToolResults: trailingToolResultIds.length,
	});
}

function updateCharsPerToken(
	totalRequestChars: number,
	usage: DeepSeekUsage,
	charsPerToken: number,
): number {
	if (totalRequestChars > 0 && usage.prompt_tokens > 0) {
		const observedRatio = totalRequestChars / usage.prompt_tokens;
		return charsPerToken * 0.7 + observedRatio * 0.3;
	}
	return charsPerToken;
}

function reportCopilotContextUsage(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	usage: DeepSeekUsage,
	requestKind: RequestKind,
): void {
	const data = {
		prompt_tokens: usage.prompt_tokens,
		completion_tokens: usage.completion_tokens,
		total_tokens: usage.total_tokens,
		prompt_tokens_details: {
			cached_tokens: usage.prompt_cache_hit_tokens ?? 0,
		},
	};

	try {
		progress.report(
			new vscode.LanguageModelDataPart(
				new TextEncoder().encode(JSON.stringify(data)),
				COPILOT_USAGE_DATA_PART_MIME,
			),
		);
	} catch (error) {
		logger.warn(formatRequestLogLine(requestKind, 'Failed to report usage data'), error);
	}
}
