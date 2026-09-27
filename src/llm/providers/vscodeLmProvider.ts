/*---------------------------------------------------------------------------------------------
 *  Wuchat — VS Code Language Model adapter.
 *  Each instance is restricted to one vendor contributed by the companion
 *  provider extension. This keeps GitHub Copilot models out of Wuchat's list.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatChunk, ChatMessage, ChatRequest, LLMProvider, ModelInfo, ToolCallRequest } from '../../common/types';

interface ActiveCall {
	abort: vscode.CancellationTokenSource;
}

const NETWORK_REQUEST_TIMEOUT_MS = 120_000;

export interface VSCodeLmProviderOptions {
	id: 'claude-plan' | 'openai-codex' | 'zai-glm' | string;
	name: string;
	managementCommand: string;
	connectCommand?: string;
	testConnectionCommand?: string;
}

export class VSCodeLmProvider implements LLMProvider {
	readonly id: string;
	readonly name: string;
	readonly managementCommand: string;
	readonly connectCommand?: string;
	readonly testConnectionCommand?: string;

	private readonly active = new Map<string, ActiveCall>();

	constructor(options: VSCodeLmProviderOptions) {
		this.id = options.id;
		this.name = options.name;
		this.managementCommand = options.managementCommand;
		this.connectCommand = options.connectCommand;
		this.testConnectionCommand = options.testConnectionCommand;
	}

	async *chat(request: ChatRequest, modelId: string): AsyncIterable<ChatChunk> {
		let models: readonly vscode.LanguageModelChat[];
		try {
			models = await vscode.lm.selectChatModels({ vendor: this.id });
		} catch (err) {
			yield { error: `Wuchat could not list ${this.name} models: ${asMessage(err)}` };
			return;
		}
		if (models.length === 0) {
			yield { error: `${this.name} is unavailable. Install and enable the Claude Plan + Codex provider extension, then use Wuchat: Connect AI Provider to sign in or configure it.` };
			return;
		}

		const selected = modelId ? models.find(candidate => candidate.id === modelId) : models[0];
		if (!selected) {
			yield { error: `The selected ${this.name} model is no longer available. Choose another model in Chat Settings.` };
			return;
		}

		const messages = buildMessages(request);
		const availableTools = request.tools.map(tool => ({ ...tool }));

		const abort = new vscode.CancellationTokenSource();
		const listener = request.token.onCancellationRequested(() => abort.cancel());
		this.active.set(request.requestId, { abort });

		try {
			const requestOptions = {
				justification: 'Wuchat is responding to a message you sent in its chat view.',
				...(request.modelOptions ? { modelOptions: request.modelOptions } : {}),
				...(availableTools.length ? { tools: availableTools, toolMode: vscode.LanguageModelChatToolMode.Auto } : {})
			};
			const retryDeadline = Date.now() + NETWORK_REQUEST_TIMEOUT_MS;
			let attempt = 0;
			while (!abort.token.isCancellationRequested) {
				let emittedChunk = false;
				let attemptTimedOut = false;
				const attemptAbort = new vscode.CancellationTokenSource();
				const cancelAttempt = abort.token.onCancellationRequested(() => attemptAbort.cancel());
				const remainingMs = Math.max(0, retryDeadline - Date.now());
				const timeout = setTimeout(() => { attemptTimedOut = true; attemptAbort.cancel(); }, remainingMs);
				try {
					if (remainingMs <= 0) {
						attemptTimedOut = true;
						attemptAbort.cancel();
						throw new Error('Network request timed out.');
					}
					const response = await selected.sendRequest(messages, requestOptions, attemptAbort.token);
					clearTimeout(timeout);
					for await (const part of response.stream) {
						if (abort.token.isCancellationRequested) return;
						if (part instanceof vscode.LanguageModelTextPart) {
							emittedChunk = true;
							yield { text: part.value };
						} else if (part instanceof vscode.LanguageModelToolCallPart) {
							emittedChunk = true;
							yield { toolCall: { id: part.callId, tool: part.name, input: part.input } };
						} else {
							const reasoning = getReasoningText(part);
							if (reasoning) {
								emittedChunk = true;
								yield { reasoning };
							}
						}
					}
					return;
				} catch (err) {
					if (abort.token.isCancellationRequested) return;
					const transient = !emittedChunk && isTransientNetworkError(err);
					const remaining = retryDeadline - Date.now();
					if ((attemptTimedOut || transient) && remaining > 0) {
						const delay = Math.min(750 * (2 ** Math.min(attempt, 4)), 10_000, remaining);
						attempt++;
						await waitBeforeRetry(abort.token, delay);
						if (!abort.token.isCancellationRequested) continue;
						return;
					}
					if (attemptTimedOut || transient) {
						yield { error: networkRetryTimeoutError(this.id, this.name) };
						return;
					}
					yield { error: formatProviderError(this.id, this.name, err) };
					return;
				} finally {
					clearTimeout(timeout);
					cancelAttempt.dispose();
					attemptAbort.dispose();
				}
			}
		} catch (err) {
			if (err instanceof vscode.CancellationError || abort.token.isCancellationRequested) {
				return;
			}
			yield { error: formatProviderError(this.id, this.name, err) };
		} finally {
			listener.dispose();
			this.active.delete(request.requestId);
			abort.dispose();
		}
	}

	abort(requestId: string): void {
		this.active.get(requestId)?.abort.cancel();
	}

	async models(): Promise<ModelInfo[]> {
		try {
			const models = await vscode.lm.selectChatModels({ vendor: this.id });
			return models.map(model => ({
				id: model.id,
				name: model.name,
				detail: `${this.name} · ${model.family}`,
				provider: this.id,
				capabilities: { streaming: true, maxInputTokens: model.maxInputTokens }
			}));
		} catch {
			return [];
		}
	}

	async status(): Promise<{ ok: boolean; detail: string }> {
		const models = await this.models();
		return {
			ok: models.length > 0,
			detail: models.length
				? `${models.length} model(s) available.`
				: `No ${this.id} models are registered. Install and enable the companion provider extension.`
		};
	}
}

function buildMessages(request: ChatRequest): vscode.LanguageModelChatMessage[] {
	const messages: vscode.LanguageModelChatMessage[] = [];
	for (const message of request.history) {
		appendHistoryMessage(messages, message);
	}

	if (request.prompt) {
		const promptParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart> = [
			new vscode.LanguageModelTextPart(request.prompt)
		];
		for (const attachment of request.context.attachments) {
			if (attachment.mimeType.startsWith('image/')) {
				promptParts.push(new vscode.LanguageModelDataPart(attachment.data, attachment.mimeType));
			}
		}
		messages.push(vscode.LanguageModelChatMessage.User(promptParts));
	}
	return messages;
}

function appendHistoryMessage(messages: vscode.LanguageModelChatMessage[], message: ChatMessage): void {
	if (message.role === 'tool' && message.toolCallId) {
		messages.push(vscode.LanguageModelChatMessage.User([
			new vscode.LanguageModelToolResultPart(message.toolCallId, [new vscode.LanguageModelTextPart(message.content)])
		]));
		return;
	}

	if (message.role === 'assistant' && message.toolCallRequests?.length) {
		const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
		if (message.content) {
			parts.push(new vscode.LanguageModelTextPart(message.content));
		}
		for (const call of message.toolCallRequests) {
			parts.push(new vscode.LanguageModelToolCallPart(call.id, call.tool, asToolInput(call.input)));
		}
		messages.push(vscode.LanguageModelChatMessage.Assistant(parts));
		return;
	}

	if (message.role === 'assistant') {
		messages.push(vscode.LanguageModelChatMessage.Assistant(message.content));
	} else {
		messages.push(vscode.LanguageModelChatMessage.User(message.role === 'system' ? `Instructions: ${message.content}` : message.content));
	}
}

function asToolInput(input: unknown): object {
	if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
		return input as object;
	}
	return { input: typeof input === 'string' ? input : JSON.stringify(input ?? {}) };
}

function getReasoningText(part: unknown): string | undefined {
	if (typeof part !== 'object' || part === null) {
		return undefined;
	}
	const ThinkingPart = (vscode as unknown as {
		LanguageModelThinkingPart?: new (...args: never[]) => { value?: string | string[] };
	}).LanguageModelThinkingPart;
	if (ThinkingPart && part instanceof ThinkingPart) {
		const value = part.value;
		return Array.isArray(value) ? value.join('\n') : value;
	}
	return undefined;
}

function asMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isTransientNetworkError(err: unknown): boolean {
	const messages: string[] = [];
	const codes: string[] = [];
	let current: unknown = err;
	for (let depth = 0; current && depth < 5; depth++) {
		if (current instanceof Error) {
			messages.push(current.message);
			current = (current as Error & { cause?: unknown }).cause;
			continue;
		}
		if (typeof current === 'object') {
			const record = current as { message?: unknown; code?: unknown; errno?: unknown; cause?: unknown };
			if (typeof record.message === 'string') messages.push(record.message);
			for (const code of [record.code, record.errno]) {
				if (typeof code === 'string') codes.push(code);
			}
			current = record.cause;
			continue;
		}
		break;
	}
	return /fetch failed|network|socket|timed? ?out|dns|connection (?:reset|refused|closed)/i.test(messages.join(' '))
		|| /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)$/i.test(codes.join(' '));
}

function waitBeforeRetry(token: vscode.CancellationToken, milliseconds: number): Promise<void> {
	return new Promise(resolve => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			listener.dispose();
			resolve();
		};
		const timer = setTimeout(finish, milliseconds);
		const listener = token.onCancellationRequested(finish);
		if (token.isCancellationRequested) finish();
	});
}

function networkRetryTimeoutError(providerId: string, providerName: string): string {
	if (providerId === 'zai-glm') {
		return 'Could not reach the Z.AI Coding Plan service after retrying for 2 minutes. Check your internet connection, VPN, proxy, or DNS, then use Wuchat Settings → Test connection.';
	}
	return `Could not reach ${providerName} after retrying for 2 minutes. Check your internet connection, VPN, proxy, or DNS.`;
}

function formatProviderError(providerId: string, providerName: string, err: unknown): string {
	const messages: string[] = [];
	const codes: string[] = [];
	let current: unknown = err;
	for (let depth = 0; current && depth < 5; depth++) {
		if (current instanceof Error) {
			if (current.message && !messages.includes(current.message)) messages.push(current.message);
			current = (current as Error & { cause?: unknown }).cause;
			continue;
		}
		if (typeof current === 'object') {
			const record = current as { message?: unknown; code?: unknown; errno?: unknown; cause?: unknown };
			if (typeof record.message === 'string' && !messages.includes(record.message)) messages.push(record.message);
			for (const code of [record.code, record.errno]) {
				if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) && !codes.includes(code)) codes.push(code);
			}
			current = record.cause;
			continue;
		}
		break;
	}
	const detail = messages[0] || asMessage(err);
	if (providerId === 'zai-glm' && /fetch failed|network|socket|timed? ?out|dns/i.test(messages.join(' '))) {
		const cause = codes.length ? ` (${codes.join(', ')})` : '';
		return `Could not reach the Z.AI Coding Plan service${cause}. Check your internet connection, VPN, proxy, or DNS, then use Wuchat Settings → Test connection. The API key is only rejected after a server response.`;
	}
	const safeCause = codes.length ? ` [${codes.join(', ')}]` : '';
	return `${providerName} request failed: ${detail}${safeCause}`;
}

