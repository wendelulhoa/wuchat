/*---------------------------------------------------------------------------------------------
 *  Wuchat — direct Anthropic (Claude) provider.
 *  Signs in with the claude.ai account via OAuth PKCE (same flow as the
 *  Claude CLI), with optional static API key fallback. No companion extension.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { ChatChunk, ChatRequest, LLMProvider, ModelInfo } from '../../common/types';
import { SecretManager } from '../secrets';
import { getAccessToken, readOAuthSession } from '../oauth';
import { fetchJson, readSse, sanitizeToolName, toToolCall } from '../sse';

const MESSAGES_URL = process.env.ANTHROPIC_BASE_URL
	? `${process.env.ANTHROPIC_BASE_URL.replace(/\/+$/, '')}/messages?beta=true`
	: 'https://api.anthropic.com/v1/messages?beta=true';
const MODELS_URL = 'https://api.anthropic.com/v1/models';
const DEFAULT_MAX_TOKENS = 8192;
const REQUEST_TIMEOUT_MS = 600_000;

/** Client identity required by the claude.ai OAuth flow (mirrors the Claude CLI). */
const CLAUDE_USER_AGENT = 'claude-cli/2.1.89 (external, sdk-cli)';
const CLAUDE_BILLING_SYSTEM = 'x-anthropic-billing-header: cc_version=2.1.89.6fb; cc_entrypoint=sdk-cli; cch=00000;';
const CLAUDE_AGENT_SYSTEM = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_BETA = [
	'claude-code-20250219',
	'oauth-2025-04-20',
	'interleaved-thinking-2025-05-14',
	'context-management-2025-06-27',
	'prompt-caching-scope-2026-01-05',
	'advanced-tool-use-2025-11-20',
	'effort-2025-11-24'
].join(',');

/** Same selectable-model filter as the Claude CLI catalog (sonnet/opus 5). */
const SELECTABLE_MODEL_PATTERN = /^claude-(?:sonnet|opus)-5(?:-|$)/;
const FALLBACK_MODELS = ['claude-sonnet-5', 'claude-opus-5'];

export interface AnthropicProviderOptions {
	secretManager: SecretManager;
	/** Invoked when a request arrives without any stored credentials. */
	onMissingCredentials?: () => Promise<void>;
}

export class AnthropicProvider implements LLMProvider {
	readonly id = 'anthropic';
	readonly name = 'Claude';

	constructor(private readonly options: AnthropicProviderOptions) { }

	async models(): Promise<ModelInfo[]> {
		let models = FALLBACK_MODELS.map(id => ({ id, name: prettifyModelName(id) }));
		try {
			const token = await getAccessToken(this.options.secretManager, 'claude');
			const response = await fetchJson(MODELS_URL, {
				headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
			}, 20_000);
			if (response.ok) {
				const data = await response.json() as { data?: Array<{ id?: string; display_name?: string }> };
				const fetched = (data.data ?? [])
					.filter(model => model.id && SELECTABLE_MODEL_PATTERN.test(model.id))
					.map(model => ({ id: model.id!, name: model.display_name ?? prettifyModelName(model.id!) }));
				if (fetched.length) models = fetched;
			}
		} catch { /* not connected or listing failed: fall back to the static catalog */ }
		return models.map(model => ({
			id: model.id,
			name: model.name,
			provider: this.id,
			capabilities: { streaming: true, tools: true, vision: true, maxInputTokens: 200_000, maxOutputTokens: 32_000 }
		}));
	}

	async status(): Promise<{ ok: boolean; detail: string }> {
		const session = await readOAuthSession(this.options.secretManager, 'claude');
		const apiKey = await this.options.secretManager.getApiKey(this.id);
		if (session) {
			return { ok: true, detail: `Signed in${session.email ? ` as ${session.email}` : ''}${session.subscriptionType ? ` (${session.subscriptionType})` : ''}.` };
		}
		if (apiKey) return { ok: true, detail: 'API key stored.' };
		return { ok: false, detail: 'Not connected. Use Wuchat: Connect AI Provider to sign in with your Claude account.' };
	}

	async *chat(request: ChatRequest, modelId: string): AsyncIterable<ChatChunk> {
		let token: string;
		let usingApiKey = false;
		try {
			token = await getAccessToken(this.options.secretManager, 'claude');
		} catch {
			const apiKey = await this.options.secretManager.getApiKey(this.id);
			if (!apiKey) {
				if (this.options.onMissingCredentials) await this.options.onMissingCredentials();
				yield { error: 'Claude is not connected. Run "Wuchat: Connect AI Provider" to sign in with your claude.ai account or store an API key.' };
				return;
			}
			token = apiKey;
			usingApiKey = true;
		}
		try {
			for await (const chunk of streamClaude(request, modelId, token, usingApiKey)) yield chunk;
		} catch (error) {
			// One automatic retry after a forced token refresh on auth failures.
			if (!usingApiKey && isAuthError(error)) {
				try {
					const refreshed = await getAccessToken(this.options.secretManager, 'claude', true);
					for await (const chunk of streamClaude(request, modelId, refreshed, false)) yield chunk;
					return;
				} catch { /* fall through to the original error */ }
			}
			yield { error: error instanceof Error ? error.message : String(error) };
		}
	}
}

function isAuthError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /\b401\b|unauthorized|authentication/i.test(message);
}

