import { normalizeSessionPaths } from './session-paths';
import vscode from 'vscode';
import { createHash } from 'node:crypto';
import { bindRequestTrace, recordStage } from '../send-receipt';
import { newRequestId, recordRequestEvent } from './request-events';
import { createChangesetCollector } from './request-changeset';
import { AuthManager } from '../auth';
import { DeepSeekClient } from '../client';
import {
	getApiModelId,
	getBaseUrl,
	getDebugMode,
	getMaxTokens,
	getRequestDumpEnabled,
} from '../config';
import { isOfficialDeepSeekBaseUrl } from '../endpoint';
import { getAllModels } from './custom-models';
import { t } from '../i18n';
import type { DeepSeekRequest } from '../types';
import { buildSourceSidecar, convertMessages, countMessageChars } from './convert';
import {
	dumpConvertedSnapshot,
	dumpDeepSeekRequest,
	type CacheDiagnosticsRecorder,
	type CacheDiagnosticsRun,
} from './debug';
import { getConfiguredThinkingEffort, type ModelConfigurationOptions } from './models';
import type { ReplayMarkerMetadata } from './replay';
import { buildReplayScope, hostSummaryReplay } from './replay/host-summary';
import {
	classifyDeepSeekRequest,
	classifyProviderRequest,
	shouldForceThinkingNone,
	type RequestKind,
} from './routing';
import type { ConversationSegment } from './segment';
import {
	applyHostSummarySkills,
	applyMessageFilter,
	logMessageComposition,
	workspaceIdentity,
} from './chat-hooks';
import type { MessageFilterContext } from './chat-hooks';
import {
	assessRequestBudget,
	assertRequestBudget,
	bindRequestBudget,
	DEFAULT_BUDGET_POLICY,
	type RequestBudgetPolicy,
} from '../request-budget';
import { LANGUAGE_MODEL_CHAT_SYSTEM_ROLE, MODELS } from '../consts';
import { estimateMessageChars } from './tokens';
import { makeFoldSummarize } from './fold-summarize';
import { collectTrailingToolResultIds, prepareRequestTools } from './tools/request';
import {
	finalizeVisionResolutionStats,
	prepareVisionMessages,
	type VisionDescriber,
} from './vision';

export interface PreparedChatRequest {
	restoreSessionArguments?: (args: string) => string;
	restoreSessionText?: (text: string) => string;
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
	requestId?: string;
	requestKind?: RequestKind;
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
	requestId = newRequestId(),
	requestKind: initialRequestKind,
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
	const initialKind =
		initialRequestKind ?? classifyProviderRequest({ messages, tools: options.tools });
	recordRequestEvent(requestId, 'PREPARE', initialKind);
	const apiKey = await authManager.getApiKey();
	if (!apiKey) {
		throw new Error(t('auth.notConfigured'));
	}

