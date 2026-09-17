import vscode from 'vscode';
import { newRequestId, recordRequestEvent } from './request-events';
import { AuthManager } from '../auth';
import { DeepSeekClient } from '../client';
import { getApiModelId, getBaseUrl, getMaxTokens } from '../config';
import { MODELS } from '../consts';
import { isOfficialDeepSeekBaseUrl } from '../endpoint';
import { t } from '../i18n';
import type { DeepSeekRequest } from '../types';
import { buildSourceSidecar, convertMessages, countMessageChars } from './convert';
import {
	dumpDeepSeekRequest,
	type CacheDiagnosticsRecorder,
	type CacheDiagnosticsRun,
} from './debug';
import { getConfiguredThinkingEffort, type ModelConfigurationOptions } from './models';
import type { ReplayMarkerMetadata } from './replay';
import { classifyDeepSeekRequest, shouldForceThinkingNone, type RequestKind } from './routing';
import type { ConversationSegment } from './segment';
import { applyMessageFilter, logMessageComposition } from './chat-hooks';
import { makeFoldSummarize } from './fold-summarize';
import { collectTrailingToolResultIds, prepareRequestTools } from './tools/request';
import {
	finalizeVisionResolutionStats,
	prepareVisionMessages,
	type VisionDescriber,
} from './vision';

export interface PreparedChatRequest {
	requestId: string;
	client: DeepSeekClient;
	request: DeepSeekRequest;
	isThinkingModel: boolean;
	totalRequestChars: number;
	hasNativeImages: boolean;
	trailingToolResultIds: string[];
	cacheDiagnostics: CacheDiagnosticsRun;
	requestKind: RequestKind;
	segment: ConversationSegment;
	replayMarkerMetadata: ReplayMarkerMetadata;
	visionMarkerTextChars?: number;
	initialResponseNotice?: string;
}

export interface PrepareChatRequestOptions {
	authManager: AuthManager;
	globalStorageUri: vscode.Uri;
	modelInfo: vscode.LanguageModelChatInformation;
	segment: ConversationSegment;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	options: vscode.ProvideLanguageModelChatResponseOptions;
	token: vscode.CancellationToken;
	cacheDiagnostics: CacheDiagnosticsRecorder;
	getVisionDescriber: () => Promise<VisionDescriber | undefined>;
}

export async function prepareChatRequest({
	authManager,
	globalStorageUri,
	modelInfo,
	segment,
	messages,
	options,
	token,
	cacheDiagnostics,
	getVisionDescriber,
}: PrepareChatRequestOptions): Promise<PreparedChatRequest> {
	const requestId = newRequestId();
	recordRequestEvent(requestId, 'PREPARE', 'main-agent');
	const apiKey = await authManager.getApiKey();
	if (!apiKey) {
		throw new Error(t('auth.notConfigured'));
	}

	const baseUrl = getBaseUrl();
	const client = new DeepSeekClient(baseUrl, apiKey);
	const modelDef = MODELS.find((m) => m.id === modelInfo.id);
	const thinkingCapability = modelDef?.capabilities.thinking;
	const isThinkingModel = Boolean(thinkingCapability);
	const nativeImageInput = modelDef?.capabilities.nativeImageInput === true;
	const maxTokens = getMaxTokens();
	const visionResolution = await prepareVisionMessages({
		messages,
		nativeImageInput,
		token,
		getDescriber: getVisionDescriber,
	});

	const resolvedMessages = visionResolution.messages;

	const sourceSidecar = buildSourceSidecar(resolvedMessages);
	const deepseekMessages = convertMessages(resolvedMessages, isThinkingModel, nativeImageInput);
	// 工具 schema 排在 messages 之前，同属 provider 前缀：schema 一变缓存全断，
	// 而 system 提示可能一个字没动。故在钩子之前先备好 tools 并交给探针做指纹。
	// （prepareRequestTools 只依赖 modelDef/options，上移无副作用）
	const tools = prepareRequestTools(modelDef?.capabilities.toolCalling, options);
	// 本扩展内建钩子（顺序不可颠倒：第二个要看到第一个处理后的结果）
	// 折叠落盘钥匙在 chat-hooks 里拼：工作区|segmentId|模型。sid 不进钥匙。
	const apiModel = getApiModelId(modelInfo.id);
	await applyMessageFilter(deepseekMessages, {
		requestId,
		segment,
		model: apiModel,
		tools,
		summarize: makeFoldSummarize(client, apiModel, token, tools, requestId),
		sourceSidecar,
	});
	logMessageComposition(deepseekMessages, tools);
	finalizeVisionResolutionStats(visionResolution.stats, deepseekMessages);

	const totalRequestChars = countMessageChars(deepseekMessages);
	const hasNativeImages =
		visionResolution.stats.imageHandlingMode === 'native' &&
		visionResolution.stats.input.forwardedImageParts +
			visionResolution.stats.tool.forwardedImageParts >
			0;
	const baseRequest: DeepSeekRequest = {
		model: getApiModelId(modelInfo.id),
		messages: deepseekMessages,
		stream: true,
		tools,
		tool_choice: tools && tools.length > 0 ? ('auto' as const) : undefined,
		max_tokens: maxTokens,
	};
	const requestKind = classifyDeepSeekRequest({
		request: baseRequest,
		inputMessages: messages,
	});
	const configuredThinkingEffort = thinkingCapability
		? getConfiguredThinkingEffort(options as ModelConfigurationOptions, thinkingCapability)
		: 'none';
	// Only force helper requests into disabled thinking on the official API.
	// Custom endpoints keep their configured effort to preserve pre-#137 request shape.
	const forceNoneThinking =
		shouldForceThinkingNone(requestKind) && isOfficialDeepSeekBaseUrl(baseUrl);
	const thinkingEffort = forceNoneThinking ? 'none' : configuredThinkingEffort;
	const request: DeepSeekRequest = {
		...baseRequest,
		...(isThinkingModel
			? {
					thinking: {
						type: thinkingEffort === 'none' ? ('disabled' as const) : ('enabled' as const),
					},
					...(thinkingEffort === 'none' ? {} : { reasoning_effort: thinkingEffort }),
				}
			: {}),
	};
	dumpDeepSeekRequest(request, {
		globalStorageUri,
		segment,
		requestKind,
		vscodeModelId: modelInfo.id,
		isThinkingModel,
		thinkingEffort,
		maxTokens,
		inputMessages: messages,
		resolvedMessages,
		requestOptions: options,
		visionModelId: visionResolution.visionModelId,
		visionProxySource: visionResolution.visionProxySource,
		visionStats: visionResolution.stats,
	});

	const diagnosticsRun = cacheDiagnostics.beginRequest({
		request,
		segment,
		requestKind,
		vscodeModelId: modelInfo.id,
		isThinkingModel,
		thinkingEffort,
		maxTokens,
		inputMessages: messages,
		resolvedMessages,
		visionModelId: visionResolution.visionModelId,
		visionProxySource: visionResolution.visionProxySource,
		visionStats: visionResolution.stats,
	});

	return {
		requestId,
		client,
		request,
		isThinkingModel,
		totalRequestChars,
		hasNativeImages,
		trailingToolResultIds: collectTrailingToolResultIds(deepseekMessages),
		cacheDiagnostics: diagnosticsRun,
		requestKind,
		segment,
		replayMarkerMetadata: { ...visionResolution.replayMarkerMetadata, segmentId: segment.segmentId },
		visionMarkerTextChars: visionResolution.stats.markerVisionTextChars || undefined,
		initialResponseNotice: visionResolution.initialResponseNotice,
	};
}
