import { readErrorSummary } from '../provider/request-events';
import vscode from 'vscode';
import { CONFIG_SECTION, EXTERNAL_URLS } from '../consts';
import { t } from '../i18n';
import { logger } from '../logger';
import { ensureRequestDumpRoot } from '../provider/debug';

export function registerCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('deepseek-fork.showErrorSummary', showErrorSummary),
		vscode.commands.registerCommand('deepseek-fork.showLogs', () => logger.show()),
		vscode.commands.registerCommand('deepseek-fork.openRequestDumpsFolder', () =>
			openRequestDumpsFolder(context),
		),
		vscode.commands.registerCommand('deepseek-fork.getApiKey', () =>
			vscode.env.openExternal(vscode.Uri.parse(EXTERNAL_URLS.deepseek.apiKeys)),
		),
		vscode.commands.registerCommand('deepseek-fork.openSettings', () =>
			vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION),
		),
	);
}

async function openRequestDumpsFolder(context: vscode.ExtensionContext): Promise<void> {
	try {
		const root = await ensureRequestDumpRoot(context.globalStorageUri);
		logger.info(`Opening request dumps folder: ${root.toString(true)}`);
		await vscode.commands.executeCommand('revealFileInOS', root);
	} catch (error) {
		logger.warn('Failed to open request dumps folder', error);
		void vscode.window.showErrorMessage(t('extension.openRequestDumpsFolderFailed'));
	}
}

async function showErrorSummary(): Promise<void> {
	const since = await vscode.window.showInputBox({ prompt: '起始时间（ISO 格式，留空全部）' });
	if (since === undefined) return;
	if (since && !Number.isFinite(Date.parse(since))) {
		await vscode.window.showErrorMessage('时间格式无效');
		return;
	}
	const requestId = await vscode.window.showInputBox({
		prompt: '请求 ID（留空全部，包含关联摘要请求）',
	});
	if (requestId === undefined) return;
	const eventCode = await vscode.window.showInputBox({ prompt: '事件代码（留空全部错误）' });
	if (eventCode === undefined) return;
	const result = readErrorSummary({ since, requestId, eventCode, includeInfo: Boolean(requestId) });
	const labels = {
		ok: '读取成功',
		missing: '日志目录尚未生成',
		disabled: '日志当前已关闭（下方为已有历史）',
		partial: '读取不完整',
		unreadable: '日志无法读取',
	};
	const status = `${labels[result.status]}；坏行 ${result.badLines}；不可读文件 ${result.unreadableFiles}；截断/跳过 ${result.truncated}`;
	const doc = await vscode.workspace.openTextDocument({
		language: 'plaintext',
		content:
			status +
			'\n' +
			(result.rows.length
				? result.rows.map((r) => JSON.stringify(r)).join('\n')
				: result.status === 'ok'
					? '没有匹配的记录。'
					: '本次未取得匹配记录；不能据此判断没有错误。'),
	});
	await vscode.window.showTextDocument(doc);
}
