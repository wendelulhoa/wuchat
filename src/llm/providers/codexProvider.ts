/*---------------------------------------------------------------------------------------------
 *  Wuchat — direct ChatGPT Codex provider (ChatGPT OAuth + Responses API).
 *  Ported from claude-for-copilot so Wuchat needs no companion extension.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { ChatChunk, ChatRequest, LLMProvider, ModelInfo } from '../../common/types';
import { SecretManager } from '../secrets';
import { getAccessToken, readOAuthSession } from '../oauth';
import { fetchJson, readSse, toToolCall } from '../sse';

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=0.146.0';
const ORIGINATOR = 'openai-oauth-copilot-chat';
const REQUEST_TIMEOUT_MS = 600_000;

/** Same supplemental catalog as the Codex CLI; the live directory supplies the rest. */
const FALLBACK_MODELS = [
	{ id: 'gpt-6-astra', name: 'GPT 6 Astra' },
	{ id: 'gpt-6-sol', name: 'GPT 6 Sol' },
	{ id: 'gpt-6-luna', name: 'GPT 6 Luna' }
];

export interface CodexProviderOptions {
	secretManager: SecretManager;
	onMissingCredentials?: () => Promise<void>;
}

export class CodexProvider implements LLMProvider {
	readonly id = 'openai-codex';
	readonly name = 'ChatGPT Codex';

	constructor(private readonly options: CodexProviderOptions) { }

	async models(): Promise<ModelInfo[]> {
		let models = FALLBACK_MODELS;
		try {
			const token = await getAccessToken(this.options.secretManager, 'codex');
			const session = await readOAuthSession(this.options.secretManager, 'codex');
			const response = await fetchJson(MODELS_URL, {
				headers: {
					authorization: `Bearer ${token}`,
					accept: 'application/json',
					...(session?.accountId ? { 'chatgpt-account-id': session.accountId } : {}),
					originator: ORIGINATOR
				}
			}, 20_000);
			if (response.ok) {
				const data = await response.json() as { models?: Array<{ slug?: string; display_name?: string; visibility?: string }> };
				// The live directory is authoritative; only listable models are shown.
				const fetched = (data.models ?? [])
					.filter(model => model.slug && (model.visibility === undefined || model.visibility === 'list'))
					.map(model => ({ id: model.slug!, name: model.display_name?.replaceAll('-', ' ') ?? prettifyModelName(model.slug!) }));
				if (fetched.length) models = fetched;
			}
		} catch { /* not connected: static catalog */ }
		return models.map(model => ({
			id: model.id,
			name: model.name,
			provider: this.id,
			capabilities: { streaming: true, tools: true, vision: true, reasoning: true, maxInputTokens: 272_000 }
		}));
	}

	async status(): Promise<{ ok: boolean; detail: string }> {
		const session = await readOAuthSession(this.options.secretManager, 'codex');
		return session
			? { ok: true, detail: `Signed in to ChatGPT${session.email ? ` (${session.email})` : ''}.` }
			: { ok: false, detail: 'Not connected. Use Wuchat: Connect AI Provider to sign in with your ChatGPT account.' };
	}

	async *chat(request: ChatRequest, modelId: string): AsyncIterable<ChatChunk> {		let token: string;
		try {
			token = await getAccessToken(this.options.secretManager, 'codex');
		} catch (error) {
			if (this.options.onMissingCredentials) await this.options.onMissingCredentials();
			yield { error: error instanceof Error ? error.message : String(error) };
			return;
		}
		const accountId = (await readOAuthSession(this.options.secretManager, 'codex'))?.accountId;
		try {
			for await (const chunk of streamCodex(request, modelId, token, accountId)) yield chunk;
		} catch (error) {
			if (/\b401\b|unauthorized/i.test(error instanceof Error ? error.message : String(error))) {
				try {
					const refreshed = await getAccessToken(this.options.secretManager, 'codex', true);
					for await (const chunk of streamCodex(request, modelId, refreshed)) yield chunk;
					return;
				} catch { /* fall through */ }
			}
			yield { error: error instanceof Error ? error.message : String(error) };
		}
	}
}

