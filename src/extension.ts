/*---------------------------------------------------------------------------------------------
 *  Wuchat — VS Code chat with its own providers, agents, sessions and tools.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentManager } from './agents/AgentManager';
import { ChatController } from './chat/controllers/ChatController';
import { SessionStore } from './chat/history/SessionStore';
import { WuchatChatView } from './chat/views/WuchatChatView';
import { Logger } from './common/logger';
import { ProviderRegistry } from './llm/ProviderRegistry';
import { EchoProvider } from './llm/providers/echoProvider';
import { AnthropicProvider } from './llm/providers/anthropicProvider';
import { CodexProvider } from './llm/providers/codexProvider';
import { GlmProvider } from './llm/providers/glmProvider';
import { SecretManager, configureApiKey } from './llm/secrets';
import { createAuthorizationUrl, completeSignIn, importClaudeCliSession, importCodexCliSession, clearOAuthSession, readOAuthSession, startBrowserSignIn } from './llm/oauth';
import { ToolRegistry } from './tools/ToolRegistry';
import { defaultTools } from './tools/implementations/defaultTools';
import { registerMcpTools } from './tools/mcpBridge';
import { registerCommands } from './extension/commands';
import { registerVsCodeChatBridge } from './vscode/chatParticipantBridge';
import { WuchatBrowser } from './browser/WuchatBrowser';
import { createBrowserTool } from './browser/browserTool';
import { ExtensionCliBridge } from './cli/extensionBridge';

export function activate(context: vscode.ExtensionContext): void {
	const logger = new Logger();
	context.subscriptions.push(logger);
	logger.info('Wuchat activating…');

	const providerRegistry = new ProviderRegistry();
	providerRegistry.register(new EchoProvider());
	const secretManager = new SecretManager(context.secrets);
	// Direct providers: Claude (claude.ai OAuth), ChatGPT Codex (ChatGPT OAuth)
	// and Z.AI GLM (API key) sign in inside Wuchat — no companion extension.
	const promptOAuthSignIn = async (vendor: 'claude' | 'codex'): Promise<void> => {
		const label = vendor === 'claude' ? 'Claude' : 'ChatGPT Codex';
		try {
			if (vendor === 'codex') {
				// Automatic flow: the browser redirects to a local server, no pasting.
				const signIn = startBrowserSignIn(secretManager, vendor, url => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))));
				void signIn.completion.then(async session => {
					vscode.window.showInformationMessage(`Wuchat: signed in to ChatGPT Codex.`);
					void session;
					await chatView.refresh();
				}).catch(error => vscode.window.showErrorMessage(`Wuchat: Codex sign-in failed: ${error instanceof Error ? error.message : String(error)}`));
				return;
			}
			const { url, pkce } = createAuthorizationUrl(vendor);
			await vscode.env.openExternal(vscode.Uri.parse(url));
			const callback = await vscode.window.showInputBox({
				title: `Wuchat: ${label} sign-in`,
				prompt: 'Paste the code from the browser (the CODE#STATE value shown on the callback page), or press Escape to cancel.',
				ignoreFocusOut: true
			});
			if (!callback) return;
			const session = await completeSignIn(secretManager, vendor, callback, pkce);
			vscode.window.showInformationMessage(`Wuchat: signed in to ${label}${session.email ? ` as ${session.email}` : ''}.`);
			await chatView.refresh();
		} catch (error) {
			vscode.window.showErrorMessage(`Wuchat: ${label} sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const importCliLogin = async (vendor: 'claude' | 'codex'): Promise<boolean> =>
		vendor === 'claude' ? importClaudeCliSession(secretManager) : importCodexCliSession(secretManager);
	context.subscriptions.push(vscode.commands.registerCommand('wuchat.connectOAuth', (vendor?: 'claude' | 'codex') =>
		promptOAuthSignIn(vendor ?? 'claude')));
	context.subscriptions.push(vscode.commands.registerCommand('wuchat.importCliLogin', async () => {
		const pick = await vscode.window.showQuickPick([
			{ label: '$(cloud-upload) Import Claude CLI login (~/.claude)', vendor: 'claude' as const },
			{ label: '$(cloud-upload) Import Codex CLI login (~/.codex)', vendor: 'codex' as const }
		], { title: 'Import an existing CLI sign-in' });
		if (!pick) return;
		const ok = await importCliLogin(pick.vendor);
		vscode.window.showInformationMessage(ok ? 'Wuchat: CLI login imported.' : `Wuchat: no ${pick.vendor === 'claude' ? 'Claude' : 'Codex'} CLI credentials found.`);
		if (ok) await chatView.refresh();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('wuchat.signOut', async (vendor?: 'claude' | 'codex') => {
		const target = vendor ?? (await vscode.window.showQuickPick([
			{ label: 'Claude', vendor: 'claude' as const },
			{ label: 'ChatGPT Codex', vendor: 'codex' as const }
		], { title: 'Sign out of which account?' }))?.vendor;
		if (!target) return;
		await clearOAuthSession(secretManager, target);
		const connected = await readOAuthSession(secretManager, target);
		void connected;
		vscode.window.showInformationMessage('Wuchat: signed out.');
		await chatView.refresh();
	}));
	providerRegistry.register(new AnthropicProvider({
		secretManager,
		onMissingCredentials: () => promptOAuthSignIn('claude')
	}));
	providerRegistry.register(new CodexProvider({
		secretManager,
		onMissingCredentials: () => promptOAuthSignIn('codex')
	}));
	providerRegistry.register(new GlmProvider({
		secretManager,
		onMissingCredentials: () => configureApiKey(secretManager, 'zai-glm')
	}));
	const cliBridge = new ExtensionCliBridge(providerRegistry, logger);
	context.subscriptions.push(cliBridge);
	void cliBridge.start().catch(error => logger.warn('Could not start the connected CLI provider bridge.', error));

	const browser = new WuchatBrowser();
	context.subscriptions.push(browser);
	context.subscriptions.push(
		vscode.commands.registerCommand('wuchat.pickBrowserElement', async () => {
			try { await browser.pickBrowserElement(); }
			catch (error) { void vscode.window.showErrorMessage(`Wuchat: ${error instanceof Error ? error.message : String(error)}`); }
		}),
		vscode.commands.registerCommand('wuchat.captureBrowser', async () => {
			try { await browser.captureScreenshot(); }
			catch (error) { void vscode.window.showErrorMessage(`Wuchat: ${error instanceof Error ? error.message : String(error)}`); }
		})
	);
	const toolRegistry = new ToolRegistry();
	for (const tool of defaultTools) {
		toolRegistry.register(tool);
	}
	// Granular per-tool approval (Kilo Code-style): allow/ask per tool id or wildcard.
	const applyApprovalPolicy = (): void => {
		toolRegistry.setApprovalPolicy(vscode.workspace.getConfiguration('wuchat').get<Record<string, string>>('tools.approval', {}));
	};
	applyApprovalPolicy();

	toolRegistry.register(createBrowserTool(browser));
	context.subscriptions.push(registerMcpTools(toolRegistry, logger));
	const agentManager = new AgentManager(toolRegistry);
	const sessionStore = new SessionStore(context);
	const controller = new ChatController(agentManager, providerRegistry, sessionStore, logger);
	const chatView = new WuchatChatView(context.extensionUri, controller, agentManager, providerRegistry, logger, browser, toolRegistry);
	browser.setContextHandlers((description, screenshot, url) => chatView.addBrowserElement(description, screenshot, url), (data, url) => chatView.addBrowserScreenshot(data, url), picking => chatView.updateBrowserPickState(picking));
	void agentManager.refreshWorkspaceAgents().then(() => chatView.refresh());

	context.subscriptions.push(
		sessionStore,
		vscode.window.registerWebviewViewProvider(WuchatChatView.viewId, chatView, {
			webviewOptions: { retainContextWhenHidden: true }
		}),
		vscode.lm.onDidChangeChatModels(() => { void chatView.refresh(); })
	);

	let agentWatchers: vscode.FileSystemWatcher[] = [];
	const refreshAgentWatchers = (): void => {
		for (const watcher of agentWatchers) watcher.dispose();
		agentWatchers = (vscode.workspace.workspaceFolders ?? []).map(folder => {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.github/agents/**/*.md'));
			const refresh = (): void => { void agentManager.refreshWorkspaceAgents().then(() => chatView.refresh()); };
			watcher.onDidCreate(refresh, undefined, context.subscriptions);
			watcher.onDidChange(refresh, undefined, context.subscriptions);
			watcher.onDidDelete(refresh, undefined, context.subscriptions);
			context.subscriptions.push(watcher);
			return watcher;
		});
	};
	refreshAgentWatchers();
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
		refreshAgentWatchers();
		browser.setContextHandlers((description, screenshot, url) => chatView.addBrowserElement(description, screenshot, url), (data, url) => chatView.addBrowserScreenshot(data, url), picking => chatView.updateBrowserPickState(picking));
	void agentManager.refreshWorkspaceAgents().then(() => chatView.refresh());
	}));

	context.subscriptions.push(...registerCommands({
		controller,
		agentManager,
		providerRegistry,
		chatView,
		sessionStore,
		logger,
		secrets: context.secrets
	}));
	context.subscriptions.push(...registerVsCodeChatBridge(controller, agentManager, logger, () => { void chatView.refresh(); }));

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('wuchat.tools.approval')) {
			applyApprovalPolicy();
		}
		if (event.affectsConfiguration('wuchat.')) {
			void chatView.refresh();
		}
	}));

	logger.info('Wuchat activated.');
}

export function deactivate(): void {
	// All resources are registered on ExtensionContext.subscriptions.
}
