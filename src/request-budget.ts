/** 用途：纯只读请求预算；按字符加权保守估算（CJK≈1、其余÷4、乘安全系数），绝不删改请求或声称官方精确计数。 */
import { safeStringify } from './json';
import type { DeepSeekRequest } from './types';

export interface RequestBudgetPolicy {
	maxInputTokens: number;
	maxContextTokens: number;
	maxOutputTokens: number;
	imageTokens: number;
}

export const DEFAULT_BUDGET_POLICY: Readonly<RequestBudgetPolicy> = Object.freeze({
	maxInputTokens: 655_360,
	maxContextTokens: 1_048_576,
	maxOutputTokens: 393_216,
	imageTokens: 16_384,
});

export interface RequestBudgetAssessment {
	ok: boolean;
	reason: 'within-limit' | 'input-limit' | 'output-limit' | 'context-limit';
	estimatedInputTokens: number;
	outputTokens: number;
	maxInputTokens: number;
	maxContextTokens: number;
	maxOutputTokens: number;
	messageTokens: number;
	toolTokens: number;
	otherTokens: number;
	imageTokens: number;
	imageCount: number;
	structureTokens: number;
	estimateMethod: 'weighted-cjk-safety-v1';
	isOfficialTokenCount: false;
}

const policies = new WeakMap<object, Readonly<RequestBudgetPolicy>>();

function positiveInteger(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw Object.assign(
			new Error(`Invalid request budget: ${field} must be a finite positive safe integer`),
			{
				code: 'invalid-request-budget',
			},
		);
	}
}

function validatedPolicy(policy: RequestBudgetPolicy): Readonly<RequestBudgetPolicy> {
	const snapshot = {
		maxInputTokens: policy?.maxInputTokens,
		maxContextTokens: policy?.maxContextTokens,
		maxOutputTokens: policy?.maxOutputTokens,
		imageTokens: policy?.imageTokens,
	};
	for (const [key, value] of Object.entries(snapshot)) positiveInteger(value, key);
	return Object.freeze(snapshot);
}

/** 策略存于进程内；冻结快照防调用方后续无意放宽，不增加 API 字段。 */
export function bindRequestBudget<T extends object>(request: T, policy: RequestBudgetPolicy): T {
	policies.set(request, validatedPolicy(policy));
	return request;
}

export function getRequestBudgetPolicy(request: object): Readonly<RequestBudgetPolicy> {
	const policy = policies.get(request);
	if (!policy)
		throw Object.assign(new Error('Missing explicit request budget'), {
			code: 'missing-request-budget',
		});
	return policy;
}

const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g;
const TOKEN_SAFETY = 1.25;

function weightOf(text: string): number {
	if (!text) return 0;
	const cjk = (text.match(CJK_RE) || []).length;
	return cjk + (text.length - cjk) / 4;
}

function byteEstimate(value: unknown): number {
	return Math.ceil(weightOf(safeStringify(value)) * TOKEN_SAFETY);
}

/** 按字符加权计 token，加结构余量；图片按策略预留，非官方图片 token 上界。 */
export function assessRequestBudget(
	request: DeepSeekRequest,
	policy: RequestBudgetPolicy = getRequestBudgetPolicy(request),
): RequestBudgetAssessment {
	const limits = validatedPolicy(policy);
	const outputTokens =
		request.max_tokens === undefined ? limits.maxOutputTokens : request.max_tokens;
	positiveInteger(outputTokens, 'max_tokens');
	let imageCount = 0;
	const messages = request.messages.map((message) => {
		if (!Array.isArray(message.content)) return message;
		return {
			...message,
			content: message.content.map((part) => {
				if (part.type !== 'image_url') return part;
				imageCount += 1;
				return { ...part, image_url: { ...part.image_url, url: '' } };
			}),
		};
	});
	const { messages: _messages, tools, ...other } = request;
	const messageTokens = byteEstimate(messages);
	const toolTokens = tools ? byteEstimate(tools) : 0;
	const otherTokens = byteEstimate(other);
	const imageTokens = imageCount * limits.imageTokens;
	const structureTokens = 128 + messages.length * 32 + (tools?.length ?? 0) * 64;
	const estimatedInputTokens =
		messageTokens + toolTokens + otherTokens + imageTokens + structureTokens;
	const reason =
		outputTokens > limits.maxOutputTokens
			? 'output-limit'
			: estimatedInputTokens > limits.maxInputTokens
				? 'input-limit'
				: estimatedInputTokens + outputTokens > limits.maxContextTokens
					? 'context-limit'
					: 'within-limit';
	return {
		ok: reason === 'within-limit',
		reason,
		estimatedInputTokens,
		outputTokens,
		maxInputTokens: limits.maxInputTokens,
		maxContextTokens: limits.maxContextTokens,
		maxOutputTokens: limits.maxOutputTokens,
		messageTokens,
		toolTokens,
		otherTokens,
		imageTokens,
		imageCount,
		structureTokens,
		estimateMethod: 'weighted-cjk-safety-v1',
		isOfficialTokenCount: false,
	};
}

export function assertRequestBudget(
	request: DeepSeekRequest,
	policy?: RequestBudgetPolicy,
): RequestBudgetAssessment {
	const assessment = assessRequestBudget(request, policy);
	if (!assessment.ok) {
		throw Object.assign(
			new Error(
				`Request budget exceeded (${assessment.reason}): estimated input ${assessment.estimatedInputTokens}, output reserve ${assessment.outputTokens}`,
			),
			{
				code: 'request-budget-exceeded',
				assessment,
			},
		);
	}
	return assessment;
}
