/** 宿主压缩请求只复用同链常规轮已发出的技能目录；不处理历史消息。 */
import { createHash } from 'node:crypto';

type Message = { role?: string; content?: unknown };
type Snapshot = { rawHash: string; role: string; filtered: string };
const snapshots = new Map<string, Snapshot>();
const MAX_SNAPSHOTS = 32;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

function firstText(messages: unknown[]): string | null {
	const message = messages[0] as Message | undefined;
	// Copilot 的系统提示在部分版本会以第 0 条 user 消息出门。
	if (message?.role !== 'system' && message?.role !== 'user') return null;
	if (typeof message.content === 'string') return message.content;
	if (!Array.isArray(message.content) || message.content.length !== 1) return null;
	const part = message.content[0];
	return part?.type === 'text' && typeof part.text === 'string' ? part.text : null;
}

function setFirstText(message: Message, value: string): void {
	if (typeof message.content === 'string') message.content = value;
	else (message.content as Array<{ type: string; text: string }>)[0].text = value;
}

/** 只允许技能容器变化；容器外的系统指令必须逐字相同。 */
function onlySkillsChanged(raw: string, filtered: string): boolean {
	const open = '<skills>';
	const close = '</skills>';
	const rawStart = raw.indexOf(open);
	const filteredStart = filtered.indexOf(open);
	const rawEnd = raw.indexOf(close, rawStart + open.length);
	const filteredEnd = filtered.indexOf(close, filteredStart + open.length);
	if (rawStart < 0 || filteredStart < 0 || rawEnd < 0 || filteredEnd < 0) return false;
	if (raw.indexOf(open, rawEnd + close.length) >= 0) return false;
	if (filtered.indexOf(open, filteredEnd + close.length) >= 0) return false;
	// 常规过滤器只会把技能区后的连续空行收成两行；允许同一确定性格式化。
	return raw.slice(0, rawStart + open.length) === filtered.slice(0, filteredStart + open.length)
		&& raw.slice(rawEnd).replace(/\n{3,}/g, '\n\n') === filtered.slice(filteredEnd);
}

export function rememberFilteredSkills(key: string, before: unknown[], after: unknown[]): boolean {
	if (!key) return false;
	const raw = firstText(before);
	const filtered = firstText(after);
	const role = (before[0] as Message | undefined)?.role;
	if (role !== (after[0] as Message | undefined)?.role) return false;
	if (raw === null || filtered === null || raw === filtered || !onlySkillsChanged(raw, filtered)) return false;
	snapshots.delete(key);
	snapshots.set(key, { rawHash: hash(raw), role: role!, filtered });
	if (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
	return true;
}

export function applyRememberedSkills(key: string, messages: unknown[]): boolean {
	if (!key) return false;
	const raw = firstText(messages);
	const snapshot = snapshots.get(key);
	if (raw === null || !snapshot || (messages[0] as Message).role !== snapshot.role
		|| hash(raw) !== snapshot.rawHash) return false;
	if (!onlySkillsChanged(raw, snapshot.filtered)) return false;
	const message = messages[0] as Message;
	setFirstText(message, snapshot.filtered);
	return true;
}

/** 测试专用：模拟重载，证明无可信快照时不会猜测替换。 */
export function clearRememberedSkillsForTest(): void {
	snapshots.clear();
}
