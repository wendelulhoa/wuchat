import {
	ChatChunk,
	ChatMessage,
	ChatRequest,
	LLMProvider,
	ModelInfo,
	ToolCallRequest
} from '../common/types';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

export type CliProviderId = 'openai' | 'anthropic' | 'zai';

interface BridgeDescriptor { port: number; token: string }
interface ConnectedConfig { provider: string; name: string; model: string }
interface ConnectedModels { provider: string; name: string; models: Array<{ id: string; name: string; detail?: string }> }

const bridgeDescriptorPath = path.join(homedir(), '.wuchat', 'vscode-provider.json');

async function bridgeRequest(pathname: string, init?: RequestInit): Promise<Response> {
	const descriptor = await readBridgeDescriptor();
	return fetch(`http://127.0.0.1:${descriptor.port}${pathname}`, {
		...init,
		headers: { authorization: `Bearer ${descriptor.token}`, ...(init?.headers ?? {}) }
	});
}

export async function listConnectedModels(): Promise<ConnectedModels> {
	const response = await bridgeRequest('/models');
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(detail || `Wuchat provider bridge returned HTTP ${response.status}.`);
	}
	return response.json() as Promise<ConnectedModels>;
}

export async function setConnectedModel(model: string): Promise<void> {
	const response = await bridgeRequest('/model', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model })
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(detail || `Could not switch model (HTTP ${response.status}).`);
	}
}

export async function connectedCliProvider(): Promise<{ provider: LLMProvider; model: string }> {
	const response = await bridgeRequest('/config');
	if (!response.ok) throw new Error('Wuchat VS Code provider bridge is not available. Keep VS Code open and Wuchat activated.');
	const config = await response.json() as ConnectedConfig;
	let activeOverride: string | undefined;
	const provider: LLMProvider & { setModel?: (model: string) => void } = {
		id: `vscode-bridge:${config.provider}`,
		name: `${config.name} (VS Code sign-in)`,
		chat: (request) => streamConnected(request, activeOverride),
		setModel(model: string) { activeOverride = model; }
	};
	return { model: config.model, provider };
}

export async function resolveCliProvider(options: { connectedOnly?: boolean; apiMode?: boolean }): Promise<{ provider: LLMProvider; model: string }> {
	if (options.connectedOnly) return connectedCliProvider();
	if (options.apiMode || process.env.WUCHAT_PROVIDER) {
		return configuredCliProvider();
	}
	try {
		return await connectedCliProvider();
	} catch {
		throw new Error(
			'No authenticated Wuchat provider bridge is active. Open VS Code, authenticate/select a provider in Wuchat, then run “Wuchat: Open Connected CLI”. To use an API key explicitly, set WUCHAT_PROVIDER and its matching API key.'
		);
	}
}

export function createCliProvider(id: CliProviderId): LLMProvider {
	return {
		id,
		name: id === 'zai' ? 'Z.AI' : id === 'anthropic' ? 'Anthropic' : 'OpenAI API',
		chat: (request, model) => id === 'anthropic'
			? streamAnthropic(request, model)
			: streamOpenAiCompatible(request, model, id)
	};
}

export function configuredCliProvider(): { provider: LLMProvider; model: string } {
	const id = (process.env.WUCHAT_PROVIDER ?? '').toLowerCase() as CliProviderId;
	if (!['openai', 'anthropic', 'zai'].includes(id)) {
		throw new Error('Set WUCHAT_PROVIDER to openai, anthropic, or zai to select direct API-key mode.');
	}
	const keyName = id === 'anthropic' ? 'ANTHROPIC_API_KEY' : id === 'zai' ? 'ZAI_API_KEY' : 'OPENAI_API_KEY';
	if (!process.env[keyName]) {
		throw new Error(`Set ${keyName} in the environment to use the ${id} CLI provider.`);
	}
	const model = process.env.WUCHAT_MODEL ?? (
		id === 'anthropic' ? 'claude-sonnet-4-5' : id === 'zai' ? 'glm-4.7' : 'gpt-4.1'
	);
	return { provider: createCliProvider(id), model };
}

async function* streamOpenAiCompatible(request: ChatRequest, model: string, provider: 'openai' | 'zai'): AsyncIterable<ChatChunk> {
	const key = process.env[provider === 'zai' ? 'ZAI_API_KEY' : 'OPENAI_API_KEY']!;
	const endpoint = chatCompletionsEndpoint(
		provider === 'zai' ? process.env.ZAI_BASE_URL : process.env.OPENAI_BASE_URL,
		provider === 'zai' ? 'https://api.z.ai/api/paas/v4' : 'https://api.openai.com/v1'
	);
	const messages = request.history.map(toOpenAiMessage);
	if (request.prompt) messages.push({ role: 'user', content: request.prompt });
	const payload: Record<string, unknown> = { model, messages, stream: true };
	if (request.tools.length) {
		payload.tools = request.tools.map(tool => ({
			type: 'function',
			function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
		}));
		payload.tool_choice = 'auto';
	}
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
		body: JSON.stringify(payload)
	});
	if (!response.ok) throw new Error(`${provider} API ${response.status}: ${await response.text()}`);
	const calls = new Map<number, { id: string; name: string; arguments: string }>();
	for await (const data of readSse(response)) {
		if (data === '[DONE]') break;
		const event = JSON.parse(data) as {
			choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }>;
		};
		const delta = event.choices?.[0]?.delta;
		if (delta?.content) yield { text: delta.content };
		for (const call of delta?.tool_calls ?? []) {
			const current = calls.get(call.index) ?? { id: '', name: '', arguments: '' };
			current.id += call.id ?? '';
			current.name += call.function?.name ?? '';
			current.arguments += call.function?.arguments ?? '';
			calls.set(call.index, current);
		}
	}
	for (const call of calls.values()) {
		yield { toolCall: toToolCall(call.id, call.name, call.arguments) };
	}
}

