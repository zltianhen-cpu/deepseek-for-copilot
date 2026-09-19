/** 用途：HTTP边界的无正文发送回执；候选、尝试、接收和官方usage分开记录。 */
import { createHash } from 'node:crypto';
import { safeStringify } from './json';
import type { DeepSeekUsage } from './types';
import { newRequestId, recordRequestEvent } from './provider/request-events';

export interface RequestTrace {
	requestId: string;
	requestKind: string;
	parentRequestId?: string;
	sessionRef?: string;
}
const traces = new WeakMap<object, Readonly<RequestTrace>>();
export function bindRequestTrace<T extends object>(request: T, trace: RequestTrace): T {
	traces.set(request, Object.freeze({ ...trace }));
	return request;
}
export function requestTrace(request: object): Readonly<RequestTrace> | undefined {
	return traces.get(request);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function recordStage(
	trace: RequestTrace,
	code: string,
	messages: unknown[],
	tools?: unknown,
): void {
	try {
		const digests = messages.map((m) => hash(safeStringify(m)));
		recordRequestEvent(trace.requestId, code, trace.requestKind, trace.parentRequestId, undefined, {
			historyHash: hash(safeStringify(messages)),
			schemaHash: hash(safeStringify(tools ?? [])),
			itemCount: messages.length,
			sessionRef: trace.sessionRef,
		});
		// 分页记录完整逐消息指纹，单条<=20项以适配既有日志隐私/体积限制。
		for (let i = 0; i < digests.length; i += 20)
			recordRequestEvent(
				trace.requestId,
				code + '_ITEMS',
				trace.requestKind,
				trace.parentRequestId,
				undefined,
				{ offset: i, fingerprints: digests.slice(i, i + 20) },
			);
	} catch {
		/* 指纹诊断不影响聊天。 */
	}
}
export function createSendReceipt(request: object) {
	const trace = traces.get(request) ?? { requestId: newRequestId(), requestKind: 'unknown' };
	let attempted = false,
		observed = false;
	const emit = (code: string, usage?: Record<string, unknown>, details?: Record<string, unknown>) =>
		recordRequestEvent(trace.requestId, code, trace.requestKind, trace.parentRequestId, usage, {
			sessionRef: trace.sessionRef,
			...details,
		});
	return {
		start(serialized: string) {
			const wire = JSON.parse(serialized);
			emit('WIRE_CANDIDATE', undefined, {
				wireHash: hash(serialized),
				historyHash: hash(safeStringify(wire.messages)),
				schemaHash: hash(safeStringify(wire.tools ?? [])),
				wireBytes: Buffer.byteLength(serialized),
			});
			attempted = true;
			emit('SEND_ATTEMPT');
		},
		accepted(status: number) {
			emit('HTTP_ACCEPTED', undefined, { httpStatus: status });
		},
		usage(usage?: DeepSeekUsage) {
			if (!usage || observed) return;
			observed = true;
			emit('USAGE_OBSERVED', {
				input: usage.prompt_tokens,
				output: usage.completion_tokens,
				hit: usage.prompt_cache_hit_tokens,
				miss: usage.prompt_cache_miss_tokens,
			});
		},
		failed() {
			emit(attempted ? 'REQUEST_SEND_FAILED' : 'REQUEST_REJECTED');
		},
		finish(cancelled = false) {
			if (attempted) {
				if (cancelled) emit('REQUEST_CANCELLED');
				if (!observed) emit('USAGE_UNAVAILABLE');
			}
		},
	};
}