function prettifyModelName(id: string): string {
	return id.split('-').map(part => /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh']);

async function* streamCodex(request: ChatRequest, model: string, token: string, accountId?: string): AsyncIterable<ChatChunk> {
	const effort = request.modelOptions?.reasoningEffort;
	const instructions = request.history
		.filter(message => message.role === 'system')
		.map(message => message.content)
		.join('\n\n') || "You are a coding agent in Visual Studio Code. Follow the user's instruction exactly.";
	const body: Record<string, unknown> = {
		model,
		instructions,
		store: false,
		stream: true,
		include: ['reasoning.encrypted_content'],
		input: toCodexInput(request),
		...(request.tools.length ? {
			tools: request.tools.map(tool => ({
				type: 'function',
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema,
				strict: false
			})),
			tool_choice: 'auto',
			parallel_tool_calls: true
		} : {}),
		...(effort && effort !== 'auto' && EFFORT_LEVELS.has(effort) ? { reasoning: { effort, summary: 'auto' } } : {})
	};
	const response = await fetchJson(RESPONSES_URL, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			accept: 'text/event-stream',
			'content-type': 'application/json',
			originator: ORIGINATOR,
			'session-id': randomUUID(),
			'thread-id': randomUUID(),
			...(accountId ? { 'chatgpt-account-id': accountId } : {})
		},
		body: JSON.stringify(body)
	}, REQUEST_TIMEOUT_MS, request.token);
	if (!response.ok || !response.body) {
		throw new Error(`Codex API ${response.status}: ${await response.text().catch(() => response.statusText)}`);
	}
	const calls = new Map<string, { id: string; name: string; arguments: string }>();
	for await (const data of readSse(response, request.token)) {
		const event = JSON.parse(data) as {
			type?: string;
			item?: { id?: string; call_id?: string; name?: string; arguments?: string };
			item_id?: string;
			delta?: string;
			response?: { error?: { message?: string } };
		};
		if (event.type === 'response.failed' || event.type === 'error') {
			throw new Error(event.response?.error?.message ?? 'Codex stream error.');
		}
		if ((event.type === 'response.output_item.added' || event.type === 'response.output_item.done') && event.item?.call_id) {
			const key = event.item.id ?? event.item.call_id;
			const current = calls.get(key) ?? { id: '', name: '', arguments: '' };
			current.id = event.item.call_id;
			current.name = event.item.name ?? current.name;
			if (event.item.arguments) current.arguments = event.item.arguments;
			calls.set(key, current);
		} else if (event.type === 'response.function_call_arguments.delta' && event.item_id) {
			const current = calls.get(event.item_id);
			if (current) current.arguments += event.delta ?? '';
		} else if (event.type === 'response.output_text.delta' && event.delta) {
			yield { text: event.delta };
		} else if (event.type === 'response.reasoning_summary_text.delta' && event.delta) {
			yield { reasoning: event.delta };
		} else if (event.type === 'response.reasoning_summary_text.done' || event.type === 'response.reasoning_text.done') {
			// Each reasoning summary part becomes one step in the UI.
			yield { reasoningBoundary: true };
		}
	}
	for (const call of calls.values()) {
		if (call.id && call.name) yield { toolCall: toToolCall(call.id, call.name, call.arguments) };
	}
}

function toCodexInput(request: ChatRequest): Array<Record<string, unknown>> {
	const items: Array<Record<string, unknown>> = [];
	const push = (role: 'user' | 'assistant', text: string): void => {
		items.push({
			type: 'message',
			role,
			content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }]
		});
	};
	for (const message of request.history) {
		if (message.role === 'system') continue;
		if (message.role === 'tool') {
			items.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
			continue;
		}
		if (message.content) push(message.role === 'assistant' ? 'assistant' : 'user', message.content);
		for (const call of message.toolCallRequests ?? []) {
			items.push({ type: 'function_call', call_id: call.id, name: call.tool, arguments: JSON.stringify(call.input ?? {}) });
		}
	}
	if (request.prompt) push('user', request.prompt);
	return items;
}

