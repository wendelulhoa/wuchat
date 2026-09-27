/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  Offline echo provider. No network, no credentials. Used as the default so
 *  the extension works out of the box and in tests.
 *--------------------------------------------------------------------------------------------*/

import { ChatChunk, ChatRequest, LLMProvider, ModelInfo } from '../../common/types';

export class EchoProvider implements LLMProvider {
	readonly id = 'echo';
	readonly name = 'Echo (offline)';

	async *chat(request: ChatRequest): AsyncIterable<ChatChunk> {
		const historyNote = request.history.length
			? ` (continuing a conversation with ${request.history.length} previous messages)`
			: '';
		yield { text: `Echo${historyNote}: ` };
		// Small delay so the streaming UI is observable.
		await new Promise(resolve => setTimeout(resolve, 60));
		yield { text: `"${request.prompt}"` };
		if (request.context.selection) {
			await new Promise(resolve => setTimeout(resolve, 40));
			yield { text: `\n\nI can see your selection in ${request.context.selection.uri}: "${request.context.selection.text.slice(0, 120)}"` };
		}
	}

	async models(): Promise<ModelInfo[]> {
		return [{ id: 'echo-1', name: 'Echo Model', provider: this.id }];
	}

	async status(): Promise<{ ok: boolean; detail: string }> {
		return { ok: true, detail: 'Offline provider, always available.' };
	}
}
