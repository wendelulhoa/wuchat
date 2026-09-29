/*---------------------------------------------------------------------------------------------
 *  Wuchat — direct Z.AI GLM provider (API key, coding-plan endpoint).
 *  Ported from claude-for-copilot so Wuchat needs no companion extension.
 *--------------------------------------------------------------------------------------------*/

import { ChatChunk, ChatRequest, LLMProvider, ModelInfo } from '../../common/types';
import { SecretManager } from '../secrets';
import { readSse, toToolCall } from '../sse';

const CHAT_COMPLETIONS_URL = process.env.ZAI_BASE_URL
	? `${process.env.ZAI_BASE_URL.replace(/\/+$/, '')}/chat/completions`
	: 'https://api.z.ai/api/coding/paas/v4/chat/completions';

const MODELS: Array<{ id: string; name: string; detail: string }> = [
	{ id: 'glm-5.3', name: 'GLM-5.3', detail: 'Z.AI flagship coding model' },
	{ id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', detail: 'Z.AI fast multimodal model' }
];

export interface GlmProviderOptions {
	secretManager: SecretManager;
	onMissingCredentials?: () => Promise<void>;
}

export class GlmProvider implements LLMProvider {
	readonly id = 'zai-glm';
	readonly name = 'Z.AI GLM';

	constructor(private readonly options: GlmProviderOptions) { }

	async models(): Promise<ModelInfo[]> {
		const connected = Boolean(await this.options.secretManager.getApiKey(this.id));
		return MODELS.map(model => ({
			id: model.id,
			name: model.name,
			provider: this.id,
			detail: connected ? model.detail : `${model.detail} · connect to use`,
			capabilities: { streaming: true, tools: true, vision: true, maxInputTokens: 1_000_000 }
		}));
	}

	async status(): Promise<{ ok: boolean; detail: string }> {
		const connected = Boolean(await this.options.secretManager.getApiKey(this.id));
		return connected
			? { ok: true, detail: 'API key stored.' }
			: { ok: false, detail: 'No API key stored. Use Wuchat: Connect AI Provider.' };
	}

	async *chat(request: ChatRequest, modelId: string): AsyncIterable<ChatChunk> {
		const apiKey = await this.options.secretManager.getApiKey(this.id);
		if (!apiKey) {
			if (this.options.onMissingCredentials) await this.options.onMissingCredentials();
			yield { error: 'Z.AI GLM is not connected. Run "Wuchat: Connect AI Provider" and add your Z.AI API key.' };
			return;
		}
		try {
			for await (const chunk of streamGlm(request, modelId, apiKey)) yield chunk;
		} catch (error) {
			yield { error: error instanceof Error ? error.message : String(error) };
		}
	}
}

const EFFORT_LEVELS = new Set(['low', 'high', 'max']);

async function* streamGlm(request: ChatRequest, model: string, apiKey: string): AsyncIterable<ChatChunk> {
	const effort = request.modelOptions?.reasoningEffort;
	const payload: Record<string, unknown> = {
		model,
		stream: true,
		messages: toGlmMessages(request),
		temperature: 1,
		top_p: 0.95,
		...(effort && effort !== 'auto' && EFFORT_LEVELS.has(effort) ? { reasoning_effort: effort } : {}),
		thinking: { type: 'enabled', clear_thinking: false },
		...(request.tools.length ? {
			tools: request.tools.map(tool => ({
				type: 'function',
				function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
			})),
			tool_choice: 'auto',
			tool_stream: true
		} : {})
	};
	const response = await fetch(CHAT_COMPLETIONS_URL, {
		method: 'POST',
		headers: { authorization: `Bearer ${apiKey}`, accept: 'text/event-stream', 'content-type': 'application/json' },
		body: JSON.stringify(payload)
	});
	if (!response.ok || !response.body) {
		throw new Error(`Z.AI API ${response.status}: ${await response.text().catch(() => response.statusText)}`);
	}
	const calls = new Map<number, { id: string; name: string; arguments: string }>();
	for await (const data of readSse(response)) {
		if (data === '[DONE]') break;
		const event = JSON.parse(data) as {
			error?: { message?: string };
			choices?: Array<{ delta?: {
				content?: string;
				reasoning_content?: string;
				tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
			} }>;
		};
		if (event.error?.message) throw new Error(event.error.message);
		const delta = event.choices?.[0]?.delta;
		if (delta?.content) yield { text: delta.content };
		if (delta?.reasoning_content) yield { reasoning: delta.reasoning_content };
		for (const call of delta?.tool_calls ?? []) {
			const current = calls.get(call.index) ?? { id: '', name: '', arguments: '' };
			current.id += call.id ?? '';
			current.name += call.function?.name ?? '';
			current.arguments += call.function?.arguments ?? '';
			calls.set(call.index, current);
		}
	}
	for (const call of calls.values()) {
		if (call.id && call.name) yield { toolCall: toToolCall(call.id, call.name, call.arguments) };
	}
}

function toGlmMessages(request: ChatRequest): Array<Record<string, unknown>> {
	const messages: Array<Record<string, unknown>> = request.history.map(message => {
		if (message.role === 'tool') {
			return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
		}
		if (message.role === 'assistant' && message.toolCallRequests?.length) {
			return {
				role: 'assistant',
				content: message.content || null,
				tool_calls: message.toolCallRequests.map(call => ({
					id: call.id,
					type: 'function',
					function: { name: call.tool, arguments: JSON.stringify(call.input ?? {}) }
				}))
			};
		}
		return { role: message.role === 'system' ? 'system' : message.role, content: message.content };
	});
	if (request.prompt) {
		const imageParts = request.context.attachments
			.filter(attachment => attachment.mimeType.startsWith('image/'))
			.map(attachment => ({
				type: 'image_url',
				image_url: { url: `data:${attachment.mimeType};base64,${Buffer.from(attachment.data).toString('base64')}` }
			}));
		messages.push({ role: 'user', content: imageParts.length ? [{ type: 'text', text: request.prompt }, ...imageParts] : request.prompt });
	}
	return messages;
}
