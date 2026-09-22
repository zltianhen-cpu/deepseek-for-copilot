import vscode from 'vscode';
import { t } from '../../i18n';
import type { DeepSeekMessage, DeepSeekTool } from '../../types';
import { convertTools } from '../convert';
import { DEEPSEEK_TOOLS_LIMIT } from './consts';

// VS Code 1.136 在会话中会让此内建工具忽隐忽现。工具定义排在模型缓存的前段，
// 因此只在宿主已经提供正常 Agent 工具集时，补齐同一份稳定定义。
const MERMAID_TOOL_NAME = 'renderMermaidDiagram';
const MERMAID_TOOL: DeepSeekTool = {
	type: 'function',
	function: {
		name: MERMAID_TOOL_NAME,
		description: 'Renders a Mermaid diagram from Mermaid.js markup.',
		parameters: {
			type: 'object',
			properties: {
				markup: {
					type: 'string',
					description:
						'The mermaid diagram markup to render as a Mermaid diagram. This should only be the markup of the diagram. Do not include a wrapping code block.',
				},
				title: {
					type: 'string',
					description: 'A short title that describes the diagram.',
				},
			},
		},
	},
};

export function prepareRequestTools(
	toolCallingCapability: boolean | number | undefined,
	options: vscode.ProvideLanguageModelChatResponseOptions,
): DeepSeekTool[] | undefined {
	const converted = toolCallingCapability ? convertTools(options.tools) : undefined;
	const tools = stabilizeMermaidTool(converted);
	const toolLimit = getToolCallingLimit(toolCallingCapability);
	const toolsCount = tools?.length ?? 0;
	if (toolsCount > toolLimit) {
		throw new Error(t('request.toolsLimitExceeded', toolLimit, toolsCount));
	}
	return tools;
}

function stabilizeMermaidTool(tools: DeepSeekTool[] | undefined): DeepSeekTool[] | undefined {
	if (!tools?.some((tool) => tool.function.name === 'run_in_terminal')) {
		return tools;
	}
	const result = [...tools];
	const nativeIndex = result.findIndex((tool) => tool.function.name === MERMAID_TOOL_NAME);
	if (nativeIndex >= 0) {
		result[nativeIndex] = MERMAID_TOOL;
		return result;
	}
	// 宿主实际顺序中，缺件时 run_in_terminal 占据画图工具原本的位置。
	const insertAt = result.findIndex((tool) => tool.function.name === 'run_in_terminal');
	result.splice(insertAt, 0, MERMAID_TOOL);
	return result;
}

export function collectTrailingToolResultIds(messages: readonly DeepSeekMessage[]): string[] {
	const trailingToolResultIds: string[] = [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== 'tool' || !message.tool_call_id) {
			break;
		}
		trailingToolResultIds.push(message.tool_call_id);
	}
	return trailingToolResultIds.reverse();
}

function getToolCallingLimit(toolCallingCapability: boolean | number | undefined): number {
	return typeof toolCallingCapability === 'number' ? toolCallingCapability : DEEPSEEK_TOOLS_LIMIT;
}
