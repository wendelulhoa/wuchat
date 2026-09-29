/*---------------------------------------------------------------------------------------------
 *  Wuchat — shared SSE streaming helpers for direct HTTP providers.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, ToolCallRequest } from '../common/types';

/** Reads `data:` lines from an SSE response body; stops promptly on cancellation. */
export async function* readSse(response: Response, token?: CancellationToken): AsyncIterable<string> {
	const reader = response.body!.getReader();
	const abort = new AbortController();
	const subscription = token?.onCancellationRequested(() => {
		abort.abort();
		void reader.cancel().catch(() => undefined);
	});
	try {
		const decoder = new TextDecoder();
		let buffer = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index: number;
			while ((index = buffer.indexOf('\n\n')) >= 0) {
				const raw = buffer.slice(0, index);
				buffer = buffer.slice(index + 2);
				const data = raw.split('\n')
					.filter(line => line.startsWith('data:'))
					.map(line => line.slice(5).trim())
					.join('\n');
				if (data) yield data;
			}
			if (token?.isCancellationRequested) break;
		}
	} finally {
		subscription?.dispose();
		void reader.cancel().catch(() => undefined);
	}
}

export function toToolCall(id: string, name: string, rawInput: string): ToolCallRequest {
	let input: unknown;
	try { input = JSON.parse(rawInput || '{}'); } catch { input = { input: rawInput }; }
	return { id: id || `call-${Date.now()}`, tool: name, input };
}

/** Anthropic restricts tool names to letters, digits, underscores and dashes. */
export function sanitizeToolName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

/** fetch with cancellation, timeout and error normalisation. */
export async function fetchJson(url: string, init: RequestInit, timeoutMs: number, token?: CancellationToken): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const subscription = token?.onCancellationRequested(() => controller.abort());
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
		subscription?.dispose();
	}
}
