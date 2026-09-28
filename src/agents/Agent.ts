/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  Agents own instructions, model preferences, tools and context policy.
 *--------------------------------------------------------------------------------------------*/

import {
	Agent,
	AgentCapabilities,
	AgentInvocationResult,
	AgentStep,
	AgentStreamCallbacks,
	ChatMessage,
	ChatRequest,
	CancellationToken,
	FileChange,
	LLMProvider,
	TodoItem,
	ToolCallRecord,
	ToolCallRequest,
	ToolProgress
} from '../common/types';
import { ToolRegistry } from '../tools/ToolRegistry';

export interface AgentOptions {
	id: string;
	name: string;
	description: string;
	systemPrompt: string;
	tools: readonly string[];
	capabilities: AgentCapabilities;
	provider?: string;
	model?: string;
	runtime?: {
		maxContextMessages?: number | (() => number);
		disabledTools?: () => readonly string[];
		autoApproveTools?: () => boolean;
		confirm?: (title: string, detail: string) => Promise<boolean>;
	};
}

/** Base agent implementation with streaming and bounded structured tool use. */
export class BaseAgent implements Agent {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly systemPrompt: string;
	readonly tools: readonly string[];
	readonly capabilities: AgentCapabilities;
	readonly provider?: string;
	readonly model?: string;

	constructor(
		private readonly options: AgentOptions,
		private readonly toolRegistry: ToolRegistry
	) {
		this.id = options.id;
		this.name = options.name;
		this.description = options.description;
		this.systemPrompt = options.systemPrompt;
		this.tools = options.tools;
		this.capabilities = options.capabilities;
		this.provider = options.provider;
		this.model = options.model;
	}

