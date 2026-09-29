/*---------------------------------------------------------------------------------------------
 *  Wuchat — all Wuchat commands use the `wuchat.*` namespace.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { AgentManager } from '../agents/AgentManager';
import { ChatController } from '../chat/controllers/ChatController';
import { WuchatChatView } from '../chat/views/WuchatChatView';
import { SessionStore, StoredSession } from '../chat/history/SessionStore';
import { showWuchatTerminal } from '../vscode/workspaceBridge';
import { Logger } from '../common/logger';
import { ProviderRegistry } from '../llm/ProviderRegistry';
import { SecretManager, configureApiKey } from '../llm/secrets';

export interface CommandDeps {
	controller: ChatController;
	agentManager: AgentManager;
	providerRegistry: ProviderRegistry;
	chatView: WuchatChatView;
	sessionStore: SessionStore;
	logger: Logger;
	secrets: vscode.SecretStorage;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
	const { controller, agentManager, providerRegistry, chatView, sessionStore, logger, secrets } = deps;

	async function revealChat(): Promise<void> {
		await vscode.commands.executeCommand('wuchat.chatView.focus');
	}

	async function openConnectedCli(): Promise<void> {
		const workspace = vscode.workspace.workspaceFolders?.[0];
		if (!workspace) {
			vscode.window.showWarningMessage('Open a workspace folder before starting the Wuchat CLI.');
			return;
		}
		const executable = process.platform === 'win32'
			? 'wuchat'
			: path.join(homedir(), '.local', 'bin', 'wuchat');
		const quote = process.platform === 'win32'
			? (value: string) => `"${value.replace(/"/g, '\\"')}"`
			: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
		const terminal = vscode.window.createTerminal({ name: 'Wuchat CLI', cwd: workspace.uri.fsPath });
		terminal.show(true);
		terminal.sendText(`${quote(executable)} --connected`, true);
	}

	async function chooseAgent(): Promise<string | undefined> {
		const agents = agentManager.list();
		const pick = await vscode.window.showQuickPick(
			agents.map(agent => ({ label: agent.name, description: agent.description, agentId: agent.id })),
			{ title: 'Wuchat: Choose the default agent' }
		);
		return pick?.agentId;
	}

	async function chooseModel(): Promise<string | undefined> {
		const config = vscode.workspace.getConfiguration('wuchat');
		const providerId = config.get<string>('provider', 'anthropic');
		const provider = providerRegistry.get(providerId);
		const models = provider?.models ? await provider.models() : [];
		if (!models.length) {
			vscode.window.showInformationMessage('No models are listed for this provider yet. Connect the provider, then try again.');
			return undefined;
		}
		const pick = await vscode.window.showQuickPick(
			models.map(model => ({ label: model.name, description: model.detail, modelId: model.id })),
			{ title: 'Wuchat: Choose a model', placeHolder: 'Automatic model selection is available in Settings.' }
		);
		return pick?.modelId;
	}

	async function connectProvider(providerId?: string): Promise<void> {
		const candidates = providerRegistry.list().filter(provider => provider.id !== 'echo');
		let selectedId = providerId;
		if (!selectedId) {
			const pick = await vscode.window.showQuickPick(
				candidates.map(provider => ({
					label: `$(key) ${provider.name}`,
					description: provider.id === 'zai-glm' ? 'API key' : provider.id === 'echo' ? 'Offline' : 'Account sign-in',
					providerId: provider.id
				})),
				{ title: 'Connect an AI provider', placeHolder: 'Choose a provider to sign in or add its API key' }
			);
			selectedId = pick?.providerId;
		}
		if (!selectedId) {
			return;
		}

		const provider = providerRegistry.get(selectedId);
		if (!provider) {
			return;
		}
		const config = vscode.workspace.getConfiguration('wuchat');
		await config.update('provider', selectedId, vscode.ConfigurationTarget.Global);
		await config.update('model', '', vscode.ConfigurationTarget.Global);
		await config.update('reasoningEffort', 'auto', vscode.ConfigurationTarget.Global);

		if (provider.id === 'echo') {
			vscode.window.showInformationMessage('Wuchat Echo works offline and does not need sign-in.');
			return;
		}
		// GLM uses a direct API key; Claude and Codex use OAuth account sign-in.
		if (provider.id === 'zai-glm') {
			await configureApiKey(new SecretManager(secrets), provider.id);
			await chatView.refresh();
			return;
		}
		if (provider.id === 'anthropic' || provider.id === 'openai-codex') {
			await vscode.commands.executeCommand('wuchat.connectOAuth', provider.id === 'anthropic' ? 'claude' : 'codex');
			await chatView.refresh();
			return;
		}
		await chatView.refresh();
	}

	async function manageCurrentProvider(): Promise<void> {
		const id = vscode.workspace.getConfiguration('wuchat').get<string>('provider', 'anthropic');
		const provider = providerRegistry.get(id);
		const command = provider && 'managementCommand' in provider
			? String((provider as { managementCommand: string }).managementCommand)
			: undefined;
		if (command && (await vscode.commands.getCommands(true)).includes(command)) {
			await vscode.commands.executeCommand(command);
			await chatView.refresh();
			return;
		}
		await connectProvider(id);
	}

	async function openChatSettings(): Promise<void> {
		const config = vscode.workspace.getConfiguration('wuchat');
		const providerId = config.get<string>('provider', 'anthropic');
		const provider = providerRegistry.get(providerId);
		const agentId = config.get<string>('defaultAgent', 'wuchat.ask');
		const agent = agentManager.get(agentId);
		const items = [
			{ label: '$(key) Connect or switch provider…', description: `Current: ${provider?.name ?? providerId}`, action: 'connect' },
			{ label: '$(gear) Sign-in and API key settings…', description: `Manage ${provider?.name ?? providerId}`, action: 'manage' },
			{ label: '$(check) Test provider connection', description: provider?.name ?? providerId, action: 'test' },
			{ label: '$(terminal) Open connected CLI', description: 'Use the selected VS Code provider and model', action: 'cli' },
			{ label: '$(hubot) Choose default agent…', description: agent?.name ?? agentId, action: 'agent' },
			{ label: '$(history) Conversation history…', description: 'Reopen a saved chat', action: 'history' },
			{ label: '$(cloud-download) Import CLI sessions…', description: 'Bring ~/.wuchat sessions into this history', action: 'importCli' },
			{ label: '$(tools) Tool permissions and approval…', description: 'Control edit and terminal confirmations', action: 'tools' },
			{ label: '$(settings-gear) Advanced Wuchat settings…', description: 'Context, history retention, and other preferences', action: 'advanced' }
		];
		const pick = await vscode.window.showQuickPick(items, { title: 'Wuchat settings' });
		if (!pick) {
			return;
		}
		switch (pick.action) {
			case 'cli': await openConnectedCli(); break;
			case 'connect': await connectProvider(); break;
			case 'manage': await manageCurrentProvider(); break;
			case 'test': await testCurrentProvider(); break;
			case 'history': await pickSessionAndOpen(); break;
			case 'importCli': await importCliSessions(); break;
			case 'tools': await vscode.commands.executeCommand('workbench.action.openSettings', 'wuchat.autoApproveTools'); break;
			case 'agent': {
				const agentId = await chooseAgent();
				if (agentId) {
					await config.update('defaultAgent', agentId, vscode.ConfigurationTarget.Global);
				}
				break;
			}
			case 'advanced':
				await vscode.commands.executeCommand('workbench.action.openSettings', 'wuchat.');
				break;
		}
		await chatView.refresh();
	}

	async function testCurrentProvider(providerOverride?: string): Promise<void> {
		const id = providerOverride ?? vscode.workspace.getConfiguration('wuchat').get<string>('provider', 'anthropic');
		const provider = providerRegistry.get(id) as (ReturnType<ProviderRegistry['get']> & { testConnectionCommand?: string }) | undefined;
		if (!provider || !provider.testConnectionCommand || !(await vscode.commands.getCommands(true)).includes(provider.testConnectionCommand)) {
			vscode.window.showWarningMessage(`Connection test for ${provider?.name ?? id} is unavailable. Install and enable the provider extension.`);
			return;
		}
		try {
			await vscode.commands.executeCommand(provider.testConnectionCommand);
		} catch (error) {
			logger.warn(`Provider connection test failed (${id})`, error);
			vscode.window.showErrorMessage(`Could not test ${provider.name}. Check its sign-in or API key in Wuchat Settings.`);
		}
	}

	async function pickSessionAndOpen(): Promise<void> {
		const pick = await vscode.window.showQuickPick(
			sessionStore.sessions.map(session => ({
				label: session.title || 'New chat',
				description: new Date(session.updatedAt).toLocaleString(),
				id: session.id
			})),
			{ title: 'Wuchat: Chat history', placeHolder: 'Choose a conversation to reopen' }
		);
		if (pick) {
			await vscode.commands.executeCommand('wuchat.openSession', pick.id);
		}
	}

	/** Imports CLI sessions from ~/.wuchat/sessions into the Wuchat history. */
	async function importCliSessions(): Promise<void> {
		const dir = path.join(homedir(), '.wuchat', 'sessions');
		let files: string[];
		try {
			files = (await readdir(dir)).filter(name => name.endsWith('.json'));
		} catch {
			vscode.window.showInformationMessage('Wuchat: no CLI session directory found (~/.wuchat/sessions).');
			return;
		}
		let imported = 0;
		let skipped = 0;
		for (const file of files) {
			try {
				const raw = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as {
					id?: string; workspace?: string; updatedAt?: string; provider?: string; model?: string;
					messages?: StoredSession['messages'];
				};
				if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
					skipped++;
					continue;
				}
				const id = `cli-${raw.id ?? file.replace(/\.json$/, '')}`;
				const updatedAt = raw.updatedAt ? Date.parse(raw.updatedAt) : Date.now();
				await sessionStore.save({
					id,
					title: `[CLI] ${raw.messages.find(m => m.role === 'user')?.content.slice(0, 36) || id}`,
					createdAt: Number.isFinite(updatedAt) ? updatedAt - 1 : Date.now(),
					updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
					messages: raw.messages
				});
				imported++;
			} catch {
				skipped++;
			}
		}
		await chatView.refresh();
		vscode.window.showInformationMessage(`Wuchat: imported ${imported} CLI session(s)${skipped ? `, skipped ${skipped}` : ''}.`);
	}

	return [
		vscode.commands.registerCommand('wuchat.open', revealChat),
		vscode.commands.registerCommand('wuchat.openConnectedCli', openConnectedCli),
		vscode.commands.registerCommand('wuchat.newChat', async () => {
			await chatView.newChat();
			await revealChat();
		}),
		vscode.commands.registerCommand('wuchat.clearChat', async () => {
			controller.newSession();
			await chatView.refresh();
		}),
		vscode.commands.registerCommand('wuchat.cancelGeneration', () => controller.cancel()),
		vscode.commands.registerCommand('wuchat.showAgentTerminal', () => showWuchatTerminal()),
		vscode.commands.registerCommand('wuchat.selectAgent', async () => {
			const agentId = await chooseAgent();
			if (agentId) {
				await vscode.workspace.getConfiguration('wuchat').update('defaultAgent', agentId, vscode.ConfigurationTarget.Global);
			}
		}),
		vscode.commands.registerCommand('wuchat.selectModel', async () => {
			const modelId = await chooseModel();
			if (modelId) {
				await vscode.workspace.getConfiguration('wuchat').update('model', modelId, vscode.ConfigurationTarget.Global);
			}
		}),
		vscode.commands.registerCommand('wuchat.selectProvider', () => connectProvider()),
		vscode.commands.registerCommand('wuchat.connectProvider', (providerId?: string) => connectProvider(providerId)),
		vscode.commands.registerCommand('wuchat.manageProvider', manageCurrentProvider),
		vscode.commands.registerCommand('wuchat.selectAgentModel', async () => {
			await openChatSettings();
		}),
		vscode.commands.registerCommand('wuchat.toggleAutoApprove', async () => {
			const config = vscode.workspace.getConfiguration('wuchat');
			const current = config.get<boolean>('autoApproveTools', false);
			await config.update('autoApproveTools', !current, vscode.ConfigurationTarget.Global);
			vscode.window.showWarningMessage(!current
				? 'Wuchat: tools will run WITHOUT asking for approval.'
				: 'Wuchat: tools will ask for approval.');
		}),
		vscode.commands.registerCommand('wuchat.settings', openChatSettings),
		vscode.commands.registerCommand('wuchat.testProvider', testCurrentProvider),
		vscode.commands.registerCommand('wuchat.history', pickSessionAndOpen),
		vscode.commands.registerCommand('wuchat.importCliSessions', importCliSessions),
		vscode.commands.registerCommand('wuchat.openSession', async (sessionId?: string) => {
			if (typeof sessionId === 'string' && await controller.loadSession(sessionId)) {
				await chatView.refresh();
				await revealChat();
				logger.info(`Opened session ${sessionId}`);
			}
		}),
		vscode.commands.registerCommand('wuchat.deleteSession', async (sessionId?: string) => {
			if (typeof sessionId === 'string') {
				await controller.deleteSession(sessionId);
				await chatView.refresh();
			}
		}),
		vscode.commands.registerCommand('wuchat.clearHistory', async () => {
			const confirm = await vscode.window.showWarningMessage('Wuchat: delete ALL stored sessions?', { modal: true }, 'Delete All');
			if (confirm === 'Delete All') {
				await controller.clearAllSessions();
				await chatView.refresh();
			}
		}),
		vscode.commands.registerCommand('wuchat.refreshViews', () => chatView.refresh()),
		vscode.commands.registerCommand('wuchat.compactContext', async () => {
			await revealChat();
			await controller.compactContext({
				onSystemMessage: text => void chatView.systemMessage(text),
				onError: text => void chatView.systemMessage(text)
			});
			await chatView.refresh();
		}),
		vscode.commands.registerCommand('wuchat.explainSelection', async () => runOnSelection('Explain this code in depth:')),
		vscode.commands.registerCommand('wuchat.fixSelection', async () => runOnSelection('Find and fix problems in this code:')),
		vscode.commands.registerCommand('wuchat.internal.send', async (text: string) => {
			if (typeof text === 'string') {
				await revealChat();
				await chatView.send(text);
			}
		})
	];

	async function runOnSelection(prefix: string): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) {
			vscode.window.showInformationMessage('Wuchat: select some code first.');
			return;
		}
		await revealChat();
		await chatView.send(`${prefix}\n\nFile: ${vscode.workspace.asRelativePath(editor.document.uri)}`);
	}
}
