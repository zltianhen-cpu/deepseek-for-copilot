/** 用途：兼容旧字符安全闸，只读阻断；最终 HTTP 边界另有完整请求预算。 */
import type { DeepSeekMessage } from '../types';
import { t } from '../i18n';
import { countMessageChars } from './convert';

export const OUTBOUND_GATE_ENABLED = true;
export const OUTBOUND_GATE_CHARS = 1_050_000;
/** 仅保留导出兼容；不再按该值删除任何消息。 */
export const OUTBOUND_GATE_TARGET_CHARS = 700_000;

export interface OutboundGateReport {
	ok: boolean;
	applied: boolean;
	beforeChars: number;
	afterChars: number;
	droppedMessages: number;
	droppedImages: number;
	reason: 'within-limit' | 'cannot-reduce';
}

/** 超线即拒绝，不截尾；数组与消息对象身份、内容均保持不变。 */
export function applyOutboundGate(messages: DeepSeekMessage[]): OutboundGateReport {
	const beforeChars = countMessageChars(messages);
	const ok = !OUTBOUND_GATE_ENABLED || beforeChars <= OUTBOUND_GATE_CHARS;
	return {
		ok,
		applied: false,
		beforeChars,
		afterChars: beforeChars,
		droppedMessages: 0,
		droppedImages: 0,
		reason: ok ? 'within-limit' : 'cannot-reduce',
	};
}

export function enforceOutboundGate(messages: DeepSeekMessage[]): OutboundGateReport {
	const report = applyOutboundGate(messages);
	if (!report.ok) {
		throw Object.assign(
			new Error(t('request.outboundGateExceeded', report.beforeChars, OUTBOUND_GATE_CHARS)),
			{
				code: 'outbound-gate-exceeded',
			},
		);
	}
	return report;
}
