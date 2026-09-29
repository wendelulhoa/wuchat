/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  Core types shared across the Wuchat architecture.
 *--------------------------------------------------------------------------------------------*/

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TodoItem {
	id: string;
	title: string;
	status: 'not-started' | 'in-progress' | 'completed';
}

export interface FileChange {
	path: string;
	before: string;
	after: string;
	added: number;
	removed: number;
	created?: boolean;
}

export interface AgentStep {
	id: string;
	label: string;
}

export interface ToolProgress extends AgentStep {
	tool: string;
	status: 'awaiting' | 'started' | 'finished' | 'failed' | 'rejected' | 'retrying';
	output?: string;
	change?: FileChange;
	/** Live streaming output for command steps (appended to the panel). */
	outputDelta?: string;
}

export interface ChatMessage {
	/** Metadata for files or browser context sent with this message; file contents are never stored here. */
	attachments?: Array<{ name: string; mimeType: string; uri?: string }>;
	role: ChatRole;
	content: string;
	/** Display name of the agent that produced an assistant message. */
	agent?: string;
	/** Provider used for this assistant turn, retained for error diagnostics. */
	provider?: string;
	/** Completed tool calls shown in the transcript. */
	toolCalls?: ToolCallRecord[];
	/** Structured tool calls used while continuing the current model turn. */
	toolCallRequests?: ToolCallRequest[];
	/** Tool result linkage for model conversation history. */
	toolCallId?: string;
	toolName?: string;
	/** Provider-supplied reasoning summary, when available. */
	reasoning?: string;
	/** Announced steps, retained with the answer for the activity view. */
	plan?: AgentStep[];
	/** Agent-managed task checklist for this response. */
	todos?: TodoItem[];
	/** Request error retained in session history for diagnostics. */
	error?: string;
}

export interface ToolCallRequest {
	id: string;
	tool: string;
	input: unknown;
}

export interface ToolCallRecord extends ToolCallRequest {
	output: string;
	status?: ToolProgress['status'];
	change?: FileChange;
}

export interface ChatRequest {
	/** Unique request id. */
	readonly requestId: string;
	/** Agent handling the request. */
	readonly agent: string;
	/** Latest user message. */
	readonly prompt: string;
	/** Previous conversation turns (oldest first). */
	readonly history: readonly ChatMessage[];
	/** Additional context (selection, attachments, file mentions). */
	readonly context: RequestContext;
	/** Tools available to this agent for this request. */
	readonly tools: readonly LLMToolDefinition[];
	/** Provider specific options, omitted when the provider should use its default. */
	readonly modelOptions?: { reasoningEffort?: string };
	/** Token to observe cancellation. */
	readonly token: CancellationToken;
}

export interface ChatAttachment {
	name: string;
	uri: string;
	mimeType: string;
	data: Uint8Array;
	text?: string;
}

export interface RequestContext {
	/** Active editor selection, if any. */
	selection?: { uri: string; text: string; language: string };
	/** Explicitly attached workspace or user-selected files. */
	attachments: ChatAttachment[];
	/** Free-form extra instructions coming from the UI. */
	notes?: string;
}

/** A streamed chunk coming from an LLM provider. */
export interface ChatChunk {
	text?: string;
	reasoning?: string;
	/** Marks the end of one reasoning block, so the UI can show separate steps. */
	reasoningBoundary?: boolean;
	toolCall?: ToolCallRequest;
	error?: string;
}

export interface CancellationToken {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	detail?: string;
	capabilities?: {
		streaming?: boolean;
		tools?: boolean;
		vision?: boolean;
		reasoning?: boolean;
		maxInputTokens?: number;
		maxOutputTokens?: number;
	};
}

export interface LLMToolDefinition {
	name: string;
	description: string;
	inputSchema: object;
}

/**
 * Provider-agnostic LLM contract. The Wuchat UI never talks to an LLM
 * directly — it always goes through this interface and the provider registry.
 */
export interface LLMProvider {
	readonly id: string;
	readonly name: string;

	/** Stream a chat completion as an async iterable of chunks. */
	chat(request: ChatRequest, model: string): AsyncIterable<ChatChunk>;

	/** Abort an in-flight request. Optional. */
	abort?(requestId: string): void;

	/** List models offered by this provider. Optional. */
	models?(): Promise<ModelInfo[]>;

	/** Human readable status used in the Chat Settings menu. */
	status?(): Promise<{ ok: boolean; detail: string }>;
}

export interface AgentInvocationResult {
	/** Final assistant text. */
	text: string;
	/** Provider-supplied reasoning summary, when available. */
	reasoning?: string;
	/** Tool calls executed during the invocation. */
	toolCalls: ToolCallRecord[];
	/** Steps the agent announced it would take (shown as a checklist). */
	plan?: AgentStep[];
	todos?: TodoItem[];
	/** Error message, if the invocation failed. */
	error?: string;
}

export interface AgentStreamCallbacks {
	onText?(text: string): void;
	onReasoning?(text: string): void;
	/** Ends the current reasoning step, so the UI shows separate entries. */
	onReasoningBoundary?(): void;
	onToolCall?(progress: ToolProgress): void;
	/** Steps the agent announced (called once per plan announcement). */
	onPlan?(steps: AgentStep[]): void;
	onTodos?(todos: TodoItem[]): void;
	/** Progress notes (context compaction, stream resumes, retries). */
	onSystemMessage?(text: string): void;
}

/**
 * An agent interprets a user request, may call tools and produces text.
 * Implementations are provider-agnostic: they consume an LLMProvider.
 */
export interface Agent {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	/** System prompt describing how the agent behaves. */
	readonly systemPrompt: string;
	/** Tool ids this agent is allowed to use. */
	readonly tools: readonly string[];
	/** Which VS Code context the agent can read. */
	readonly capabilities: AgentCapabilities;
	/** Optional model defaults owned by this agent. */
	readonly provider?: string;
	readonly model?: string;

	invoke(request: ChatRequest, llm: LLMProvider, model: string, callbacks?: AgentStreamCallbacks): Promise<AgentInvocationResult>;
}

export interface AgentCapabilities {
	/** Can read open editors / selection. */
	readEditor: boolean;
	/** Can read workspace files. */
	readWorkspace: boolean;
	/** Can edit files (requires tool confirmation). */
	editFiles: boolean;
	/** Can run terminal commands (requires tool confirmation). */
	runTerminal: boolean;
}

export interface WuchatToolInvocationContext {
	token: CancellationToken;
	/** Ask the user to confirm a sensitive action. Resolves true when approved. */
	confirm(title: string, detail: string): Promise<boolean>;
	onFileChange?(change: FileChange): void;
	onTodos?(todos: TodoItem[]): void;
	/** Streams live tool output (terminal chunks) to the chat panel. */
	onOutput?(delta: string): void;
}

/** A tool an agent can call (read/edit files, run commands, ...). */
export interface WuchatTool {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	/** Whether invoking the tool requires user confirmation. */
	readonly requiresApproval: boolean;
	/** Human-readable description of the input string accepted by this tool. */
	readonly inputSchema: string;

	invoke(rawInput: string, ctx: WuchatToolInvocationContext): Promise<string>;
}