async function* streamAnthropic(request: ChatRequest, model: string): AsyncIterable<ChatChunk> {
	const response = await fetch(process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'x-api-key': process.env.ANTHROPIC_API_KEY!,
			'anthropic-version': '2023-06-01',
			'content-type': 'application/json'
		},
		body: JSON.stringify({
			model,
			max_tokens: Number(process.env.WUCHAT_MAX_OUTPUT_TOKENS ?? 8192),
			stream: true,
			messages: toAnthropicMessages(request.history, request.prompt),
			tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }))
		})
	});
	if (!response.ok) throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
	const toolInputs = new Map<number, { id: string; name: string; input: string }>();
	for await (const data of readSse(response)) {
		const event = JSON.parse(data) as {
			type?: string;
			index?: number;
			content_block?: { type?: string; id?: string; name?: string };
			delta?: { type?: string; text?: string; partial_json?: string };
		};
		if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use' && event.index !== undefined) {
			toolInputs.set(event.index, { id: event.content_block.id ?? '', name: event.content_block.name ?? '', input: '' });
		} else if (event.type === 'content_block_delta' && event.index !== undefined) {
			if (event.delta?.type === 'text_delta' && event.delta.text) yield { text: event.delta.text };
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

function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
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
				function: { name: call.tool, arguments: JSON.stringify(call.input) }
			}))
		};
	}
	return { role: message.role === 'system' ? 'system' : message.role, content: message.content };
}

function toAnthropicMessages(history: readonly ChatMessage[], prompt: string): Array<Record<string, unknown>> {
	const result: Array<Record<string, unknown>> = [];
	for (const message of history) {
		if (message.role === 'system') continue;
		if (message.role === 'tool') {
			result.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }] });
			continue;
		}
		const content: Array<Record<string, unknown>> = [];
		if (message.content) content.push({ type: 'text', text: message.content });
		for (const call of message.toolCallRequests ?? []) {
			content.push({ type: 'tool_use', id: call.id, name: call.tool, input: call.input });
		}
		result.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: content.length ? content : [{ type: 'text', text: '' }] });
	}
	if (prompt) result.push({ role: 'user', content: prompt });
	return result;
}

function toToolCall(id: string, name: string, rawInput: string): ToolCallRequest {
	let input: unknown;
	try { input = JSON.parse(rawInput || '{}'); } catch { input = { input: rawInput }; }
	return { id: id || `call-${Date.now()}`, tool: name, input };
}

function chatCompletionsEndpoint(baseUrl: string | undefined, fallback: string): string {
	const normalized = (baseUrl ?? fallback).replace(/\/+$/, '');
	return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}

async function* streamConnected(request: ChatRequest, modelOverride?: string): AsyncIterable<ChatChunk> {
	const descriptor = await readBridgeDescriptor();
	const response = await fetch(`http://127.0.0.1:${descriptor.port}/chat`, {
		method: 'POST',
		headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ request: { ...request, token: undefined }, ...(modelOverride ? { modelOverride } : {}) })
	});
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(detail || `Wuchat provider bridge returned HTTP ${response.status}.`);
	}
	for await (const data of readSse(response)) {
		if (data === '[DONE]') break;
		yield JSON.parse(data) as ChatChunk;
	}
}

async function readBridgeDescriptor(): Promise<BridgeDescriptor> {
	try {
		const descriptor = JSON.parse(await readFile(bridgeDescriptorPath, 'utf8')) as BridgeDescriptor;
		if (!Number.isInteger(descriptor.port) || typeof descriptor.token !== 'string') throw new Error();
		return descriptor;
	} catch {
		throw new Error('Wuchat VS Code provider bridge was not found. Open VS Code with Wuchat active, then run `wuchat --connected`.');
	}
}

async function* readSse(response: Response): AsyncIterable<string> {
	if (!response.body) throw new Error('Provider response did not include a stream.');
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { value, done } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		const events = buffer.split(/\r?\n\r?\n/);
		buffer = events.pop() ?? '';
		for (const event of events) {
			const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
			if (data) yield data;
		}
		if (done) break;
	}
}