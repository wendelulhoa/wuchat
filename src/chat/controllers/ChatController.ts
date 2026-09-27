/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  ChatController connects the UI, agents, tools, sessions and model registry.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentManager } from '../../agents/AgentManager';
import { Logger } from '../../common/logger';
import { ChatMessage, ChatRequest, LLMProvider, RequestContext } from '../../common/types';
import { ProviderRegistry } from '../../llm/ProviderRegistry';
import { ChatSession } from '../sessions/ChatSession';
import { SessionStore } from '../history/SessionStore';

export interface StreamCallbacks {
	onUserMessage?(message: ChatMessage): void;
	onAssistantStart?(agentName: string): void;
	onChunk?(text: string): void;
	onReasoning?(text: string): void;
	onToolCall?(tool: string, status: 'started' | 'finished' | 'rejected' | 'retrying'): void;
	onPlan?(steps: string[]): void;
	onAssistantDone?(message: ChatMessage): void;
	onSystemMessage?(text: string): void;
	onError?(text: string): void;
}

export class ChatController {
	private _session: ChatSession;
	private readonly cancellations = new Map<string, vscode.CancellationTokenSource>();

	constructor(
		private readonly agentManager: AgentManager,
		private readonly providerRegistry: ProviderRegistry,
		private readonly sessionStore: SessionStore,
		private readonly logger: Logger
	) {
		this._session = new ChatSession();
	}

	get session(): ChatSession {
		return this._session;
	}

	get sessionSummaries(): Array<{ id: string; title: string; updatedAt: number; failed: boolean }> {
		return this.sessionStore.sessions.map(session => ({
			id: session.id,
			title: session.title,
			updatedAt: session.updatedAt,
			failed: Boolean(session.messages.at(-1)?.error)
		}));
	}

	get isBusy(): boolean {
		return this.cancellations.size > 0;
	}

	/** Rough context size (tokens ≈ chars/4) the next request would carry. */
	get contextEstimate(): { tokens: number; messages: number } {
		const chars = this._session.messages.reduce((sum, message) => sum + message.content.length, 0);
		return { tokens: Math.ceil(chars / 4), messages: this._session.messages.length };
	}

	setSession(session: ChatSession): void {
		this._session = session;
	}

	newSession(): ChatSession {
		this._session = new ChatSession();
		return this._session;
	}

	async loadSession(id: string): Promise<boolean> {
		const stored = this.sessionStore.get(id);
		if (!stored) {
			return false;
		}
		this._session = ChatSession.from(stored);
		return true;
	}

	/** Persists a session (used by forks before switching to them). */
	async saveSession(session: ChatSession): Promise<void> {
		await this.sessionStore.save(session.toStored());
	}

	async deleteSession(id: string): Promise<void> {
		await this.sessionStore.delete(id);
	}

	async clearAllSessions(): Promise<void> {
		await this.sessionStore.clear();
	}