function prettifyModelName(id: string): string {
	return id.split('-').map(part => /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

/** Maps reasoning effort to Anthropic thinking budget. */
const EFFORT_BUDGET: Record<string, number> = { low: 2048, medium: 8192, high: 16_384 };

/** Stable per-install session id expected by the Claude Code backend. */
const claudeSessionId = randomUUID();

const MODERN_MODEL_PATTERN = /^claude-(?:opus|sonnet)-(?:4-6|5)(?:-|$)/;

/** Builds the request body with the system blocks the OAuth endpoint requires. */
function buildClaudeBody(request: ChatRequest, model: string, effort?: string): Record<string, unknown> {
	const modern = MODERN_MODEL_PATTERN.test(model);
	const budget = effort && effort !== 'auto' ? (EFFORT_BUDGET[effort] ?? 8192) : 0;
	const userSystem = request.history
		.filter(message => message.role === 'system')
		.map(message => message.content)
		.join('\n\n');
	const system = [
		...(usingOAuthSystem(model) ? [{ type: 'text', text: CLAUDE_BILLING_SYSTEM }, { type: 'text', text: CLAUDE_AGENT_SYSTEM }] : []),
		{ type: 'text', text: userSystem || 'You are Claude, a coding agent in Visual Studio Code. Be concise, correct, and use the supplied tools when useful.', cache_control: { type: 'ephemeral' } }
	];
	const messages = toClaudeMessages(request);
	return {
		model,
		max_tokens: Number(process.env.WUCHAT_MAX_OUTPUT_TOKENS ?? DEFAULT_MAX_TOKENS),
		stream: true,
		system,
		messages,
		...(modern && effort && effort !== 'auto'
			? { thinking: { type: 'adaptive' }, output_config: { effort } }
			: budget > 0 ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
		...(request.tools.length ? {
			tools: withLastCached(request.tools.map(tool => ({
				name: sanitizeToolName(tool.name),
				description: tool.description,
				input_schema: tool.inputSchema
			}))),
			tool_choice: { type: 'auto' }
		} : {})
	};
}

function usingOAuthSystem(model: string): boolean {
	// The billing header is tied to the claude-code client identity used by OAuth.
	return MODERN_MODEL_PATTERN.test(model) || Boolean(model.startsWith('claude-'));
}

function withLastCached(blocks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	if (!blocks.length) return blocks;
	return [...blocks.slice(0, -1), { ...blocks.at(-1), cache_control: { type: 'ephemeral' } }];
}

async function* streamClaude(request: ChatRequest, model: string, token: string, usingApiKey: boolean): AsyncIterable<ChatChunk> {
	const effort = request.modelOptions?.reasoningEffort;
	const authHeaders: Record<string, string> = usingApiKey
		? { 'x-api-key': token }
		: {
			authorization: `Bearer ${token}`,
			'anthropic-beta': CLAUDE_BETA,
			'anthropic-dangerous-direct-browser-access': 'true',
			'User-Agent': CLAUDE_USER_AGENT,
			'x-app': 'cli',
			'x-claude-code-session-id': claudeSessionId,
			'x-client-request-id': crypto.randomUUID()
		};
	const body = buildClaudeBody(request, model, effort);
	const response = await fetchJson(MESSAGES_URL, {
		method: 'POST',
		headers: {
			...authHeaders,
			Accept: 'text/event-stream',
			'Content-Type': 'application/json',
			'anthropic-version': '2023-06-01'
		},
		body: JSON.stringify(body)
	}, REQUEST_TIMEOUT_MS, request.token);
	if (!response.ok || !response.body) {
		throw new Error(`Anthropic API ${response.status}: ${await response.text().catch(() => response.statusText)}`);
	}
	const toolInputs = new Map<number, { id: string; name: string; input: string }>();
	for await (const data of readSse(response)) {
		const event = JSON.parse(data) as {
			type?: string;
			index?: number;
			error?: { message?: string };
			content_block?: { type?: string; id?: string; name?: string };
			delta?: { type?: string; text?: string; partial_json?: string; thinking?: string };
		};
		if (event.type === 'error') throw new Error(event.error?.message ?? 'Anthropic stream error.');
		if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use' && event.index !== undefined) {
			toolInputs.set(event.index, { id: event.content_block.id ?? '', name: event.content_block.name ?? '', input: '' });
		} else if (event.type === 'content_block_delta' && event.index !== undefined) {
			if (event.delta?.type === 'text_delta' && event.delta.text) yield { text: event.delta.text };
			if (event.delta?.type === 'thinking_delta' && event.delta.thinking) yield { reasoning: event.delta.thinking };
			if (event.delta?.type === 'input_json_delta') {
				const input = toolInputs.get(event.index);
				if (input) input.input += event.delta.partial_json ?? '';
			}
		} else if (event.type === 'content_block_stop' && event.index !== undefined) {
			const input = toolInputs.get(event.index);
			if (input) yield { toolCall: toToolCall(input.id, input.name, input.input) };
		}
	}
}

function toClaudeMessages(request: ChatRequest): Array<Record<string, unknown>> {
	const result: Array<Record<string, unknown>> = [];
	for (const message of request.history) {
		if (message.role === 'system') continue;
		if (message.role === 'tool') {
			result.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }] });
			continue;
		}
		const content: Array<Record<string, unknown>> = [];
		if (message.content) content.push({ type: 'text', text: message.content });
		for (const call of message.toolCallRequests ?? []) {
			content.push({ type: 'tool_use', id: call.id, name: sanitizeToolName(call.tool), input: (call.input ?? {}) as object });
		}
		result.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: content.length ? content : [{ type: 'text', text: '' }] });
	}
	if (request.prompt) {
		const content: Array<Record<string, unknown>> = [{ type: 'text', text: request.prompt }];
		for (const attachment of request.context.attachments) {
			if (!attachment.mimeType.startsWith('image/')) continue;
			content.push({
				type: 'image',
				source: { type: 'base64', media_type: attachment.mimeType, data: Buffer.from(attachment.data).toString('base64') }
			});
		}
		result.push({ role: 'user', content });
	}
	return result;
}
