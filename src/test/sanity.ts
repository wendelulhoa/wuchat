/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  Sanity checks that run in plain Node (no vscode dependency).
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ChatSession } from '../chat/sessions/ChatSession';
import { ProviderRegistry } from '../llm/ProviderRegistry';
import { EchoProvider } from '../llm/providers/echoProvider';
import { ChatRequest } from '../common/types';

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
	console.log('wuchat: all sanity checks passed.');
})();