	/** Sends a user prompt through the configured agent and its selected provider/model. */
	async send(
		prompt: string,
		options: { agentId?: string; context?: RequestContext },
		callbacks: StreamCallbacks
	): Promise<void> {
		const config = vscode.workspace.getConfiguration('wuchat');
		const requestedAgentId = options.agentId ?? config.get<string>('defaultAgent', 'wuchat.ask');
		const agent = this.agentManager.get(requestedAgentId) ?? this.agentManager.defaultAgent;

		const overrides = config.get<Record<string, { provider?: string; model?: string }>>('agents.modelOverrides', {});
		const override = overrides[agent.id] ?? {};
		const providerId = agent.provider ?? override.provider ?? config.get<string>('provider', 'claude-plan');
		const modelId = agent.model ?? override.model ?? config.get<string>('model', '');

		let provider: LLMProvider;
		try {
			provider = this.providerRegistry.getRequired(providerId);
		} catch (err) {
			callbacks.onError?.(err instanceof Error ? err.message : String(err));
			return;
		}

		const userContent = prompt;
		const userMessage: ChatMessage = {
			role: 'user',
			content: userContent,
			...(options.context?.attachments.length ? { attachments: options.context.attachments.map(({ name, mimeType, uri }) => ({ name, mimeType, uri })) } : {})
		};
		this._session.append(userMessage);
		callbacks.onUserMessage?.(userMessage);

		const effort = config.get<string>('reasoningEffort', 'auto');
		const supportedEfforts: Record<string, string[]> = {
			'claude-plan': ['low', 'medium', 'high'],
			'openai-codex': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
			'zai-glm': ['low', 'high', 'max']
		};
		const cancellation = new vscode.CancellationTokenSource();
		this.cancellations.set('active', cancellation);

		const request: ChatRequest = {
			requestId: `req-${Date.now()}`,
			agent: agent.id,
			prompt,
			history: this._session.messages.slice(0, -1),
			context: options.context ?? { attachments: [] },
			tools: [],
			...(supportedEfforts[providerId]?.includes(effort) ? { modelOptions: { reasoningEffort: effort } } : {}),
			token: cancellation.token
		};

		callbacks.onAssistantStart?.(agent.name);
		const started = Date.now();
		try {
			const result = await agent.invoke(request, provider, modelId, {
				onText: text => callbacks.onChunk?.(text),
				onReasoning: text => callbacks.onReasoning?.(text),
				onToolCall: (tool, status) => callbacks.onToolCall?.(tool, status),
				onPlan: steps => callbacks.onPlan?.(steps),
				onSystemMessage: text => callbacks.onSystemMessage?.(text)
			});
			const assistantMessage: ChatMessage = {
				role: 'assistant',
				content: result.text,
				error: result.error,
				reasoning: result.reasoning,
				agent: agent.name,
				provider: provider.id,
				toolCalls: result.toolCalls.length ? result.toolCalls : undefined
			};
			this._session.append(assistantMessage);
			callbacks.onAssistantDone?.(assistantMessage);
			this.logger.info(`Request ${request.requestId} finished in ${Date.now() - started}ms via ${provider.id}/${modelId || 'auto'}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logger.error('send failed', message);
			callbacks.onError?.(`Wuchat: ${message}`);
		} finally {
			this.cancellations.delete('active');
			await this.sessionStore.save(this._session.toStored());
		}
	}

	cancel(): void {
		for (const cancellation of this.cancellations.values()) {
			cancellation.cancel();
		}
	}

	/**
	 * Manually compacts the current session: replaces older turns with an LLM
	 * summary kept in history, so long chats continue to work within the
	 * context window without losing earlier facts.
	 */
	async compactContext(callbacks: { onSystemMessage?(text: string): void; onError?(text: string): void }): Promise<void> {
		const config = vscode.workspace.getConfiguration('wuchat');
		const agentId = config.get<string>('defaultAgent', 'wuchat.ask');
		const agent = this.agentManager.get(agentId) ?? this.agentManager.defaultAgent;
		const overrides = config.get<Record<string, { provider?: string; model?: string }>>('agents.modelOverrides', {});
		const override = overrides[agent.id] ?? {};
		const providerId = agent.provider ?? override.provider ?? config.get<string>('provider', 'claude-plan');
		const modelId = agent.model ?? override.model ?? config.get<string>('model', '');
		let provider: LLMProvider;
		try {
			provider = this.providerRegistry.getRequired(providerId);
		} catch (err) {
			callbacks.onError?.(err instanceof Error ? err.message : String(err));
			return;
		}
		const messages = this._session.messages.filter(message => !message.error);
		if (messages.length === 0) {
			callbacks.onSystemMessage?.('Wuchat: nothing to compact yet.');
			return;
		}
		const transcript = messages
			.map(message => `${message.role}: ${message.content.slice(0, 4_000)}`)
			.join('\n\n')
			.slice(0, 80_000);
		try {
			callbacks.onSystemMessage?.('Wuchat: compacting conversation context…');
			const token = new vscode.CancellationTokenSource().token;
			let summary = '';
			const stream = provider.chat({
				requestId: `compact-${Date.now()}`,
				agent: agent.id,
				prompt: '',
				history: [{ role: 'user', content: `Summarize the following conversation so an assistant can continue it without losing any relevant fact, decision, file path or pending task. Be concise and factual, in the language of the conversation. Do not answer the user, only summarize.\n\n${transcript}` }],
				context: { attachments: [] },
				tools: [],
				token
			}, modelId);
			for await (const chunk of stream) {
				if (chunk.error) throw new Error(chunk.error);
				if (chunk.text) summary += chunk.text;
			}
			if (!summary.trim()) throw new Error('the provider returned an empty summary');
			const keep = messages.slice(-2);
			this._session.replaceMessages([
				{ role: 'user', content: `[Context compacted on ${new Date().toLocaleString()}] Summary of the conversation so far:\n${summary.trim().slice(0, 12_000)}` },
				...keep
			]);
			callbacks.onSystemMessage?.('Wuchat: context compacted. Older turns are now a summary.');
			this.logger.info(`Compacted session ${this._session.id} (${messages.length} messages -> summary + ${keep.length})`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logger.error('compact failed', message);
			callbacks.onError?.(`Wuchat: could not compact context: ${message}`);
			return;
		} finally {
			await this.sessionStore.save(this._session.toStored());
		}
	}
}