	async invoke(
		request: ChatRequest,
		llm: LLMProvider,
		model: string,
		callbacks: AgentStreamCallbacks = {}
	): Promise<AgentInvocationResult> {
		const toolCalls: ToolCallRecord[] = [];
		let text = '';
		let reasoning = '';
		const plan: AgentStep[] = [];
		let todos: TodoItem[] | undefined;
		const maxContextMessages = this.options.runtime?.maxContextMessages;
		let history = await buildContext(
			request,
			llm,
			model,
			callbacks,
			typeof maxContextMessages === 'function' ? maxContextMessages() : maxContextMessages ?? 40
		);
		const tools = buildToolDefinitions(this.tools, this.toolRegistry, this.options.runtime?.disabledTools?.() ?? []);
		const prompt = buildPrompt(this.systemPrompt, { ...request, tools });
		let connectionRetries = 0;
		let nextStreamPrompt = prompt;

		for (let round = 0; round < 5; round++) {
			if (request.token.isCancellationRequested) {
				break;
			}

			let continueRound = false;
			let resumes = 0;
			const toolRequests: ToolCallRequest[] = [];
			let turnText = '';
			const streamPrompt = nextStreamPrompt;
			nextStreamPrompt = '';
			const stream = llm.chat({
				...request,
				prompt: streamPrompt,
				history,
				tools
			}, model);

			for await (const chunk of stream) {
				if (request.token.isCancellationRequested) {
					break;
				}
				if (chunk.error) {
					if (isTransientConnectionError(chunk.error) && !request.token.isCancellationRequested) {
						connectionRetries++;
						const delay = Math.min(1_000 * 2 ** Math.min(connectionRetries - 1, 5), 30_000);
						callbacks.onSystemMessage?.(`Wuchat: conexão interrompida; nova tentativa em ${Math.ceil(delay / 1_000)}s (tentativa ${connectionRetries}).`);
						await waitForRetry(delay, request.token);
						if (!request.token.isCancellationRequested) {
							if (turnText.length > 0) {
								history.push({ role: 'assistant', content: turnText });
								history.push({ role: 'user', content: 'Continue exactly where you stopped. Do not repeat anything already written, do not add preamble.' });
								turnText = '';
							} else if (streamPrompt) {
								nextStreamPrompt = streamPrompt;
							}
							continueRound = true;
						}
						break;
					}
					// If the stream died mid-response, try to make the model continue
					// instead of losing the whole turn (up to MAX_STREAM_RESUMES times).
					if (turnText.length > 0 && resumes < MAX_STREAM_RESUMES) {
						resumes++;
						callbacks.onSystemMessage?.('Wuchat: the response was interrupted; continuing where it stopped…');
						history.push({ role: 'assistant', content: turnText });
						history.push({ role: 'user', content: 'Continue exactly where you stopped. Do not repeat anything already written, do not add preamble.' });
						turnText = '';
						continueRound = true;
						break;
					}
					return { text, reasoning: reasoning || undefined, toolCalls, plan: plan.length ? plan : undefined, todos, error: chunk.error };
				}
				if (chunk.text) {
					turnText += chunk.text;
					text += chunk.text;
					callbacks.onText?.(chunk.text);
				}
				if (chunk.reasoning) {
					reasoning += chunk.reasoning;
					callbacks.onReasoning?.(chunk.reasoning);
				}
				if (chunk.toolCall) {
					toolRequests.push(chunk.toolCall);
				}

			}

			if (continueRound) {
				round--;
				continue;
			}

			// Announce the steps (tool sequence) as a checklist before running them.
			if (toolRequests.length > 0) {
				plan.push(...toolRequests.map(call => ({ id: call.id, label: describeStep(call, this.tools, this.toolRegistry) })));
				callbacks.onPlan?.([...plan]);
			}

			if (request.token.isCancellationRequested || toolRequests.length === 0) {
				break;
			}

			if (round === 0) {
				history.push({ role: 'user', content: prompt });
			}
			history.push({ role: 'assistant', content: turnText, toolCallRequests: toolRequests });

			for (const call of toolRequests) {
				const toolId = this.tools.find(id => toModelToolName(id) === call.tool);
				const step = plan.find(item => item.id === call.id)!;
				const rawInput = toolInputToString(call.input);
				if (!toolId || !this.toolRegistry.get(toolId)) {
					const output = 'This tool is not allowed for the selected agent.';
				callbacks.onToolCall?.({ ...step, tool: call.tool, status: 'rejected', output });
					toolCalls.push({ ...call, output, status: 'rejected' });
					history.push({ role: 'tool', content: output, toolCallId: call.id, toolName: call.tool });
					continue;
				}

				const tool = this.toolRegistry.get(toolId)!;
				const autoApprove = this.toolRegistry.isSessionAutoApproved || (this.options.runtime?.autoApproveTools?.() ?? false);
				callbacks.onToolCall?.({ ...step, tool: toolId, status: tool.requiresApproval && !autoApprove ? 'awaiting' : 'started' });
				let output = '';
				let lastError: unknown;
				let change: FileChange | undefined;
				for (let attempt = 1; attempt <= MAX_TOOL_RETRIES; attempt++) {
					try {
						output = await this.toolRegistry.run(
							toolId,
							rawInput,
							autoApprove,
							request.token,
							async (title, detail) => {
								const approved = await (this.options.runtime?.confirm ?? denyConfirmation)(title, detail);
								if (approved) callbacks.onToolCall?.({ ...step, tool: toolId, status: 'started' });
								return approved;
							},
							{
								onFileChange: value => { change = value; },
								onTodos: value => { todos = value; callbacks.onTodos?.(value); }
							}
						);
						lastError = undefined;
						break;
					} catch (err) {
						lastError = err;
						const message = err instanceof Error ? err.message : String(err);
						// Rejected approvals and cancellations are final; transient tool
						// failures get up to MAX_TOOL_RETRIES attempts with short backoff.
						if (message.includes('not approved') || message.startsWith('Wuchat:') || request.token.isCancellationRequested) break;
						if (attempt < MAX_TOOL_RETRIES) {
							callbacks.onToolCall?.({ ...step, tool: toolId, status: 'retrying', output: message });
							await new Promise(resolve => setTimeout(resolve, Math.min(500 * 2 ** (attempt - 1), 4_000)));
							if (request.token.isCancellationRequested) break;
						}
					}
				}
				if (lastError !== undefined) {
					output = `Error: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
				}
				const status: ToolProgress['status'] = output.includes('not approved') ? 'rejected' : lastError !== undefined ? 'failed' : 'finished';
				callbacks.onToolCall?.({ ...step, tool: toolId, status, output: output.slice(0, 2000), ...(status === 'finished' ? { change } : {}) });
				// Keep the full output in the working history so follow-up rounds see it;
				// only the persisted record is truncated for storage.
				history.push({ role: 'tool', content: output, toolCallId: call.id, toolName: toolId });
				const record = { id: call.id, tool: toolId, input: call.input, output: output.slice(0, 2000), status, ...(status === 'finished' ? { change } : {}) };
				toolCalls.push(record);
			}
		}

		if (request.token.isCancellationRequested) {
			text += '\n\n_(generation cancelled)_';
		}
		return { text: text.trimEnd(), reasoning: reasoning || undefined, toolCalls, plan: plan.length ? plan : undefined, todos };
	}
}

/** Human-readable label for a planned tool call step. */
function describeStep(call: ToolCallRequest, agentTools: readonly string[], registry: ToolRegistry): string {
	const toolId = agentTools.find(id => toModelToolName(id) === call.tool) ?? call.tool;
	const input = toolInputToString(call.input);
	let detail = '';
	try {
		const parsed = JSON.parse(input) as { input?: string; url?: string; selector?: string; command?: string; path?: string };
		detail = parsed.input ?? parsed.url ?? parsed.selector ?? parsed.command ?? parsed.path ?? input;
	} catch {
		detail = input;
	}
	const tool = registry.get(toolId);
	const name = tool?.name ?? toolId;
	detail = detail.replace(/\s+/g, ' ').trim().slice(0, 60);
	return detail ? `${name}: ${detail}` : name;
}

function buildToolDefinitions(toolIds: readonly string[], registry: ToolRegistry, disabledTools: readonly string[]): ChatRequest['tools'] {
	const disabled = new Set(disabledTools);
	return toolIds.flatMap(id => {
		const tool = registry.get(id);
		if (!tool || disabled.has(id)) {
			return [];
		}
		return [{
			name: toModelToolName(tool.id),
			description: `${tool.description} Input: ${tool.inputSchema}`,
			inputSchema: {
				type: 'object',
				properties: { input: { type: 'string', description: tool.inputSchema } },
				required: ['input'],
				additionalProperties: false
			}
		}];
	});
}

function toModelToolName(toolId: string): string {
	return toolId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function toolInputToString(input: unknown): string {
	if (typeof input === 'string') {
		return input;
	}
	if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
		const value = (input as { input?: unknown }).input;
		if (typeof value === 'string') {
			return value;
		}
	}
	return JSON.stringify(input ?? {}) ?? '{}';
}

function buildPrompt(systemPrompt: string, request: ChatRequest): string {
	const contextParts: string[] = [];
	if (request.context.selection) {
		contextParts.push(`The user selected this ${request.context.selection.language} code in ${request.context.selection.uri}:\n\`\`\`\n${request.context.selection.text.slice(0, 20_000)}\n\`\`\``);
	}
	for (const attachment of request.context.attachments) {
		if (attachment.text !== undefined) {
			contextParts.push(`Attached file: ${attachment.name} (${attachment.uri})\n\`\`\`\n${attachment.text.slice(0, 40_000)}\n\`\`\``);
		} else {
			contextParts.push(`Attached image: ${attachment.name} (${attachment.uri})`);
		}
	}
	if (request.context.notes) {
		contextParts.push(request.context.notes);
	}

	const contextBlock = contextParts.length ? `\n\nWorkspace context:\n${contextParts.join('\n\n')}` : '';
	const toolBlock = request.tools.length
		? '\n\nUse the supplied structured tools directly when needed. Do not format tool requests as code blocks.'
		: '';
	return `Agent instructions:\n${systemPrompt}\n\nUser request:\n${request.prompt}${contextBlock}${toolBlock}`;
}

/** Maximum attempts for a single tool execution that fails transiently. */
const MAX_TOOL_RETRIES = 5;
/** How many times a truncated stream may be resumed within one turn. */
const MAX_STREAM_RESUMES = 3;
/** Characters that fit, very roughly, in a model context window (conservative). */
const APPROX_CONTEXT_CHARS = 160_000;

function isTransientConnectionError(message: string): boolean {
	return /fetch failed|network|socket|econn(reset|refused|aborted)|enotfound|etimedout|timed out|connection (?:lost|closed|reset)|bridge (?:was not found|is not available)|provider response did not include a stream/i.test(message);
}

function waitForRetry(delay: number, token: ChatRequest['token']): Promise<void> {
	return new Promise(resolve => {
		const timer = setTimeout(finish, delay);
		const subscription = token.onCancellationRequested(finish);
		function finish(): void {
			clearTimeout(timer);
			subscription.dispose();
			resolve();
		}
	});
}
/** Target size when compacting history so there is room for the new turn. */
const COMPACT_TARGET_CHARS = 60_000;

interface ContextSummaryEntry {
	summary: string;
}

/**
 * Builds the working history for a turn. Keeps the last messages verbatim and
 * summarizes older ones (once, lazily) when the transcript grows past a rough
 * character budget, so long sessions never silently forget earlier context.
 */
async function buildContext(
	request: ChatRequest,
	llm: LLMProvider,
	model: string,
	callbacks: AgentStreamCallbacks,
	maxContextMessages: number
): Promise<ChatMessage[]> {
	const history: ChatMessage[] = request.history.map(message => ({ ...message }));
	const markers = history.filter(message => message.role === 'system' && message.content.startsWith('[context summary]'));
	const baseIndex = markers.length ? history.indexOf(markers[markers.length - 1]) + 1 : 0;
	const base = history.slice(0, baseIndex);
	const rest = history.slice(baseIndex);

	const totalChars = rest.reduce((sum, message) => sum + message.content.length, 0);
	const budget = Math.max(4, maxContextMessages);
	if (totalChars <= APPROX_CONTEXT_CHARS && rest.length <= budget) {
		return history;
	}

	const keepCount = Math.min(rest.length, Math.max(4, Math.floor(budget / 2)));
	const old = rest.slice(0, rest.length - keepCount);
	const kept = rest.slice(rest.length - keepCount);
	const transcript = old
		.map(message => `${message.role}: ${message.content.slice(0, 4_000)}`)
		.join('\n\n')
		.slice(0, 60_000);

	try {
		callbacks.onSystemMessage?.('Wuchat: compacting older conversation context to keep memory of earlier turns…');
		const summary = await summarize(llm, model, transcript, request.token);
		const entry: ContextSummaryEntry = { summary };
		const summaryMessage: ChatMessage = {
			role: 'system',
			content: `[context summary] ${entry.summary}`
		};
		return [...base, summaryMessage, ...kept];
	} catch {
		// Summarization is best-effort; fall back to keeping the most recent turns.
		return [...base, ...kept];
	}
}

async function summarize(llm: LLMProvider, model: string, transcript: string, token: CancellationToken): Promise<string> {
	let summary = '';
	const stream = llm.chat({
		requestId: `compact-${Date.now()}`,
		agent: 'wuchat.compact',
		prompt: '',
		history: [
			{ role: 'user', content: `Summarize the following conversation so an assistant can continue it without losing any relevant fact, decision, file path or pending task. Be concise and factual, in the language of the conversation. Do not answer the user, only summarize.\n\n${transcript}` }
		],
		context: { attachments: [] },
		tools: [],
		token
	}, model);
	for await (const chunk of stream) {
		if (token.isCancellationRequested) break;
		if (chunk.error) throw new Error(chunk.error);
		if (chunk.text) summary += chunk.text;
	}
	if (!summary.trim()) throw new Error('empty summary');
	return summary.trim().slice(0, 12_000);
}

async function denyConfirmation(): Promise<boolean> {
	return false;
}
