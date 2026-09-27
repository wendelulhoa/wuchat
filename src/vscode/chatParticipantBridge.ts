/*---------------------------------------------------------------------------------------------
 *  Wuchat participant for VS Code Chat. Browser Add Element to Chat supplies
 *  context as ChatRequest.references through this public extension API.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatController } from '../chat/controllers/ChatController';
import { AgentManager } from '../agents/AgentManager';
import { ChatAttachment, RequestContext } from '../common/types';
import { Logger } from '../common/logger';

const MAX_REFERENCE_CHARS = 60_000;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

export function registerVsCodeChatBridge(
	controller: ChatController,
	agentManager: AgentManager,
	logger: Logger,
	onChange?: () => void
): vscode.Disposable[] {
	const enabled = vscode.workspace.getConfiguration('wuchat').get<boolean>('bridge.enableVsCodeChat', true);
	if (!enabled) return [];

	let participant: vscode.ChatParticipant;
	try {
		participant = vscode.chat.createChatParticipant('wuchat.chat', async (request, chatContext, response, token) => {
			void chatContext;
			const stream = new ChatResponseStreamAdapter(response);
			const agent = agentManager.defaultAgent;
			const context = await collectReferences(request.references, logger);
			stream.markdown(`**Wuchat (${agent.name})**\n\n`);
			const cancellation = token.onCancellationRequested(() => controller.cancel());
			try {
				await controller.send(
					request.prompt || 'Analyze the attached context.',
					{ agentId: agent.id, context },
					{
						onUserMessage: () => { /* already echoed by VS Code Chat */ },
						onAssistantDone: message => stream.markdown(message.content + '\n'),
						onError: text => stream.markdown(`\n\n⚠️ ${text}\n`)
					}
				);
			} finally {
				cancellation.dispose();
				onChange?.();
			}
		});
	} catch (err) {
		logger.warn('Unable to register the wuchat.chat participant.', err instanceof Error ? err.message : err);
		return [];
	}

	participant.iconPath = vscode.Uri.joinPath(vscode.extensions.getExtension('wuchat.wuchat')?.extensionUri ?? vscode.Uri.file(''), 'media', 'icon.svg');
	return [participant];
}

async function collectReferences(references: readonly vscode.ChatPromptReference[], logger: Logger): Promise<RequestContext> {
	const attachments: ChatAttachment[] = [];
	const notes: string[] = [];
	let remaining = MAX_REFERENCE_CHARS;
	for (const reference of references) {
		const value = reference.value;
		const label = reference.modelDescription || reference.id || 'Chat context';
		if (typeof value === 'string') {
			const excerpt = value.slice(0, remaining);
			if (excerpt) notes.push(`${label}:\n${excerpt}`);
			remaining -= excerpt.length;
		} else if (value instanceof vscode.Location) {
			const uri = value.uri;
			const range = value.range;
			try {
				const document = await vscode.workspace.openTextDocument(uri);
				const selected = document.getText(range).slice(0, remaining);
				if (selected) notes.push(`${label} (${uri.toString()}):\n${selected}`);
				remaining -= selected.length;
			} catch (err) {
				logger.warn('Could not read chat location reference', err instanceof Error ? err.message : err);
			}
		} else if (value instanceof vscode.Uri) {
			try {
				const data = await vscode.workspace.fs.readFile(value);
				if (data.byteLength > MAX_ATTACHMENT_BYTES) continue;
				const name = value.path.split('/').at(-1) || label;
				const extension = name.split('.').at(-1)?.toLowerCase();
				const mimeType = extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : 'text/plain';
				attachments.push({ name, uri: value.toString(), mimeType, data: new Uint8Array(data), ...(mimeType === 'text/plain' ? { text: new TextDecoder().decode(data) } : {}) });
			} catch (err) {
				logger.warn('Could not read chat URI reference', err instanceof Error ? err.message : err);
			}
		} else if (reference.modelDescription && remaining > 0) {
			const excerpt = reference.modelDescription.slice(0, remaining);
			notes.push(excerpt);
			remaining -= excerpt.length;
		}
		if (remaining <= 0) break;
	}
	return { attachments, ...(notes.length ? { notes: notes.join('\n\n') } : {}) };
}

class ChatResponseStreamAdapter {
	constructor(private readonly stream: vscode.ChatResponseStream) { }
	markdown(value: string): void { this.stream.markdown(new vscode.MarkdownString(value)); }
}
