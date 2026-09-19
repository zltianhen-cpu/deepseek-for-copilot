import type { CancellationToken } from 'vscode';
import { safeStringify } from '../json';
import { createSendReceipt } from '../send-receipt';
import { assertRequestBudget, getRequestBudgetPolicy } from '../request-budget';
import { logger } from '../logger';
import type {
	DeepSeekRequest,
	DeepSeekStreamChunk,
	DeepSeekToolCall,
	DeepSeekUsage,
	StreamCallbacks,
} from '../types';
import { createHttpError, formatRequestError, normalizeRequestError } from './error';

/**
 * Lightweight SSE-streaming DeepSeek API client.
 * No external dependencies — uses Node's built-in fetch.
 */
export class DeepSeekClient {
	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
	) {}

	/**
	 * Stream a chat completion from the DeepSeek API.
	 * Parses SSE chunks and dispatches callbacks for content, thinking, and tool calls.
	 */
	async streamChatCompletion(
		request: DeepSeekRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		const receipt = createSendReceipt(request);
		const controller = new AbortController();
		const cancelListener = cancellationToken?.onCancellationRequested(() => {
			controller.abort();
		});
		if (cancellationToken?.isCancellationRequested) {
			controller.abort();
		}

		let latestUsage: DeepSeekUsage | undefined;
		try {
			// Request usage stats in streaming responses so we can calibrate token counting.
			const requestBody = {
				...request,
				stream_options: { include_usage: true },
			};

			if (controller.signal.aborted) return;
			const serializedBody = safeStringify(requestBody);
			assertRequestBudget(JSON.parse(serializedBody), getRequestBudgetPolicy(request));
			if (controller.signal.aborted) return;
			receipt.start(serializedBody);
			const response = await fetch(`${this.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: serializedBody,
				signal: controller.signal,
			});

			if (!response.ok) {
				throw await createHttpError(response, { baseUrl: this.baseUrl, request });
			}

			receipt.accepted(response.status);
			if (!response.body) {
				throw new Error('No response body received');
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			// Accumulate tool call deltas by index, then emit on finish_reason=stop/tool_calls
			const pendingToolCalls = new Map<number, DeepSeekToolCall>();

			while (true) {
				if (cancellationToken?.isCancellationRequested) {
					controller.abort();
					return;
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });

				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();

					if (!trimmed || trimmed.startsWith(':')) {
						continue;
					}

					if (trimmed === 'data: [DONE]') {
						// Flush any remaining tool calls
						for (const tc of pendingToolCalls.values()) {
							callbacks.onToolCall(tc);
						}
						pendingToolCalls.clear();
						receipt.usage(latestUsage);
						reportFinalUsage(callbacks, latestUsage);
						callbacks.onDone();
						return;
					}

					if (!trimmed.startsWith('data: ')) {
						continue;
					}

					const jsonStr = trimmed.slice(6);
					try {
						const chunk: DeepSeekStreamChunk = JSON.parse(jsonStr);
						const choice = chunk.choices?.[0];

						// Some OpenAI-compatible providers emit usage on every streaming chunk.
						// Keep only the latest value and report it once when the stream completes.
						if (chunk.usage) {
							latestUsage = chunk.usage;
						}

						if (!choice) {
							continue;
						}

						// Thinking content → report with correct field name so VS Code renders collapsible blocks
						const reasoning = choice.delta.reasoning_content;
						if (reasoning) {
							callbacks.onThinking(reasoning);
						}

						// Regular content
						if (choice.delta.content) {
							callbacks.onContent(choice.delta.content);
						}

						// Tool calls — accumulate deltas by index
						if (choice.delta.tool_calls) {
							for (const tc of choice.delta.tool_calls) {
								let pending = pendingToolCalls.get(tc.index);
								if (!pending && tc.id) {
									pending = {
										id: tc.id,
										type: 'function',
										function: { name: '', arguments: '' },
									};
									pendingToolCalls.set(tc.index, pending);
								}
								if (pending) {
									if (tc.function?.name) {
										pending.function.name += tc.function.name;
									}
									if (tc.function?.arguments) {
										pending.function.arguments += tc.function.arguments;
									}
								}
							}
						}

						// Flush pending tool calls on finish
						if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
							for (const tc of pendingToolCalls.values()) {
								callbacks.onToolCall(tc);
							}
							pendingToolCalls.clear();
						}
					} catch (e) {
						logger.error('Failed to parse SSE chunk:', jsonStr.slice(0, 200), e);
					}
				}
			}

			receipt.usage(latestUsage);
			reportFinalUsage(callbacks, latestUsage);
			callbacks.onDone();
		} catch (error) {
			receipt.failed();
			if (isAbortError(error) && cancellationToken?.isCancellationRequested) {
				return;
			}
			const normalizedError = normalizeRequestError(error, { baseUrl: this.baseUrl, request });
			logger.error('DeepSeek request failed:', formatRequestError(normalizedError));
			callbacks.onError(normalizedError);
		} finally {
			receipt.usage(latestUsage);
			receipt.finish(cancellationToken?.isCancellationRequested);
			cancelListener?.dispose();
		}
	}

	/**
	 * 非流式补全。给折叠写简历用。超时/取消/失败抛错，由调用方吞成「不折」。
	 */
	async completeChat(
		request: DeepSeekRequest,
		timeoutMs: number,
		cancellationToken?: CancellationToken,
	): Promise<string> {
		const receipt = createSendReceipt(request);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs || 1));
		const cancelListener = cancellationToken?.onCancellationRequested(() => {
			controller.abort();
		});
		if (cancellationToken?.isCancellationRequested) {
			controller.abort();
		}
		try {
			controller.signal.throwIfAborted();
			const serializedBody = safeStringify({ ...request, stream: false });
			assertRequestBudget(JSON.parse(serializedBody), getRequestBudgetPolicy(request));
			controller.signal.throwIfAborted();
			receipt.start(serializedBody);
			const response = await fetch(`${this.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: serializedBody,
				signal: controller.signal,
			});
			if (!response.ok) {
				throw await createHttpError(response, { baseUrl: this.baseUrl, request });
			}
			receipt.accepted(response.status);
			const data = (await response.json()) as {
				usage?: DeepSeekUsage;
				choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }>;
			};
			receipt.usage(data?.usage);
			const choice = data?.choices?.[0];
			// 半截摘要不能替代完整历史；未明确完整结束也拒绝提交。
			if (choice?.finish_reason !== 'stop') {
				throw Object.assign(new Error('Summary incomplete'), {
					code: choice?.finish_reason === 'length' ? 'truncated' : 'invalid-finish',
				});
			}
			const content = choice.message?.content;
			if (typeof content !== 'string' || !content.trim()) {
				throw Object.assign(new Error('Summary empty'), { code: 'empty' });
			}
			return content;
		} catch (error) {
			receipt.failed();
			throw error;
		} finally {
			clearTimeout(timer);
			receipt.finish(cancellationToken?.isCancellationRequested);
			cancelListener?.dispose();
		}
	}
}

function reportFinalUsage(callbacks: StreamCallbacks, usage: DeepSeekUsage | undefined): void {
	if (!usage || !callbacks.onUsage) {
		return;
	}
	callbacks.onUsage(usage);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}
