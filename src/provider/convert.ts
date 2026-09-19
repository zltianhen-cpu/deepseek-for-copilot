import vscode from 'vscode';
import { safeStringify } from '../json';
import type {
	DeepSeekContentPart,
	DeepSeekMessage,
	DeepSeekTool,
	DeepSeekToolCall,
} from '../types';
import { parseFirstReplayMarker } from './replay';
import {
	isImageDataPart,
	normalizeToolResult,
	type NormalizedToolResult,
} from './vision/normalize';

/**
 * Convert VS Code chat messages to DeepSeek format.
 * Injects marker-replayed reasoning_content for assistant messages.
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	isThinkingModel: boolean,
	nativeImageInput: boolean,
): DeepSeekMessage[] {
	const result: DeepSeekMessage[] = [];

	for (const message of messages) {
		const role = mapRole(message.role);

		let content = '';
		const nativeVisionContentParts: DeepSeekContentPart[] = [];
		let thinkingContent = '';
		const toolCalls: DeepSeekToolCall[] = [];
		const toolResults: NormalizedToolResult[] = [];

		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				content += part.value;
				if (nativeImageInput && role === 'user') {
					nativeVisionContentParts.push({
						type: 'text',
						text: part.value,
					});
				}
			} else if (nativeImageInput && role === 'user' && isImageDataPart(part)) {
				nativeVisionContentParts.push({
					type: 'image_url',
					image_url: {
						url: toImageDataUrl(part),
					},
				});
			} else if (isLanguageModelThinkingPart(part)) {
				thinkingContent += normalizeThinkingPartText(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: {
						name: part.name,
						arguments: safeStringify(part.input),
					},
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push(normalizeToolResult(part));
			}
		}

		if (role === 'assistant') {
			if (content || toolCalls.length > 0) {
				const replayMarker = isThinkingModel ? parseFirstReplayMarker(message) : undefined;
				const msg: DeepSeekMessage = {
					role: 'assistant' as const,
					content: content || '',
				};

				if (toolCalls.length > 0) {
					msg.tool_calls = toolCalls;
				}

				if (isThinkingModel) {
					msg.reasoning_content = getReasoningContent(replayMarker, thinkingContent);
				}

				result.push(msg);
			}
		} else {
			if (nativeImageInput && role === 'user' && nativeVisionContentParts.length > 0) {
				result.push({
					role: 'user',
					content: nativeVisionContentParts,
				});
			} else if (content) {
				result.push({
					role: role as 'user' | 'assistant',
					content: content,
				});
			}
		}

		// Tool result messages follow their associated assistant message
		for (const tr of toolResults) {
			result.push({
				role: 'tool',
				content: convertToolResultContent(tr, nativeImageInput),
				tool_call_id: tr.callId,
			});
		}
	}

	return result;
}

function toImageDataUrl(part: { mimeType: string; data: Uint8Array }): string {
	return `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`;
}

function convertToolResultContent(
	toolResult: NormalizedToolResult,
	nativeImageInput: boolean,
): DeepSeekMessage['content'] {
	const hasImages = toolResult.parts.some((part) => part.type === 'image');
	if (!nativeImageInput || !hasImages) {
		const text = toolResult.parts
			.filter((part) => part.type === 'text')
			.map((part) => part.text)
			.join('');
		if (text) {
			return text;
		}

		// Do not stringify image bytes into a text-only model request. Preserve the
		// existing fallback for genuinely non-image tool-result content.
		const fallbackContent = hasImages
			? toolResult.parts.filter((part) => part.type === 'other').map((part) => part.value)
			: toolResult.originalContent;
		return fallbackContent.length > 0 ? safeStringify(fallbackContent) : '';
	}

	const content: DeepSeekContentPart[] = [];
	for (const part of toolResult.parts) {
		if (part.type === 'text') {
			content.push({ type: 'text', text: part.text });
		} else if (part.type === 'image') {
			content.push({
				type: 'image_url',
				image_url: { url: toImageDataUrl(part) },
			});
		}
	}
	return content;
}

function getReasoningContent(
	replayMarker: ReturnType<typeof parseFirstReplayMarker>,
	thinkingContent: string,
): string {
	if (replayMarker?.valid && replayMarker.reasoningText) {
		return replayMarker.reasoningText;
	}
	return thinkingContent;
}

function isLanguageModelThinkingPart(part: unknown): part is vscode.LanguageModelThinkingPart {
	return (
		typeof vscode.LanguageModelThinkingPart === 'function' &&
		part instanceof vscode.LanguageModelThinkingPart
	);
}

function normalizeThinkingPartText(value: string | string[]): string {
	return Array.isArray(value) ? value.join('') : value;
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' {
	switch (role) {
		case vscode.LanguageModelChatMessageRole.User:
			return 'user';
		case vscode.LanguageModelChatMessageRole.Assistant:
			return 'assistant';
		default:
			return 'user';
	}
}

function vscodeRoleName(
	role: vscode.LanguageModelChatMessageRole,
): 'user' | 'assistant' | 'system' {
	if (role === vscode.LanguageModelChatMessageRole.User) return 'user';
	if (role === vscode.LanguageModelChatMessageRole.Assistant) return 'assistant';
	return 'system';
}

export interface SourceSidecarEntry {
	index: number;
	vscodeRole: 'user' | 'assistant' | 'system';
	mappedRole: 'user' | 'assistant';
	parts: Array<{ kind: 'text' | 'image' | 'tool' | 'unknown'; chars: number }>;
	hostProven: false;
}

export interface SourceSidecar {
	schemaVersion: 1;
	entries: SourceSidecarEntry[];
}

/** convert 前角色/part 范围。hostProven 永不从标签推断。 */
export function buildSourceSidecar(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): SourceSidecar {
	return {
		schemaVersion: 1,
		entries: messages.map((message, index) => {
			const parts: SourceSidecarEntry['parts'] = [];
			for (const part of message.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					parts.push({ kind: 'text', chars: String(part.value || '').length });
				} else if (isImageDataPart(part)) {
					parts.push({ kind: 'image', chars: 0 });
				} else if (
					part instanceof vscode.LanguageModelToolCallPart ||
					part instanceof vscode.LanguageModelToolResultPart
				) {
					parts.push({ kind: 'tool', chars: 0 });
				} else {
					parts.push({ kind: 'unknown', chars: 0 });
				}
			}
			return {
				index,
				vscodeRole: vscodeRoleName(message.role),
				mappedRole: mapRole(message.role),
				parts,
				hostProven: false,
			};
		}),
	};
}

