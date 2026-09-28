/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  Sanity checks that run in plain Node (no vscode dependency).
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ChatSession } from '../chat/sessions/ChatSession';
import { BaseAgent } from '../agents/Agent';
import { ProviderRegistry } from '../llm/ProviderRegistry';
import { EchoProvider } from '../llm/providers/echoProvider';
import { AgentStep, ChatRequest, ToolProgress } from '../common/types';
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
	console.log('wuchat: all sanity checks passed.');
})();

