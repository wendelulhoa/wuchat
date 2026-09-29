/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  Sanity checks that run in plain Node (no vscode dependency).
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as nodeModule from 'node:module';
import * as nodePath from 'node:path';
import { ChatSession } from '../chat/sessions/ChatSession';
import { BaseAgent, restoreAssistantContext } from '../agents/Agent';
import { ProviderRegistry } from '../llm/ProviderRegistry';
import { EchoProvider } from '../llm/providers/echoProvider';
import { AgentStep, ChatMessage, ChatRequest, ToolProgress } from '../common/types';
import { ToolRegistry } from '../tools/ToolRegistry';
import { fileChange, updateTodosTool } from '../tools/progress';

void (async (): Promise<void> => {
	const session = new ChatSession('Test');
	session.append({ role: 'user', content: 'hello' });
	assert.strictEqual(session.messages.length, 1);
	assert.strictEqual(session.title, 'Test');

	const stored = session.toStored();
	const restored = ChatSession.from(stored);
	assert.strictEqual(restored.id, session.id);
	assert.strictEqual(restored.messages.length, 1);

	const registry = new ProviderRegistry();
	registry.register(new EchoProvider());
	assert.strictEqual(registry.get('echo')?.id, 'echo');
	assert.throws(() => registry.getRequired('missing'));

	const provider = registry.getRequired('echo');
	const request: ChatRequest = {
		requestId: 'r1',
		agent: 'wuchat.ask',
		prompt: 'ping',
		history: [],
		context: { attachments: [] },
		tools: [],
		token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { } }) }
	};

	let text = '';
	for await (const chunk of provider.chat(request, 'echo-1')) {
		text += chunk.text ?? '';
	}
	assert.ok(text.includes('ping'));

	const tools = new ToolRegistry();
	tools.register({ id: 'test.inspect', name: 'Inspect file', description: 'Read a file', inputSchema: 'path', requiresApproval: false, invoke: async input => `Read ${input}` });
	tools.register({ id: 'test.change', name: 'Change file', description: 'Change a file', inputSchema: 'path', requiresApproval: true, invoke: async () => 'Changed' });
	tools.register(updateTodosTool);
	tools.register({ id: 'test.write', name: 'Write file', description: 'Write a file', inputSchema: 'path', requiresApproval: false, invoke: async (_input, ctx) => {
		ctx.onFileChange?.(fileChange('src/a.ts', 'before', 'after'));
		return 'Changed';
	} });
	tools.register({ id: 'test.fail', name: 'Failed edit', description: 'Reject invalid edit', inputSchema: 'path', requiresApproval: false, invoke: async () => { throw new Error('Wuchat: invalid line range.'); } });
	const agent = new BaseAgent({
		id: 'test.agent', name: 'Test agent', description: 'Tests progress', systemPrompt: 'Test',
		tools: ['test.inspect', 'test.change', 'wuchat.updateTodos', 'test.write', 'test.fail'],
		capabilities: { readEditor: false, readWorkspace: true, editFiles: true, runTerminal: false },
		runtime: { confirm: async () => false }
	}, tools);
	let round = 0;
	const steps: AgentStep[][] = [];
	const progress: ToolProgress[] = [];
	const taskUpdates: string[][] = [];
	const result = await agent.invoke(request, {
		id: 'test', name: 'Test provider',
		async *chat() {
			if (round++ === 0) {
				yield { reasoning: 'Checking files' };
				yield { toolCall: { id: 'read-1', tool: 'test_inspect', input: { input: 'src/a.ts' } } };
				yield { toolCall: { id: 'todo-1', tool: 'wuchat_updateTodos', input: { input: JSON.stringify({ todos: [{ id: '1', title: 'Edit file', status: 'in-progress' }] }) } } };
				yield { toolCall: { id: 'write-1', tool: 'test_write', input: { input: 'src/a.ts' } } };
				yield { toolCall: { id: 'fail-1', tool: 'test_fail', input: { input: 'src/b.ts' } } };
				yield { toolCall: { id: 'edit-1', tool: 'test_change', input: { input: 'src/a.ts' } } };
			} else if (round === 2) {
				yield { toolCall: { id: 'todo-2', tool: 'wuchat_updateTodos', input: { input: JSON.stringify({ todos: [{ id: '1', title: 'Edit file', status: 'completed' }] }) } } };
			} else {
				yield { text: 'Finished checking.' };
			}
		}
	}, 'test-model', {
		onPlan: planned => steps.push(planned),
		onToolCall: event => progress.push(event),
		onTodos: todos => taskUpdates.push(todos.map(item => item.title))
	});
	assert.deepStrictEqual(steps[0].map(step => step.id), ['read-1', 'todo-1', 'write-1', 'fail-1', 'edit-1']);
	assert.match(steps[0][0].label, /Inspect file: src\/a.ts/);
	assert.deepStrictEqual(progress.map(event => [event.id, event.status]), [
		['read-1', 'started'], ['read-1', 'finished'], ['todo-1', 'started'], ['todo-1', 'finished'],
		['write-1', 'started'], ['write-1', 'finished'], ['fail-1', 'started'], ['fail-1', 'failed'],
		['edit-1', 'awaiting'], ['edit-1', 'rejected'], ['todo-2', 'started'], ['todo-2', 'finished']
	]);
	assert.deepStrictEqual(taskUpdates, [['Edit file'], ['Edit file']]);
	assert.deepStrictEqual(result.todos, [{ id: '1', title: 'Edit file', status: 'completed' }]);
	await assert.rejects(updateTodosTool.invoke(JSON.stringify({ todos: [
		{ id: ' a ', title: 'First', status: 'not-started' }, { id: 'a', title: 'Duplicate', status: 'not-started' }
	] }), { token: request.token, confirm: async () => true }), /unique todos/);
	assert.deepStrictEqual(progress.find(event => event.id === 'write-1' && event.status === 'finished')?.change, fileChange('src/a.ts', 'before', 'after'));
	assert.strictEqual(progress.find(event => event.id === 'fail-1' && event.status === 'failed')?.change, undefined);
	assert.strictEqual(result.reasoning, 'Checking files');
	assert.strictEqual(result.toolCalls[0].status, 'finished');
	assert.strictEqual(result.toolCalls[3].status, 'failed');
	assert.strictEqual(result.toolCalls[4].status, 'rejected');
	assert.strictEqual(result.plan?.length, 6);
	session.append({ role: 'assistant', content: result.text, plan: result.plan, todos: result.todos, reasoning: result.reasoning, toolCalls: result.toolCalls });
	const replayed = ChatSession.from(session.toStored()).messages.at(-1);
	assert.deepStrictEqual(replayed?.plan, result.plan);
	assert.deepStrictEqual(replayed?.todos, result.todos);
	assert.deepStrictEqual(replayed?.toolCalls?.map(call => call.status), ['finished', 'finished', 'finished', 'failed', 'rejected', 'finished']);
	assert.deepStrictEqual(replayed?.toolCalls?.[2].change, fileChange('src/a.ts', 'before', 'after'));
	let toolRounds = 0;
	const longResult = await agent.invoke(request, {
		id: 'test', name: 'Test provider',
		async *chat() {
			if (toolRounds < 6) {
				yield { toolCall: { id: `read-${toolRounds++}`, tool: 'test_inspect', input: { input: 'src/a.ts' } } };
			} else {
				yield { text: 'All six checks complete.' };
			}
		}
	}, 'test-model');
	assert.strictEqual(longResult.toolCalls.length, 6);
	assert.strictEqual(longResult.text, 'All six checks complete.');
	assert.strictEqual(longResult.error, undefined);
	let resumedHistory: ChatRequest['history'] = [];
	const resumed = await agent.invoke({
		...request,
		prompt: 'continue',
		history: [{ role: 'user', content: 'Build a car app' }, {
			role: 'assistant', content: 'Created the package.',
			todos: [{ id: '1', title: 'Build CRUD server', status: 'in-progress' }],
			toolCalls: [{ id: 'write-1', tool: 'wuchat.writeFile', input: { input: 'package.json' }, output: 'Wrote package.json', status: 'finished' }]
		}]
	}, {
		id: 'test', name: 'Test provider',
		async *chat(currentRequest) {
			resumedHistory = currentRequest.history;
			yield { text: 'Continuing the server.' };
		}
	}, 'test-model');
	assert.ok(resumed.text.startsWith('Continuing the server.'.repeat(3)));
	assert.match(resumed.text, /pendentes: Build CRUD server/);
	assert.match(resumed.error ?? '', /unfinished tasks/);
	assert.match(resumedHistory[1].content, /in-progress: Build CRUD server/);
	assert.match(resumedHistory[1].content, /Wrote package\.json/);
	assert.strictEqual(resumedHistory[0].content, 'Build a car app');
	const compactedContext = restoreAssistantContext({
		role: 'assistant', content: 'Long response '.repeat(400),
		todos: [{ id: '1', title: 'Build CRUD server', status: 'in-progress' }],
		toolCalls: [{ id: 'write-1', tool: 'wuchat.writeFile', input: undefined, output: 'Wrote package.json' }]
	}).content.slice(0, 4_000);
	assert.match(compactedContext, /in-progress: Build CRUD server/);
	assert.match(compactedContext, /Wrote package\.json/);
	const olderFileContext = restoreAssistantContext({
		role: 'assistant', content: 'Work in progress',
		toolCalls: [
			{ id: 'first', tool: 'wuchat.writeFile', input: {}, output: 'Wrote src/server.ts',
				change: { path: 'src/server.ts', before: '', after: 'server', added: 1, removed: 0 } },
			...Array.from({ length: 12 }, (_, index) => ({ id: `later-${index}`, tool: 'test.inspect', input: {}, output: 'Checked' }))
		]
	}).content;
	assert.match(olderFileContext, /Earlier changed files: src\/server\.ts/);
	let continuationRounds = 0;
	const continued = await agent.invoke({
		...request, prompt: 'continue', history: [{ role: 'assistant', content: 'Started work',
			todos: [{ id: '1', title: 'Build CRUD server', status: 'in-progress' }] }]
	}, {
		id: 'test', name: 'Test provider',
		async *chat(currentRequest) {
			continuationRounds++;
			if (continuationRounds === 1) yield { text: 'Working on the server.' };
			else if (continuationRounds === 2) {
				assert.match(currentRequest.history.at(-1)?.content ?? '', /unfinished tasks/);
				yield { toolCall: { id: 'finish', tool: 'wuchat_updateTodos', input: { input: JSON.stringify({ todos: [{ id: '1', title: 'Build CRUD server', status: 'completed' }] }) } } };
			} else yield { text: 'Server verified.' };
		}
	}, 'test-model');
	assert.strictEqual(continuationRounds, 3);
	assert.strictEqual(continued.todos?.[0].status, 'completed');
	assert.strictEqual(continued.error, undefined);
	const unrelated = await agent.invoke({
		...request, prompt: 'What time is it?', history: [{ role: 'assistant', content: 'Pending other work',
			todos: [{ id: '1', title: 'Build CRUD server', status: 'in-progress' }] }]
	}, {
		id: 'test', name: 'Test provider',
		async *chat() { yield { text: 'Now.' }; }
	}, 'test-model');
	assert.strictEqual(unrelated.text, 'Now.');
	assert.strictEqual(unrelated.todos, undefined);
	assert.strictEqual(unrelated.error, undefined);
	tools.register({ id: 'mcp.dynamic', name: 'Dynamic MCP', description: 'Test MCP tool', inputSchema: 'input', requiresApproval: false,
		invoke: async () => 'Invoked MCP' });
	const extraTools: string[] = [];
	const disabledTools: string[] = [];
	const dynamicAgent = new BaseAgent({
		id: 'test.dynamic', name: 'Dynamic', description: 'Tests live tools', systemPrompt: 'Test', tools: [],
		capabilities: { readEditor: false, readWorkspace: false, editFiles: false, runTerminal: false },
		runtime: { additionalTools: () => extraTools, disabledTools: () => disabledTools }
	}, tools);
	const dynamicProvider = {
		id: 'test', name: 'Test provider',
		async *chat(currentRequest: ChatRequest) {
			if (currentRequest.history.some(message => message.role === 'tool')) {
				yield { text: 'Finished.' };
			} else if (currentRequest.tools.length) {
				assert.strictEqual(currentRequest.tools[0].name, 'mcp_dynamic');
				yield { toolCall: { id: 'dynamic', tool: 'mcp_dynamic', input: { input: '{}' } } };
			} else {
				yield { text: 'No tool.' };
			}
		}
	};
	assert.strictEqual((await dynamicAgent.invoke(request, dynamicProvider, 'test-model')).text, 'No tool.');
	extraTools.push('mcp.dynamic');
	assert.strictEqual((await dynamicAgent.invoke(request, dynamicProvider, 'test-model')).toolCalls[0].output, 'Invoked MCP');
	disabledTools.push('mcp.dynamic');
	const disabledResult = await dynamicAgent.invoke(request, {
		id: 'test', name: 'Test provider',
		async *chat(currentRequest) {
			assert.strictEqual(currentRequest.tools.length, 0);
			if (currentRequest.history.some(message => message.role === 'tool')) yield { text: 'Done.' };
			else yield { toolCall: { id: 'denied', tool: 'mcp_dynamic', input: { input: '{}' } } };
		}
	}, 'test-model');
	assert.strictEqual(disabledResult.toolCalls[0].status, 'rejected');
	let automaticSummaryPrompt = '';
	const compacted = await agent.invoke({
		...request, prompt: 'What happened?',
		history: Array.from({ length: 46 }, (_, index) => ({
			role: 'assistant' as const,
			content: `Step ${index}: ${index === 15 ? 'Kept an earlier decision. ' : ''}` + 'details '.repeat(600),
			...(index === 14 ? { todos: [{ id: '1', title: 'Verify CLI', status: 'in-progress' as const }] } : {})
		}))
	}, {
		id: 'test', name: 'Test provider',
		async *chat(currentRequest) {
			if (currentRequest.agent === 'wuchat.compact') {
				automaticSummaryPrompt = currentRequest.history[0].content;
				yield { text: 'Summary of earlier steps.' };
			} else {
				assert.match(currentRequest.history.find(message => message.role === 'system')?.content ?? '', /Summary of earlier steps/);
				yield { text: 'Answer.' };
			}
		}
	}, 'test-model');
	assert.strictEqual(compacted.text, 'Answer.');
	assert.match(automaticSummaryPrompt, /Kept an earlier decision/);
	assert.match(automaticSummaryPrompt, /Latest saved task status:\nin-progress: Verify CLI/);
	// Mid-run auto-compaction: tool outputs overflowing the model window during
	// an agentic loop are summarized between rounds.
	let midRunSummaries = 0;
	const overflowAgent = new BaseAgent({
		id: 'test.overflow', name: 'Overflow', description: 'Tests mid-run compaction', systemPrompt: 'Test',
		tools: ['test.inspect'],
		capabilities: { readEditor: false, readWorkspace: true, editFiles: false, runTerminal: false }
	}, tools);
	let overflowRound = 0;
	const overflowResult = await overflowAgent.invoke(request, {
		id: 'test', name: 'Test provider',
		models: async () => [{ id: 'test-model', name: 'Test', provider: 'test', capabilities: { maxInputTokens: 8_000 } }],
		async *chat(currentRequest: ChatRequest) {
			if (currentRequest.agent === 'wuchat.compact') {
				midRunSummaries++;
				yield { text: `Mid-run summary ${midRunSummaries}.` };
				return;
			}
			overflowRound++;
			if (overflowRound < 4) {
				// Push large tool outputs so the in-loop history crosses the budget.
				yield { toolCall: { id: `dump-${overflowRound}`, tool: 'test_inspect', input: { input: 'x'.repeat(30_000) } } };
			} else {
				assert.match(currentRequest.history.find((message: ChatMessage) => message.role === 'system')?.content ?? '', /Mid-run summary/);
				yield { text: 'Done.' };
			}
		}
	} as never, 'test-model');
	assert.strictEqual(overflowResult.text, 'Done.');
	assert.ok(midRunSummaries >= 1, 'expected at least one mid-run compaction');

	const moduleLoader = nodeModule.default as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
	const originalLoad = moduleLoader._load;
	let endExecution: ((event: { execution: unknown; exitCode: number | undefined }) => void) | undefined;
	let closeTerminal: ((terminal: unknown) => void) | undefined;
	let terminalOutput = 'x'.repeat(24_001);
	let terminalCode: number | undefined = 3;
	let closeBeforeEnd = false;
	let resumeRead: (() => void) | undefined;
	const execution = {
		async *read() {
			yield terminalOutput;
			if (closeBeforeEnd) {
				closeTerminal?.(terminal);
				await new Promise<void>(resolve => { resumeRead = resolve; });
			}
			else endExecution?.({ execution, exitCode: terminalCode });
		}
	};
	const terminal: { name: string; show(): void; shellIntegration?: { executeCommand: () => typeof execution } } =
		{ name: 'Wuchat Agent', show() {}, shellIntegration: { executeCommand: () => execution } };
	const mcpTools: Array<{ name: string; description: string; inputSchema: object }> = [];
	const vscodeMock = {
		lm: { tools: mcpTools },
		extensions: { onDidChange: () => ({ dispose() {} }) },
		workspace: {
			workspaceFolders: [{ uri: { scheme: 'file', fsPath: process.cwd() } }],
			getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
			fs: undefined as unknown
		},
		Uri: {
			joinPath: (base: { path: string; scheme: string; authority: string }, relative: string) => ({
				...base, path: nodePath.posix.resolve(base.path, relative)
			}),
			file: (fsPath: string) => ({ scheme: 'file', authority: '', path: fsPath.split('\\').join('/'), fsPath })
		},
		FileType: { Directory: 2, File: 0 },
		window: {
			terminals: [terminal],
			onDidChangeTerminalShellIntegration: () => ({ dispose() {} }),
			onDidEndTerminalShellExecution: (listener: typeof endExecution) => {
				endExecution = listener;
				return { dispose() { endExecution = undefined; } };
			},
			onDidCloseTerminal: (listener: typeof closeTerminal) => {
				closeTerminal = listener;
				return { dispose() { closeTerminal = undefined; } };
			}
		},
		CancellationTokenSource: class {
			readonly token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
			cancel(): void { this.token.isCancellationRequested = true; }
			dispose(): void {}
		}
	};
	moduleLoader._load = function (name, ...args) {
		if (name === 'vscode') return vscodeMock;
		return originalLoad.call(this, name, ...args);
	};
	try {
		const { registerMcpTools } = await import('../tools/mcpBridge');
		const mcpRegistry = new ToolRegistry();
		const mcpBridge = registerMcpTools(mcpRegistry, { info() {} } as never);
		assert.strictEqual(mcpRegistry.get('mcp.test'), undefined);
		mcpTools.push({ name: 'test', description: 'Test tool', inputSchema: { type: 'object' } });
		assert.strictEqual(mcpRegistry.get('mcp.test')?.name, 'test');
		mcpTools.pop();
		assert.strictEqual(mcpRegistry.get('mcp.test'), undefined);
		mcpTools.push({ name: 'test', description: 'Test tool', inputSchema: { type: 'object' } });
		assert.strictEqual(mcpRegistry.list().length, 1);
		mcpBridge.dispose();
		assert.strictEqual(mcpRegistry.list().length, 0);
		const { resolveWorkspacePath, runTerminalCommand, listWorkspaceTree, readWorkspaceFile } = await import('../vscode/workspaceBridge');
		const root = { uri: { path: '/work/project', scheme: 'file', authority: '' } };
		assert.strictEqual(resolveWorkspacePath(root as never, 'src/a.ts').path, '/work/project/src/a.ts');
		assert.throws(() => resolveWorkspacePath(root as never, '../outside.ts'), /escape the workspace/);
		assert.throws(() => resolveWorkspacePath(root as never, 'src/../../project2/a.ts'), /escape the workspace/);
		// Absolute paths are allowed for read-only access to other folders.
		assert.strictEqual(resolveWorkspacePath(root as never, '/home/user/other/file.ts').path, '/home/user/other/file.ts');
		vscodeMock.workspace.fs = {
			readDirectory: async (uri: { path: string }) => uri.path === '/home/user/other'
				? [['notes.txt', 0], ['src', 2]]
				: [['src', 2]],
			readFile: async (uri: { path: string }) => new TextEncoder().encode(uri.path === '/home/user/other/notes.txt' ? 'outside content' : 'inside content')
		};
		assert.strictEqual(await listWorkspaceTree('/home/user/other'), 'src/\nnotes.txt');
		assert.strictEqual(await readWorkspaceFile('/home/user/other/notes.txt'), 'outside content');
		assert.strictEqual(await readWorkspaceFile('/work/project/src/a.ts'), 'inside content');
		vscodeMock.workspace.workspaceFolders[0].uri.scheme = 'vscode-remote';
		// With shell integration (visible Wuchat Agent terminal), commands run there.
		await assert.rejects(runTerminalCommand('test command', async () => true), /Command exited with code 3\.[\s\S]*\[Output truncated\]/);
		assert.strictEqual(endExecution, undefined);
		closeBeforeEnd = true;
		terminalOutput = 'closed';
		terminalCode = undefined;
		await assert.rejects(runTerminalCommand('test command', async () => true), /Command exited with code unknown\.\nclosed/);
		resumeRead?.();
		assert.strictEqual(closeTerminal, undefined);
		// Without shell integration, local commands fall back to a captured process.
		vscodeMock.workspace.workspaceFolders[0].uri.scheme = 'file';
		terminal.shellIntegration = undefined;
		assert.match(await runTerminalCommand('node -e "console.log(\'captured output\')"', async () => true), /Command exited with code 0\.\ncaptured output/);
		await assert.rejects(runTerminalCommand('node -e "process.exit(7)"', async () => true), /Command exited with code 7\./);
		assert.match(
			await runTerminalCommand('node -e "console.log(\'starting\'); setTimeout(() => {}, 130000)"', async () => true),
			/still running in the background[\s\S]*starting/
		);
		tools.register({ id: 'wuchat.runCommand', name: 'Run Command', description: 'Run tests', inputSchema: 'command', requiresApproval: false,
			invoke: (input, ctx) => runTerminalCommand(input, ctx.confirm, ctx.token) });
		const workAgent = new BaseAgent({
			id: 'test.work', name: 'Work agent', description: 'Test outcomes', systemPrompt: 'Test',
			tools: ['wuchat.updateTodos', 'test.write', 'wuchat.runCommand'],
			capabilities: { readEditor: false, readWorkspace: true, editFiles: true, runTerminal: true }
		}, tools);
		let workRound = 0;
		const workResult = await workAgent.invoke(request, {
			id: 'test', name: 'Test provider',
			async *chat() {
				workRound++;
				if (workRound === 1) yield { toolCall: { id: 'tasks', tool: 'wuchat_updateTodos', input: { input: JSON.stringify({ todos: [
					{ id: '1', title: 'Create files', status: 'completed' }, { id: '2', title: 'Run tests', status: 'in-progress' }
				] }) } } };
				else if (workRound === 2) yield { toolCall: { id: 'write', tool: 'test_write', input: { input: 'src/a.ts' } } };
				else if (workRound === 3) yield { toolCall: { id: 'pass', tool: 'wuchat_runCommand', input: { input: 'node -e "console.log(1)' + '"' } } };
				else if (workRound === 4) yield { toolCall: { id: 'fail', tool: 'wuchat_runCommand', input: { input: 'node -e "process.exit(7)"' } } };
				else yield { text: 'Agora vou testar.' };
			}
		}, 'test-model');
		assert.strictEqual(workResult.toolCalls.find(call => call.id === 'pass')?.status, 'finished');
		assert.strictEqual(workResult.toolCalls.find(call => call.id === 'fail')?.status, 'failed');
		assert.match(workResult.text, /Arquivos alterados: src\/a\.ts/);
		assert.match(workResult.text, /Command exited with code 0/);
		assert.match(workResult.text, /Command exited with code 7/);
		assert.match(workResult.text, /Tarefas: 1\/2 concluídas; pendentes: Run tests/);
		assert.match(workResult.error ?? '', /unfinished tasks/);
		const { AnthropicProvider } = await import('../llm/providers/anthropicProvider');
		const secretStore = new Map<string, string>();
		const secretManager = {
			getApiKey: async (id: string) => secretStore.get(`wuchat.apiKey.${id}`),
			setApiKey: async (id: string, value: string) => { secretStore.set(`wuchat.apiKey.${id}`, value); },
			deleteApiKey: async (id: string) => { secretStore.delete(`wuchat.apiKey.${id}`); },
			setSecret: async (key: string, value: string) => { secretStore.set(key, value); },
			getSecret: async (key: string) => secretStore.get(key),
			deleteSecret: async (key: string) => { secretStore.delete(key); }
		};
		const provider = new AnthropicProvider({ secretManager: secretManager as never });
		assert.deepStrictEqual((await provider.status()).ok, false);
		const missing: number[] = [];
		const chunks: Array<{ text?: string; toolCall?: { id: string; tool: string; input: unknown }; error?: string }> = [];
		for await (const chunk of provider.chat({ ...request, tools: [{ name: 'test.inspect', description: 'Read', inputSchema: { type: 'object' } }] } as never, 'claude-sonnet-4-5')) {
			chunks.push(chunk as never);
		}
		assert.match(chunks[0].error ?? '', /not connected/);
		assert.strictEqual(missing.length, 0);
		// API-key fallback path with a simulated Anthropic SSE stream.
		await secretManager.setApiKey('anthropic', 'test-key');
		const sseBody = [
			'event: content_block_delta',
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}',
			'',
			'event: content_block_start',
			'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"test_inspect"}}',
			'',
			'event: content_block_delta',
			'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"input\\":\\"src/a.ts\\"}"}}',
			'',
			'event: content_block_stop',
			'data: {"type":"content_block_stop","index":1}',
			'',
			'event: message_stop',
			'data: {"type":"message_stop"}',
			''
		].join('\n');
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response(sseBody, { status: 200 })) as typeof fetch;
		try {
			const streamed: typeof chunks = [];
			for await (const chunk of provider.chat({ ...request, tools: [{ name: 'test.inspect', description: 'Read', inputSchema: { type: 'object' } }] } as never, 'claude-sonnet-4-5')) {
				streamed.push(chunk as never);
			}
			assert.strictEqual(streamed[0].text, 'Hello ');
			assert.deepStrictEqual(streamed[1].toolCall, { id: 'tu_1', tool: 'test_inspect', input: { input: 'src/a.ts' } });
			// Cancellation stops the SSE reader promptly instead of draining it.
			const { readSse } = await import('../llm/sse');
			let cancelled = false;
			const cancelledToken = {
				isCancellationRequested: false,
				onCancellationRequested: (listener: () => void) => {
					setTimeout(() => { cancelled = true; listener(); }, 5);
					return { dispose() {} };
				}
			};
			const slowBody = new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					let sent = 0;
					const tick = setInterval(() => {
						if (cancelled || sent >= 4) { clearInterval(tick); try { controller.close(); } catch { /* already closed by cancel() */ } return; }
						try { controller.enqueue(encoder.encode(`data: {"n":${sent++}}\n\n`)); } catch { clearInterval(tick); }
					}, 10);
				}
			});
			const events: string[] = [];
			for await (const data of readSse(new Response(slowBody, { status: 200 }), cancelledToken as never)) {
				events.push(data);
				await new Promise(resolve => setTimeout(resolve, 12));
			}
			assert.ok(events.length <= 3, `expected the reader to stop after cancellation, got ${events.length} events`);
		} finally {
			globalThis.fetch = originalFetch;
		}
		const { ChatController } = await import('../chat/controllers/ChatController');
		const saved = new Map<string, ReturnType<ChatSession['toStored']>>();
		const started = new Map<string, () => void>();
		const releases = new Map<string, () => void>();
		const requests = new Map<string, ChatRequest>();
		let compactionPrompt = '';
		const testAgent = {
			id: 'wuchat.ask', name: 'Agent',
			async invoke(activeRequest: ChatRequest) {
				requests.set(activeRequest.prompt, activeRequest);
				started.get(activeRequest.prompt)?.();
				await new Promise<void>(resolve => releases.set(activeRequest.prompt, resolve));
				return { text: `Reply to ${activeRequest.prompt}`, toolCalls: [] };
			}
		};
		const controller = new ChatController(
			{ get: () => testAgent, defaultAgent: testAgent } as never,
			{ getRequired: () => ({ id: 'echo', async *chat(currentRequest: ChatRequest) {
				compactionPrompt = currentRequest.history[0].content;
				yield { text: 'Context summary.' };
			} }) } as never,
			{ get: (id: string) => saved.get(id), get sessions() { return [...saved.values()]; }, save: async (value: ReturnType<ChatSession['toStored']>) => { saved.set(value.id, value); } } as never,
			{ info: () => {}, error: () => {} } as never
		);
		const awaitStart = (prompt: string) => new Promise<void>(resolve => started.set(prompt, resolve));
		const firstStarted = awaitStart('first');
		const first = controller.send('first', {}, {});
		await firstStarted;
		const firstId = controller.session.id;
		const firstSession = controller.session;
		assert.strictEqual(controller.sessionSummaries.find(item => item.id === firstId)?.running, true);
		controller.newSession();
		const secondStarted = awaitStart('second');
		const second = controller.send('second', {}, {});
		await secondStarted;
		const secondId = controller.session.id;
		assert.notStrictEqual(requests.get('first')?.requestId, requests.get('second')?.requestId);
		controller.cancel();
		assert.strictEqual(requests.get('second')?.token.isCancellationRequested, true);
		assert.strictEqual(requests.get('first')?.token.isCancellationRequested, false);
		releases.get('second')?.();
		await second;
		assert.deepStrictEqual(saved.get(secondId)?.messages.map(message => message.content), ['second', 'Reply to second']);
		assert.deepStrictEqual(saved.get(firstId)?.messages.map(message => message.content), ['first']);
		assert.strictEqual(await controller.loadSession(firstId), true);
		releases.get('first')?.();
		await first;
		assert.deepStrictEqual(controller.session.messages.map(message => message.content), ['first', 'Reply to first']);
		assert.deepStrictEqual(saved.get(firstId)?.messages.map(message => message.content), ['first', 'Reply to first']);
		assert.strictEqual(controller.sessionSummaries.find(item => item.id === firstId)?.running, false);
		controller.newSession();
		const selectedId = controller.session.id;
		const queuedStarted = awaitStart('queued old');
		const queued = controller.send('queued old', { session: firstSession }, {});
		await queuedStarted;
		releases.get('queued old')?.();
		await queued;
		assert.strictEqual(controller.session.id, selectedId);
		assert.deepStrictEqual(controller.session.messages, []);
		assert.deepStrictEqual(saved.get(firstId)?.messages.map(message => message.content), ['first', 'Reply to first', 'queued old', 'Reply to queued old']);
		controller.session.replaceMessages([
			{ role: 'user', content: 'Initial request' },
			...Array.from({ length: 24 }, (_, index) => ({
				role: 'assistant' as const, content: `Long turn ${index} ` + 'details '.repeat(800),
				...(index === 12 ? { todos: [{ id: '1', title: 'Finish the server', status: 'in-progress' as const }] } : {})
			})),
			{ role: 'user', content: 'Recent decision: keep src/server.ts' }
		]);
		await controller.compactContext({});
		assert.match(compactionPrompt, /Initial request/);
		assert.match(compactionPrompt, /Recent decision: keep src\/server\.ts/);
		assert.match(compactionPrompt, /Latest saved task status:\nin-progress: Finish the server/);
	} finally {
		moduleLoader._load = originalLoad;
	}
	console.log('wuchat: all sanity checks passed.');
})();