/**
 * Convert VS Code tool definitions to DeepSeek format.
 */
export function convertTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
): DeepSeekTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}

	return tools.map((tool) => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: toToolParameters(tool.inputSchema),
		},
	}));
}

/**
 * 把工具的 `inputSchema` 规整成一份合法的 JSON Schema 对象。
 *
 * 为什么必须兜底：VS Code 有 10 个内置工具不带 `inputSchema`（无参数工具，如
 * `terminal_last_command` / `activate_*_tools`），值是 `undefined`；序列化时
 * **值为 undefined 的键会被整个丢掉**，请求里这些工具就只剩 `name` +
 * `description`。DeepSeek 官方接口宽容（忽略），但严格校验的上游（NewAPI 中转的
 * 火山方舟通道等）直接 400：`tools[47].***.parameters must be valid JSON`。
 *
 * 策略：合法对象原样透传（对官方渠道零影响）；字符串先尝试 JSON.parse；其余
 * （undefined / null / 空串 / 非法串 / 数组）一律补空 object schema。
 */
export function toToolParameters(inputSchema: unknown): Record<string, unknown> {
	if (isPlainObject(inputSchema)) {
		return inputSchema;
	}
	if (typeof inputSchema === 'string') {
		try {
			const parsed: unknown = JSON.parse(inputSchema);
			if (isPlainObject(parsed)) {
				return parsed;
			}
		} catch {
			/* 非法 JSON → 落到空 schema */
		}
	}
	return { type: 'object', properties: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Count total characters across all messages to calibrate chars-per-token ratio.
 */
export function countMessageChars(messages: DeepSeekMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		total += getMessageContentChars(msg.content);
		total += msg.reasoning_content?.length ?? 0;
		if (msg.tool_calls) {
			for (const tc of msg.tool_calls) {
				total += tc.function?.name?.length ?? 0;
				total += tc.function?.arguments?.length ?? 0;
			}
		}
	}
	return total;
}

function getMessageContentChars(content: DeepSeekMessage['content']): number {
	if (typeof content === 'string') {
		return content.length;
	}

	let total = 0;
	for (const part of content) {
		if (part.type === 'text') {
			total += part.text.length;
		} else if (part.type === 'image_url') {
			// Do not count base64 URL chars. Native-image requests are excluded from
			// adaptive charsPerToken updates, and image cost is handled separately.
			total += 0;
		}
	}
	return total;
}