	const baseUrl = getBaseUrl();
	const client = new DeepSeekClient(baseUrl, apiKey);
	const modelDef = getAllModels().find((m) => m.id === modelInfo.id);
	if (!modelDef)
		throw Object.assign(new Error('Model budget is not configured'), {
			code: 'missing-request-budget',
		});
	const budgetPolicy: RequestBudgetPolicy = {
		maxInputTokens: modelDef.maxInputTokens,
		maxOutputTokens: modelDef.maxOutputTokens,
		maxContextTokens: MODELS.some((m) => m.id === modelDef.id)
			? modelDef.maxInputTokens + modelDef.maxOutputTokens
			: modelDef.maxInputTokens,
		imageTokens: DEFAULT_BUDGET_POLICY.imageTokens,
	};
	const thinkingCapability = modelDef.capabilities.thinking;
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
	const configuredThinkingEffort = thinkingCapability
		? getConfiguredThinkingEffort(options as ModelConfigurationOptions, thinkingCapability)
		: 'none';
	const replayScope = buildReplayScope(
		options,
		workspaceIdentity() || globalStorageUri.fsPath,
		JSON.stringify([modelInfo.id, tools, configuredThinkingEffort, maxTokens, nativeImageInput]),
		baseUrl,
		apiKey,
	);
	const replayTicket =
		initialKind === 'main-agent'
			? hostSummaryReplay.begin(replayScope, deepseekMessages)
			: undefined;
	try {
		const trace = {
			requestId,
			requestKind: initialKind,
			sessionRef: createHash('sha256')
				.update(segment.segmentId ?? 'unknown')
				.digest('hex'),
		};
		recordStage(trace, 'CONVERTED', deepseekMessages, tools);
		// G1（2026-09-19）：钩子动手之前的内容快照（只有 verbose 档写）——用来对账
		// 「钩子五步到底把哪些消息改成了什么」。指纹不够用时先看它。
		dumpConvertedSnapshot({
			requestId,
			globalStorageUri,
			segment,
			requestKind: initialKind,
			messages: deepseekMessages,
			tools,
		});
		// 本扩展内建钩子（顺序不可颠倒：第二个要看到第一个处理后的结果）
		// 折叠落盘钥匙在 chat-hooks 里拼：工作区|segmentId|模型。sid 不进钥匙。
		const apiModel = getApiModelId(modelInfo.id);
		// 实发比的分母：convert 之前的宿主口径（含 convert 阶段会丢掉的那一刀）
		const hostMessageChars = estimateMessageChars(messages);
		// 宿主 System=3 是非公开枚举；只依据明确角色保护转换后的前缀。
		const firstNonSystem = resolvedMessages.findIndex(
			(m) => Number(m.role) !== LANGUAGE_MODEL_CHAT_SYSTEM_ROLE,
		);
		const systemPrefix = resolvedMessages.slice(
			0,
			firstNonSystem < 0 ? resolvedMessages.length : firstNonSystem,
		);
		const protectedPrefixCount = Math.max(
			deepseekMessages[0]?.role === 'user' ? 1 : 0,
			convertMessages(systemPrefix, isThinkingModel, nativeImageInput).length,
		);
		const filterAbort = new AbortController();
		// G2/G3（2026-09-19）：钩子五步的变化指纹 → 一条 REQUEST_CHANGESET。
		// 开关：verbose 档自动开；其他档要开就设 DEEPSEEK_CHANGESET=1。
		// ⛔ 关闭时必须传 undefined（不是空函数）：钩子只看 typeof === 'function'，
		// 传空函数会让钩子白算 10 次全量快照（独立审查 MAJOR-1，2026-09-19）。
		// minimal 档不收集：就算设了 DEEPSEEK_CHANGESET=1，事件也会被档位门丢掉（复审 MINOR-1）。
		const changesetEnabled =
			getRequestDumpEnabled() ||
			(process.env.DEEPSEEK_CHANGESET === '1' && getDebugMode() !== 'minimal');
		const changeset = createChangesetCollector({
			requestId,
			requestKind: initialKind,
			enabled: changesetEnabled,
		});
		const filterCancel =
			token && typeof token.onCancellationRequested === 'function'
				? token.onCancellationRequested(() => filterAbort.abort())
				: { dispose() {} };
		try {
			const filterContext: MessageFilterContext = {
				requestId,
				hostSummaryKey: replayScope,
				segment,
				model: apiModel,
				tools,
				signal: filterAbort.signal,
				summarize: makeFoldSummarize(client, apiModel, token, tools, requestId, budgetPolicy),
				protectedPrefixCount,
				fitsBudget: (candidate) =>
					assessRequestBudget(
						{
							model: apiModel,
							messages: candidate as DeepSeekRequest['messages'],
							stream: true,
							tools,
							tool_choice: tools?.length ? 'auto' : undefined,
							max_tokens: maxTokens,
							...(isThinkingModel
								? { thinking: { type: 'enabled' as const }, reasoning_effort: 'max' as const }
								: {}),
							stream_options: { include_usage: true },
						} as DeepSeekRequest,
						budgetPolicy,
					).ok,
				sourceSidecar,
				hostMessageChars,
				reportStep: changesetEnabled ? changeset.reportStep : undefined,
			};
			if (initialKind === 'host-summary') {
				const replay = await hostSummaryReplay.recover(replayScope, deepseekMessages, token);
				if (replay.messages)
					deepseekMessages.splice(0, deepseekMessages.length, ...replay.messages);
				applyHostSummarySkills(deepseekMessages, filterContext);
				recordRequestEvent(
					requestId,
					`HOST_SUMMARY_REPLAY_${replay.status.toUpperCase()}`,
					initialKind,
					undefined,
					undefined,
					{ itemCount: replay.restored },
				);
				// 无证据时保留宿主原文并让既有预算检查裁决；绝不改主聊天缓存。
			} else {
				await applyMessageFilter(deepseekMessages, filterContext);
			}
		} finally {
			filterCancel.dispose();
		}
		recordStage(trace, 'FILTERED_CANDIDATE', deepseekMessages, tools);
		changeset.finish();
		logMessageComposition(deepseekMessages, tools);
		finalizeVisionResolutionStats(visionResolution.stats, deepseekMessages);

		const outbound = normalizeSessionPaths(deepseekMessages);
		// 本地只记计数，不把诊断数据和真实路径放进模型请求。
		for (const [eventCode, itemCount] of [
			['SESSION_PATH_NORMALIZED', outbound.stats.normalizedPaths],
			['SESSION_PATH_DISTINCT', outbound.stats.distinctPaths],
			['SESSION_PATH_FOREIGN', outbound.stats.foreignAliases],
			['SESSION_PATH_COLLISION', outbound.stats.collisionPaths],
			['SESSION_PATH_INVALID_ARGUMENTS', outbound.stats.invalidToolArguments],
		] as const) {
			if (itemCount > 0)
				recordRequestEvent(requestId, eventCode, initialKind, undefined, undefined, { itemCount });
		}
		const totalRequestChars = countMessageChars(outbound.messages);
		const hasNativeImages =
			visionResolution.stats.imageHandlingMode === 'native' &&
			visionResolution.stats.input.forwardedImageParts +
				visionResolution.stats.tool.forwardedImageParts >
				0;
		const baseRequest: DeepSeekRequest = {
			model: getApiModelId(modelInfo.id),
			messages: outbound.messages,
			stream: true,
			tools,
			tool_choice: tools && tools.length > 0 ? ('auto' as const) : undefined,
			max_tokens: maxTokens,
		};
		const requestKind = classifyDeepSeekRequest({
			request: baseRequest,
			inputMessages: messages,
		});
		if (requestKind !== initialKind)
			recordRequestEvent(requestId, 'REQUEST_KIND_RESOLVED', requestKind);
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
		bindRequestBudget(request, budgetPolicy);
		bindRequestTrace(request, { ...trace, requestKind });
		assertRequestBudget(request);
		if (!token?.isCancellationRequested) hostSummaryReplay.complete(replayTicket, deepseekMessages);
		else hostSummaryReplay.fail(replayTicket);
		dumpDeepSeekRequest(request, {
			requestId,
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
			restoreSessionArguments: outbound.restoreArguments,
			restoreSessionText: outbound.restoreText,
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
			replayMarkerMetadata: {
				...visionResolution.replayMarkerMetadata,
				segmentId: segment.segmentId,
			},
			visionMarkerTextChars: visionResolution.stats.markerVisionTextChars || undefined,
			initialResponseNotice: visionResolution.initialResponseNotice,
		};
	} catch (error) {
		hostSummaryReplay.fail(replayTicket);
		throw error;
	}
}
