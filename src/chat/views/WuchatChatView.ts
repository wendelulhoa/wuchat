/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  The chat lives in Wuchat's Activity Bar and consumes only Wuchat services.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { mkdir as mkdirAsync, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { ChatAttachment, ChatMessage, RequestContext } from '../../common/types';
import { Logger } from '../../common/logger';
import { ChatController } from '../controllers/ChatController';
import { ChatSession } from '../sessions/ChatSession';
import { AgentManager } from '../../agents/AgentManager';
import { ProviderRegistry } from '../../llm/ProviderRegistry';
import { getActiveSelection, openWorkspaceFile } from '../../vscode/workspaceBridge';
import { WuchatBrowser } from '../../browser/WuchatBrowser';
import { ToolRegistry } from '../../tools/ToolRegistry';

const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.mdx', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.scss', '.py', '.java', '.kt', '.go', '.rs', '.c', '.h', '.cpp', '.cs', '.php', '.rb', '.sh', '.sql', '.log', '.env', '.ini']);
const IMAGE_MIME_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export class WuchatChatView implements vscode.WebviewViewProvider {
	public static readonly viewId = 'wuchat.chatView';

	private view?: vscode.WebviewView;
	private streaming = false;
	private readonly activeCliChildren = new Map<string, ChildProcess>();
	private cliSessionPoll?: NodeJS.Timeout;
	private attachments: ChatAttachment[] = [];
	private transientError?: string;
	private browserElement?: { description: string; screenshot: Uint8Array; url: string };
	private lastRequest?: { text: string; agentId?: string; context: RequestContext };
	private queue: Array<{ text: string; agentId?: string; steer: boolean }> = [];
	/** Execution mode used by the next send; kept in memory so it never flips back mid-session. */
	private executionMode: 'local' | 'cli' = 'local';
	private readonly cliSessionVersions = new Map<string, number>();

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly controller: ChatController,
		private readonly agentManager: AgentManager,
		private readonly providerRegistry: ProviderRegistry,
		private readonly logger: Logger,
		private readonly browser: WuchatBrowser,
		private readonly toolRegistry: ToolRegistry
	) { }

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		this.executionMode = vscode.workspace.getConfiguration('wuchat').get<'local' | 'cli'>('executionMode', 'local');
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
		};
		view.webview.html = this.getHtml(view.webview);
		view.webview.onDidReceiveMessage(message => { void this.handleMessage(message); });
		view.onDidChangeVisibility(() => {
			if (view.visible) {
				void this.postState();
			}
		});
	}

	private async handleMessage(message: unknown): Promise<void> {
		if (typeof message !== 'object' || message === null) {
			return;
		}
		const msg = message as { type?: string; text?: string; sessionId?: string; providerId?: string; agentId?: string; model?: { provider: string; id: string } | null; effort?: string; attachmentIndex?: number; steer?: boolean; messageIndex?: number; upToIndex?: number; queueAction?: string; queueIndex?: number; items?: Array<{ text?: string; agentId?: string }>; openCli?: boolean; importCliSessions?: boolean };
		switch (msg.type) {
			case 'ready':
				await this.postState();
				break;
			case 'send':
				if (this.streaming) {
					this.queue.push({ text: msg.text ?? '', agentId: msg.agentId, steer: false });
					await this.postQueue();
					break;
				}
				await this.send(msg.text ?? '', msg.agentId);
				break;
			case 'steer':
				// Send immediately: the controller is busy, the text is appended to
				// the running turn's session and the model sees it next round.
				await this.send(msg.text ?? '', msg.agentId);
				break;
			case 'queueSync':
				// Reconcile the extension-side queue with the webview after edits.
				this.queue = (msg.items ?? []).map(item => ({ text: item.text ?? '', agentId: msg.agentId, steer: false }));
				break;
			case 'queueAction': {
				if (msg.queueAction === 'clear') this.queue = [];
				else if (msg.queueAction === 'remove' && typeof msg.queueIndex === 'number') this.queue.splice(msg.queueIndex, 1);
				else if (msg.queueAction === 'sendNow' && typeof msg.queueIndex === 'number') {
					const [item] = this.queue.splice(msg.queueIndex, 1);
					if (item) await this.send(item.text, item.agentId);
				}
				await this.postQueue();
				break;
			}
			case 'copyMessage':
				if (typeof msg.messageIndex === 'number') {
					const target = this.controller.session.messages[msg.messageIndex];
					if (target) await vscode.env.clipboard.writeText(target.content);
				}
				break;
			case 'forkSession': {
				const forked = this.controller.session.fork(typeof msg.upToIndex === 'number' ? msg.upToIndex : undefined);
				await this.controller.saveSession(forked);
				this.controller.setSession(forked);
				await this.postState();
				break;
			}
			case 'stop':
				this.controller.cancel();
				{
					const sessionId = this.toCliSessionId(this.controller.session.id);
					const child = this.activeCliChildren.get(sessionId);
					if (child) child.kill('SIGTERM');
					else if (this.controller.session.processId) {
						try { process.kill(this.controller.session.processId, 'SIGTERM'); } catch { /* already stopped */ }
					}
				}
				break;
			case 'newChat':
			case 'clear':
				this.attachments = [];
				this.browserElement = undefined;
				this.lastRequest = undefined;
				this.toolRegistry.setSessionAutoApprove(false);
				this.transientError = undefined;
				this.controller.newSession();
				await this.postState();
				break;
			case 'openSession':
				if (msg.sessionId) {
					await this.controller.loadSession(msg.sessionId);
					await this.postState();
				}
				break;
			case 'deleteSession':
				if (msg.sessionId) {
					await this.controller.deleteSession(msg.sessionId);
					if (msg.sessionId.startsWith('cli-')) {
						const sourceId = msg.sessionId.startsWith('cli-cli-') ? msg.sessionId.slice('cli-'.length) : msg.sessionId;
						await rm(path.join(homedir(), '.wuchat', 'sessions', `${sourceId}.json`), { force: true }).catch(() => undefined);
					}
					if (this.controller.session.id === msg.sessionId) this.controller.newSession();
					await this.postState();
				}
				break;
			case 'showSessions':
				await vscode.commands.executeCommand('wuchat.history');
				break;
			case 'openBrowser':
				await this.browser.open();
				break;
			case 'pickBrowserElement':
				try { await this.browser.pickBrowserElement(); }
				catch (error) { void vscode.window.showErrorMessage(`Wuchat: ${error instanceof Error ? error.message : String(error)}`); }
				break;
			case 'captureBrowser':
				try { await this.browser.captureScreenshot(); }
				catch (error) { void vscode.window.showErrorMessage(`Wuchat: ${error instanceof Error ? error.message : String(error)}`); }
				break;
			case 'retry': {
				const previous = this.lastRequest;
				await this.send(previous?.text ?? this.controller.session.lastUserMessage, previous?.agentId, previous?.context);
				break;
			}
			case 'setExecutionMode':
				if (msg.effort === 'local' || msg.effort === 'cli') {
					this.executionMode = msg.effort;
					await vscode.workspace.getConfiguration('wuchat').update('executionMode', msg.effort, vscode.ConfigurationTarget.Global);
					await this.postState();
				}
				break;
			case 'setApprovalMode':
				if (msg.effort === 'ask' || msg.effort === 'session') {
					await vscode.workspace.getConfiguration('wuchat').update('autoApproveTools', false, vscode.ConfigurationTarget.Global);
					this.toolRegistry.setSessionAutoApprove(msg.effort === 'session');
					await this.postState();
				}
				break;
			case 'openSettings':
				await vscode.commands.executeCommand('wuchat.settings');
				break;
			case 'openCli':
				await vscode.commands.executeCommand('wuchat.openConnectedCli');
				break;
			case 'importCliSessions':
				await vscode.commands.executeCommand('wuchat.importCliSessions');
				break;
			case 'connectProvider':
				await vscode.commands.executeCommand('wuchat.connectProvider', msg.providerId);
				break;
			case 'setAgent':
				if (msg.agentId && this.agentManager.get(msg.agentId)) {
					await vscode.workspace.getConfiguration('wuchat').update('defaultAgent', msg.agentId, vscode.ConfigurationTarget.Global);
					await this.postState();
				}
				break;
			case 'setModel': {
				const config = vscode.workspace.getConfiguration('wuchat');
				const providerId = msg.model?.provider ?? config.get<string>('provider', 'claude-plan');
				await config.update('provider', providerId, vscode.ConfigurationTarget.Global);
				await config.update('model', msg.model?.id ?? '', vscode.ConfigurationTarget.Global);
				await config.update('reasoningEffort', 'auto', vscode.ConfigurationTarget.Global);
				await this.postState();
				break;
			}
			case 'setEffort':
				if (msg.effort) {
					await vscode.workspace.getConfiguration('wuchat').update('reasoningEffort', msg.effort, vscode.ConfigurationTarget.Global);
					await this.postState();
				}
				break;
			case 'testProvider':
				await vscode.commands.executeCommand('wuchat.testProvider', msg.providerId);
				break;
			case 'attachFiles':
				await this.attachFiles();
				break;
			case 'removeAttachment':
				if (Number.isInteger(msg.attachmentIndex)) {
					this.attachments.splice(msg.attachmentIndex!, 1);
					await this.postState();
				}
				break;
			case 'removeBrowserElement':
				this.browserElement = undefined;
				await this.postState();
				break;
			case 'openFile':
				await this.openFileFromChat(msg.text);
				break;
			case 'openChangedFile':
				if (msg.text) {
					try { await openWorkspaceFile(msg.text); }
					catch (error) { void vscode.window.showErrorMessage(`Wuchat: ${error instanceof Error ? error.message : String(error)}`); }
				}
				break;
			case 'copy':
				if (msg.text) {
					await vscode.env.clipboard.writeText(msg.text);
					vscode.window.showInformationMessage('Wuchat: copied to clipboard.');
				}
				break;
			case 'insertCode':
				await this.insertCode(msg.text ?? '');
				break;
			case 'applyCode':
				await this.applyCode(msg.text ?? '');
				break;
			default:
				this.logger.debug('unknown webview message', JSON.stringify(msg));
		}
	}

	private async attachFiles(): Promise<void> {
		const workspace = vscode.workspace.workspaceFolders?.[0];
		const uris = await vscode.window.showOpenDialog({
			title: 'Attach files to Wuchat',
			defaultUri: workspace?.uri,
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
			filters: { 'Text and images': ['txt', 'md', 'mdx', 'ts', 'tsx', 'js', 'jsx', 'json', 'yaml', 'yml', 'html', 'css', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'cs', 'sh', 'sql', 'png', 'jpg', 'jpeg', 'gif', 'webp'] }
		});
		if (!uris?.length) {
			return;
		}

		for (const uri of uris) {
			const ext = extensionOf(uri);
			const mimeType = IMAGE_MIME_TYPES[ext] ?? 'text/plain';
			if (!IMAGE_MIME_TYPES[ext] && !TEXT_EXTENSIONS.has(ext)) {
				vscode.window.showWarningMessage(`Wuchat cannot attach ${vscode.workspace.asRelativePath(uri)}. Choose a text or image file.`);
				continue;
			}
			try {
				const data = await vscode.workspace.fs.readFile(uri);
				if (data.byteLength > MAX_ATTACHMENT_BYTES) {
					vscode.window.showWarningMessage(`Wuchat skipped ${vscode.workspace.asRelativePath(uri)} because it is larger than 2 MB.`);
					continue;
				}
				const name = uri.path.split('/').at(-1) ?? uri.path;
				const attachment: ChatAttachment = {
					name,
					uri: vscode.workspace.asRelativePath(uri),
					mimeType,
					data: new Uint8Array(data),
					...(!IMAGE_MIME_TYPES[ext] ? { text: new TextDecoder().decode(data) } : {})
				};
				this.attachments.push(attachment);
			} catch (err) {
				vscode.window.showWarningMessage(`Wuchat could not attach ${uri.path}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		await this.postState();
	}

	private async openFileFromChat(target: string | undefined): Promise<void> {
		if (!target) {
			return;
		}
		const match = target.match(/^([^:\s]+)(?::(\d+))?(?:\s+(\d+))?$/);
		if (!match) {
			return;
		}
		const [, path, lineColon, lineSpace] = match;
		const line = Number.parseInt(lineColon ?? lineSpace ?? '', 10);
		await openWorkspaceFile(path, Number.isNaN(line) ? undefined : line);
	}

	private async insertCode(code: string): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showInformationMessage('Wuchat: open a file to insert code.');
			return;
		}
		await editor.edit(editBuilder => editBuilder.insert(editor.selection.active, code));
	}

	private async applyCode(code: string): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showInformationMessage('Wuchat: open a file to apply code.');
			return;
		}
		const range = editor.selection.isEmpty
			? new vscode.Range(new vscode.Position(0, 0), editor.document.lineAt(editor.document.lineCount - 1).range.end)
			: editor.selection;
		await editor.edit(editBuilder => editBuilder.replace(range, code));
	}

	async addBrowserElement(description: string, screenshot: Uint8Array, url: string): Promise<void> {
		this.browserElement = { description, screenshot, url };
		if (!this.streaming) await this.postState();
	}

	async addBrowserScreenshot(data: Uint8Array, url: string): Promise<void> {
		this.attachments.push({ name: `Browser screenshot ${new Date().toLocaleTimeString()}.png`, uri: url, mimeType: 'image/png', data });
		if (!this.streaming) await this.postState();
	}

	async send(text: string, agentId?: string, retryContext?: RequestContext): Promise<void> {
		if (!text.trim() || this.streaming || !this.view) {
			return;
		}
		this.streaming = true;
		this.transientError = undefined;
		const post = (message: unknown) => void this.view?.webview.postMessage(message);
		post({ type: 'clearError' });
		const context: RequestContext = retryContext ?? { attachments: this.attachments.splice(0) };
		if (!retryContext) post({ type: 'clearComposerAttachments' });
		if (!retryContext) {
			const selection = getActiveSelection();
			if (selection) context.selection = selection;
			if (this.browserElement) {
				const { description: text, screenshot, url } = this.browserElement;
				context.attachments.push({ name: 'Selected page element.html', uri: 'wuchat-browser://selection', mimeType: 'text/html', data: new TextEncoder().encode(text), text });
				context.attachments.push({ name: 'Selected page element.png', uri: url, mimeType: 'image/png', data: screenshot });
			}
			this.browserElement = undefined;
		}
		this.lastRequest = { text, agentId, context };

		post({ type: 'streamStart' });
		try {
			if (this.executionMode === 'cli') {
				await this.sendViaCli(text, context);
				return;
			}
			await this.controller.send(text, { agentId, context }, {
				onUserMessage: message => post({ type: 'userMessage', message }),
				onAssistantStart: agent => post({ type: 'assistantStart', agent, executionMode: 'local' }),
				onChunk: chunk => post({ type: 'assistantChunk', text: chunk }),
				onReasoning: chunk => post({ type: 'assistantReasoning', text: chunk }),
				onToolCall: progress => post({ type: 'toolCall', ...progress }),
				onPlan: steps => post({ type: 'plan', steps }),
				onTodos: todos => post({ type: 'todos', todos }),
				onAssistantDone: message => post({ type: 'assistantDone', message, executionMode: 'local' }),
				onSystemMessage: text => post({ type: 'system', text }),
				onError: text => { this.transientError = text; post({ type: 'error', text }); }
			});
		} finally {
			this.streaming = false;
			post({ type: 'streamEnd' });
			await this.postState();
			await this.drainQueue();
		}
	}

	/**
	 * Executes the message in the Wuchat CLI process (its own agent/tools),
	 * streaming its output back into the chat. The CLI keeps the authoritative
	 * transcript under ~/.wuchat/sessions (prefixed cli- here on import).
	 */
	private async sendViaCli(text: string, context: RequestContext): Promise<void> {
		const sessionId = this.toCliSessionId(this.controller.session.id);
		const post = (message: unknown) => {
			if (this.toCliSessionId(this.controller.session.id) === sessionId) void this.view?.webview.postMessage(message);
		};
		const executable = process.platform === 'win32' ? 'wuchat' : path.join(homedir(), '.local', 'bin', 'wuchat');
		const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		if (this.activeCliChildren.has(sessionId)) {
			this.transientError = 'This chat already has a CLI process running. Start a new chat to run another task concurrently.';
			post({ type: 'error', text: this.transientError });
			return;
		}
		if (this.controller.session.id !== sessionId) {
			const previous = this.controller.session;
			this.controller.setSession(ChatSession.from({
				id: sessionId,
				title: previous.title,
				createdAt: previous.createdAt,
				updatedAt: previous.updatedAt,
				messages: previous.messages
			}));
		}
		const contextDir = path.join(homedir(), '.wuchat', 'contexts');
		const contextFile = path.join(contextDir, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
		await mkdirAsync(contextDir, { recursive: true, mode: 0o700 });
		await writeFile(contextFile, JSON.stringify({
			selection: context.selection,
			notes: context.notes,
			attachments: context.attachments.map(attachment => ({
				name: attachment.name,
				uri: attachment.uri,
				mimeType: attachment.mimeType,
				text: attachment.text,
				data: Buffer.from(attachment.data).toString('base64')
			}))
		}), { mode: 0o600 });
		post({ type: 'userMessage', message: { role: 'user', content: text } });
		this.controller.session.append({ role: 'user', content: text });
		post({ type: 'assistantStart', agent: 'CLI Agent', executionMode: 'cli' });
		const child = spawn(executable, ['--session', sessionId, '--agent', '--yes', '--prompt', text, '--context-file', contextFile], { cwd: workspace, detached: true });
		this.activeCliChildren.set(sessionId, child);
		this.controller.session.running = true;
		this.controller.session.processId = child.pid;
		await this.controller.saveSession(this.controller.session);
		if (!this.cliSessionPoll) {
			this.cliSessionPoll = setInterval(() => { void this.refreshCliSessionList(); }, 2_000);
		}
		{
			let assistantText = '';
			let stderrBuffer = '';
			let timeout: ReturnType<typeof setTimeout>;
			const resetWatchdog = () => {
				clearTimeout(timeout);
				timeout = setTimeout(() => {
				this.transientError = 'Wuchat CLI did not finish within 10 minutes; the request was aborted.';
				post({ type: 'error', text: this.transientError });
				child.kill();
				}, 10 * 60_000);
			};
			resetWatchdog();
			child.stdout.on('data', (data: Buffer) => {
				resetWatchdog();
				const chunk = data.toString();
				assistantText += chunk;
				post({ type: 'assistantChunk', text: chunk });
			});
			child.stderr.on('data', (data: Buffer) => {
				resetWatchdog();
				stderrBuffer += data.toString();
				const lines = stderrBuffer.split(/\r?\n/);
				stderrBuffer = lines.pop() ?? '';
				for (const line of lines) this.handleCliStderrLine(line, post);
			});
			child.on('error', (error: Error) => {
				clearTimeout(timeout);
				void rm(contextFile, { force: true });
				if (this.activeCliChildren.get(sessionId) === child) this.activeCliChildren.delete(sessionId);
				this.controller.session.running = false;
				this.controller.session.processId = undefined;
				const message = error instanceof Error ? error.message : String(error);
				this.transientError = `Wuchat CLI is not installed or not reachable: ${message}`;
				this.controller.session.append({ role: 'assistant', content: this.transientError, agent: 'CLI Agent', error: this.transientError });
				void this.controller.saveSession(this.controller.session);
				post({ type: 'error', text: this.transientError });
				void this.refreshCliSessionList();
			});
			child.on('close', (_code, signal) => {
				clearTimeout(timeout);
				if (stderrBuffer) this.handleCliStderrLine(stderrBuffer, post);
				if (this.activeCliChildren.get(sessionId) === child) this.activeCliChildren.delete(sessionId);
				if (this.activeCliChildren.size === 0 && this.cliSessionPoll) {
					clearInterval(this.cliSessionPoll);
					this.cliSessionPoll = undefined;
				}
				post({ type: 'assistantDone', message: { role: 'assistant', content: assistantText.trim(), agent: 'CLI Agent', ...(signal ? { error: 'CLI process interrupted' } : {}) }, executionMode: 'cli' });
				if (this.toCliSessionId(this.controller.session.id) === sessionId) {
					void this.syncCliSessions().then(async () => {
						await this.controller.loadSession(sessionId);
						await this.postState();
					});
				}
				else void this.refreshCliSessionList();
			});
		}
	}

	private async refreshCliSessionList(): Promise<void> {
		if (!this.view) return;
		await this.syncCliSessions();
		const currentId = this.controller.session.id;
		if (currentId.startsWith('cli-') && this.controller.session.running) {
			await this.controller.loadSession(currentId);
			await this.postState();
			return;
		}
		await this.view.webview.postMessage({ type: 'sessions', sessions: this.controller.sessionSummaries });
	}

	private handleCliStderrLine(line: string, post: (message: unknown) => void): void {
		const eventPrefix = '\x1eWUCHAT:';
		if (line.startsWith(eventPrefix)) {
			try {
				const event = JSON.parse(line.slice(eventPrefix.length)) as { type?: string };
				if (event.type === 'toolCall' || event.type === 'plan' || event.type === 'todos' || event.type === 'system' || event.type === 'assistantReasoning') post(event);
			} catch (error) {
				this.logger.warn('Could not parse CLI progress event.', error);
			}
			return;
		}
		const errorText = line.trim();
		if (errorText) {
			this.transientError = errorText;
			post({ type: 'error', text: errorText });
		}
	}

	/** Sends queued messages one by one after the current turn ends. */
	private async drainQueue(): Promise<void> {
		if (this.streaming || this.queue.length === 0 || !this.view) return;
		const next = this.queue.shift()!;
		await this.postQueue();
		await this.send(next.text, next.agentId);
	}

	private async postQueue(): Promise<void> {
		if (!this.view) return;
		await this.view.webview.postMessage({ type: 'queue', items: this.queue.map(item => ({ text: item.text })) });
	}

	/** Shows an informational line in the chat (e.g. compaction progress). */
	async systemMessage(text: string): Promise<void> {
		if (!this.view) return;
		await this.view.webview.postMessage({ type: 'system', text });
	}

	async newChat(): Promise<void> {
		this.attachments = [];
		this.controller.newSession();
		await this.postState();
	}

	async refresh(): Promise<void> {
		await this.postState();
	}

	private async postState(): Promise<void> {
		if (!this.view) {
			return;
		}
		await this.syncCliSessions();
		const config = vscode.workspace.getConfiguration('wuchat');
		const modelGroups = await Promise.all(this.providerRegistry.list().map(async provider => ({
			id: provider.id,
			name: provider.name,
			models: provider.models ? await provider.models().catch(() => []) : []
		})));
		await this.view.webview.postMessage({
			type: 'state',
			messages: this.controller.session.messages,
			sessions: this.controller.sessionSummaries,
			currentSessionId: this.controller.session.id,
			running: this.activeCliChildren.has(this.toCliSessionId(this.controller.session.id)) || Boolean(this.controller.session.running),
			contextEstimate: this.controller.contextEstimate,
			workspaceName: vscode.workspace.workspaceFolders?.[0]?.name ?? 'No workspace',
			autoApproveTools: config.get<boolean>('autoApproveTools', false),
			attachments: [...this.attachments.map((file, index) => ({ name: file.name, index })), ...(this.browserElement ? [{ name: 'Browser element + screenshot', browserElement: true }] : [])],
			approvalMode: config.get<boolean>('autoApproveTools', false) ? 'configured' : this.toolRegistry.isSessionAutoApproved ? 'session' : 'ask',
			agents: this.agentManager.list().map(agent => ({ id: agent.id, name: agent.name, description: agent.description })),
			modelGroups,
			provider: config.get<string>('provider', 'claude-plan'),
			model: config.get<string>('model', ''),
			effort: config.get<string>('reasoningEffort', 'auto'),
			executionMode: this.executionMode,
			defaultAgent: this.agentManager.get(config.get<string>('defaultAgent', 'wuchat.ask'))?.id ?? this.agentManager.defaultAgent.id,
			transientError: this.transientError
		});
	}

	/** Imports newly written or updated CLI transcripts into the VS Code history. */
	private async syncCliSessions(): Promise<void> {
		await this.controller.reconcileRunningSessions();
		const directory = path.join(homedir(), '.wuchat', 'sessions');
		let files: string[];
		try {
			files = (await readdir(directory)).filter(file => file.endsWith('.json'));
		} catch {
			return;
		}
		for (const file of files) {
			try {
				const raw = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as {
					id?: string; updatedAt?: string; messages?: ChatMessage[]; status?: string; pid?: number;
				};
				if (!raw.id || !Array.isArray(raw.messages) || !raw.messages.length) continue;
				let running = raw.status === 'running' && isProcessAlive(raw.pid);
				if (raw.status === 'running' && !running) {
					raw.status = 'interrupted';
					raw.updatedAt = new Date().toISOString();
					raw.messages.push({ role: 'assistant', content: '_(CLI process stopped before completing this response. The user prompt and previous history were preserved.)_', agent: 'CLI Agent', error: 'Process interrupted' });
					await writeFile(path.join(directory, file), JSON.stringify(raw, null, 2), { mode: 0o600 });
					running = false;
				}
				const updatedAt = raw.updatedAt ? Date.parse(raw.updatedAt) : Date.now();
				const version = Number.isFinite(updatedAt) ? updatedAt : Date.now();
				const storeId = raw.id.startsWith('cli-') ? raw.id : `cli-${raw.id}`;
				if ((this.cliSessionVersions.get(storeId) ?? 0) >= version) continue;
				const firstUser = raw.messages.find(message => message.role === 'user')?.content ?? '';
				await this.controller.saveSession(ChatSession.from({
					id: storeId,
					title: `[CLI] ${firstUser.replace(/\s+/g, ' ').trim().slice(0, 36) || 'New chat'}`,
					createdAt: version,
					updatedAt: version,
					messages: raw.messages,
					running,
					processId: running ? raw.pid : undefined
				}));
				this.cliSessionVersions.set(storeId, version);
			} catch (error) {
				this.logger.warn(`Could not sync CLI session ${file}.`, error);
			}
		}
	}

	private toCliSessionId(sessionId: string): string {
		return sessionId.startsWith('cli-') ? sessionId : `cli-${sessionId}`;
	}

	private getHtml(webview: vscode.Webview): string {
		const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'wuchat.js'));
		const styles = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'wuchat.css'));
		const icon = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg'));
		const nonce = getNonce();
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${styles}">
	<title>Wuchat</title>
</head>
<body>
	<header id="wuchat-toolbar">
		<div class="brand">
			<img id="wuchat-brand-icon" src="${icon}" alt="" width="25" height="25">
			<div class="brand-copy"><strong>Wuchat</strong><span>AI workspace</span></div>
		</div>
		<div class="toolbar-actions">
			<button class="vscode-button" id="wuchat-new" title="New chat" aria-label="New chat"></button>
			<button class="vscode-button" id="wuchat-history" title="Sessions" aria-label="Sessions" aria-pressed="false"></button>
			<button class="vscode-button" id="wuchat-settings" title="Settings and sign-in" aria-label="Settings and sign-in"></button>
			<button class="vscode-button" id="wuchat-cli" title="Use the Wuchat CLI (connected to this provider)" aria-label="Use the Wuchat CLI">CLI</button>
		</div>
	</header>
	<div id="wuchat-content">
		<main id="wuchat-messages" aria-label="Conversation" aria-live="polite"></main>
		<section id="wuchat-session-panel" aria-label="Sessions" hidden>
			<div class="sessions-heading"><div><span class="eyebrow">YOUR WORKSPACE</span><h2>Sessions</h2></div><span id="session-count"></span></div>
			<label class="session-search-wrap"><span class="sr-only">Search sessions</span><input id="wuchat-session-search" type="search" placeholder="Search conversations…" autocomplete="off"></label>
			<div id="wuchat-session-list"></div>
		</section>
	</div>
	<footer id="wuchat-composer">
		<div class="composer-card">
			<div class="composer-tip"><span class="tip-spark">TIP</span><span>Ask a question or describe what to build</span><span class="composer-shortcut">Enter to send</span></div>
			<div id="wuchat-attachments"></div>
			<textarea id="wuchat-input" placeholder="Message Wuchat…" rows="2" aria-label="Message"></textarea>
			<div class="composer-bottom">
				<button class="vscode-button composer-attach" id="wuchat-attach" title="Attach files" aria-label="Attach files"></button>
				<div id="wuchat-context-selectors" aria-label="Chat options">
					<select id="wuchat-agent" aria-label="Agent" title="Choose an agent"></select>
					<select id="wuchat-model" aria-label="Model" title="Choose a model"></select>
					<select id="wuchat-effort" aria-label="Reasoning effort" title="Reasoning effort"></select>
				</div>
				<button class="primary-button composer-icon-button" id="wuchat-send" aria-label="Send message" title="Send message" type="button"></button>
				<button class="secondary-button composer-icon-button" id="wuchat-stop" style="display:none" aria-label="Stop response" title="Stop response" type="button"></button>
			</div>
		</div>
		<div id="wuchat-queue" hidden></div>
		<div class="composer-status"><span id="wuchat-workspace-label"></span><span class="status-separator">·</span><span id="wuchat-context-meter" title="Estimated context size"></span><span class="status-separator">·</span><label class="sr-only" for="wuchat-execution-mode">Run via</label><select id="wuchat-execution-mode" title="Where messages are processed"><option value="local">Local</option><option value="cli">CLI</option></select><span class="status-separator">·</span><label class="sr-only" for="wuchat-approval-mode">Tool approval</label><select id="wuchat-approval-mode" title="Tool approval for this session"><option value="ask">Ask every time</option><option value="session">Approve for me · session</option><option value="configured" disabled>Auto approve in Settings</option></select><span class="browser-actions"><button class="composer-browser" id="wuchat-browser" title="Open Wuchat's Chrome window" aria-label="Open Wuchat Browser">Browser ↗</button><button class="composer-browser" id="wuchat-browser-pick" title="Click an element in Chrome to attach it to Wuchat" aria-label="Select browser element for Wuchat">Pick</button><button class="composer-browser" id="wuchat-browser-capture" title="Attach Chrome screenshot to Wuchat" aria-label="Capture browser screenshot for Wuchat">Capture</button></span></div>
	</footer>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}

function extensionOf(uri: vscode.Uri): string {
	const name = uri.path.split('/').at(-1) ?? '';
	const dot = name.lastIndexOf('.');
	return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

function isProcessAlive(pid: number | undefined): boolean {
	if (!Number.isInteger(pid) || !pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
