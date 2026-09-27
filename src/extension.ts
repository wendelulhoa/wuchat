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
import { VSCodeLmProvider } from './llm/providers/vscodeLmProvider';
import { ToolRegistry } from './tools/ToolRegistry';
import { defaultTools } from './tools/implementations/defaultTools';
import { registerCommands } from './extension/commands';
import { registerVsCodeChatBridge } from './vscode/chatParticipantBridge';
import { WuchatBrowser } from './browser/WuchatBrowser';
import { createBrowserTool } from './browser/browserTool';

export function activate(context: vscode.ExtensionContext): void {
	const logger = new Logger();
	context.subscriptions.push(logger);
	logger.info('Wuchat activating…');

	const providerRegistry = new ProviderRegistry();
	providerRegistry.register(new EchoProvider());
	providerRegistry.register(new VSCodeLmProvider({
		id: 'claude-plan',
		name: 'Claude Plan',
		managementCommand: 'claudePlan.manage',
		connectCommand: 'claudePlan.login',
		testConnectionCommand: 'claudePlan.testConnection'
	}));
	providerRegistry.register(new VSCodeLmProvider({
		id: 'openai-codex',
		name: 'ChatGPT Codex',
		managementCommand: 'openaiCodex.manage',
		connectCommand: 'openaiCodex.login',
		testConnectionCommand: 'openaiCodex.testConnection'
	}));
	providerRegistry.register(new VSCodeLmProvider({
		id: 'zai-glm',
		name: 'Z.AI GLM',
		managementCommand: 'zaiGlm.manage',
		connectCommand: 'zaiGlm.setApiKey',
		testConnectionCommand: 'zaiGlm.testConnection'
	}));

	const browser = new WuchatBrowser();
	context.subscriptions.push(browser);
	const toolRegistry = new ToolRegistry();
	for (const tool of defaultTools) {
		toolRegistry.register(tool);
	}

	toolRegistry.register(createBrowserTool(browser));
	const agentManager = new AgentManager(toolRegistry);
	const sessionStore = new SessionStore(context);
	const controller = new ChatController(agentManager, providerRegistry, sessionStore, logger);
	const chatView = new WuchatChatView(context.extensionUri, controller, agentManager, providerRegistry, logger, browser, toolRegistry);
	browser.setContextHandlers(description => chatView.addBrowserElement(description), (data, url) => chatView.addBrowserScreenshot(data, url));
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
		browser.setContextHandlers(description => chatView.addBrowserElement(description), (data, url) => chatView.addBrowserScreenshot(data, url));
	void agentManager.refreshWorkspaceAgents().then(() => chatView.refresh());
	}));

	context.subscriptions.push(...registerCommands({
		controller,
		agentManager,
		providerRegistry,
		chatView,
		sessionStore,
		logger
	}));
	context.subscriptions.push(...registerVsCodeChatBridge(controller, agentManager, logger, () => { void chatView.refresh(); }));

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('wuchat.')) {
			void chatView.refresh();
		}
	}));

	logger.info('Wuchat activated.');
}

export function deactivate(): void {
	// All resources are registered on ExtensionContext.subscriptions.
}
