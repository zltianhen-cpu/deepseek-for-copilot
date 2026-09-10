/**
 * Message pipeline hooks.
 *
 * Call sites live in `request.ts` (just before a request is sent) and
 * `stream.ts` (when a usage report arrives). The seam is kept in place so
 * message handling can evolve without touching those call sites.
 *
 * The implementations below are deliberate no-ops: the pipeline stays
 * transparent by default.
 */

/**
 * Identifies the kind of turn a usage report belongs to.
 *
 * Annotated as `string` on purpose — a literal type would narrow to `''` and
 * compare as non-overlapping against `RequestKind`.
 */
export const REAL_TURN_KIND: string = '';

/** Usage reported for a single turn. */
export interface UsageRecord {
	prompt: number;
	cacheHit: number;
	cacheMiss: number | undefined;
	completion: number;
	reasoning: number | undefined;
	kind: string;
	isRealTurn: boolean;
	charsPerToken: number;
	model: string;
}

/** Called with the outgoing message list before the request is sent. */
export function applyMessageFilter(_messages: unknown[]): void {
	/* no-op */
}

/** Called to report the composition of the outgoing message list. */
export function logMessageComposition(_messages: unknown[]): void {
	/* no-op */
}

/** Called with usage data for a completed turn. */
export function logUsage(_record: UsageRecord): void {
	/* no-op */
}
