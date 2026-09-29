import * as http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { ChatRequest, CancellationToken } from '../common/types';
import { ProviderRegistry } from '../llm/ProviderRegistry';
import { Logger } from '../common/logger';

const stateDir = path.join(homedir(), '.wuchat');
const descriptorPath = path.join(stateDir, 'vscode-provider.json');

export class ExtensionCliBridge implements vscode.Disposable {
	private readonly token = randomBytes(32).toString('hex');
	private server?: http.Server;
	private descriptorWritten = false;

	constructor(private readonly providers: ProviderRegistry, private readonly logger: Logger) {}

	async start(): Promise<void> {
		await mkdir(stateDir, { recursive: true, mode: 0o700 });
		await chmod(stateDir, 0o700);
		this.server = http.createServer((request, response) => { void this.handle(request, response); });
		await new Promise<void>((resolve, reject) => {
			this.server!.once('error', reject);
			this.server!.listen(0, '127.0.0.1', resolve);
		});
		const address = this.server.address();
		if (!address || typeof address === 'string') throw new Error('Could not start Wuchat local provider bridge.');
		await writeFile(descriptorPath, JSON.stringify({ port: address.port, token: this.token }), { mode: 0o600 });
		await chmod(descriptorPath, 0o600);
		this.descriptorWritten = true;
		this.logger.info(`Local CLI provider bridge listening on 127.0.0.1:${address.port}.`);
	}

	dispose(): void {
		this.server?.close();
		if (this.descriptorWritten) {
			void readFile(descriptorPath, 'utf8').then(contents => {
				const descriptor = JSON.parse(contents) as { token?: string };
				if (descriptor.token === this.token) return rm(descriptorPath, { force: true });
				return undefined;
			}).catch(() => undefined);
		}
	}

	private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		if (request.socket.remoteAddress !== '127.0.0.1' && request.socket.remoteAddress !== '::ffff:127.0.0.1') {
			response.writeHead(403).end();
			return;
		}
		if (!authorized(request.headers.authorization, this.token)) {
			response.writeHead(401).end();
			return;
		}
		if (request.method === 'GET' && request.url === '/config') {
			const config = vscode.workspace.getConfiguration('wuchat');
			const providerId = config.get<string>('provider', 'anthropic');
			const provider = this.providers.get(providerId);
			if (!provider) {
				response.writeHead(404).end(JSON.stringify({ error: `Provider ${providerId} is unavailable.` }));
				return;
			}
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ provider: provider.id, name: provider.name, model: config.get<string>('model', '') }));
			return;
		}
		if (request.method === 'GET' && request.url === '/models') {
			const config = vscode.workspace.getConfiguration('wuchat');
			const providerId = config.get<string>('provider', 'anthropic');
			const provider = this.providers.get(providerId);
			if (!provider?.models) {
				response.writeHead(503).end(JSON.stringify({ error: `Provider ${providerId} does not expose a model list.` }));
				return;
			}
			const models = await provider.models();
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ provider: provider.id, name: provider.name, models }));
			return;
		}
		if (request.method === 'POST' && request.url === '/model') {
			const body = await readBody(request);
			let payload: { model?: string };
			try { payload = JSON.parse(body) as typeof payload; }
			catch { response.writeHead(400).end('Invalid JSON.'); return; }
			if (typeof payload.model !== 'string') {
				response.writeHead(400).end('Field "model" is required.');
				return;
			}
			await vscode.workspace.getConfiguration('wuchat').update('model', payload.model, vscode.ConfigurationTarget.Global);
			this.logger.info(`CLI selected Wuchat model: ${payload.model}`);
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ ok: true, model: payload.model }));
			return;
		}
		if (request.method !== 'POST' || request.url !== '/chat') {
			response.writeHead(404).end();
			return;
		}
		const body = await readBody(request);
		if (body.length > 8 * 1024 * 1024) {
			response.writeHead(413).end();
			return;
		}
		let payload: { request?: Omit<ChatRequest, 'token'>; modelOverride?: string };
		try { payload = JSON.parse(body) as typeof payload; }
		catch { response.writeHead(400).end('Invalid JSON.'); return; }
		const chatRequest = payload.request;
		if (!chatRequest || typeof chatRequest.prompt !== 'string' || !Array.isArray(chatRequest.history) || !Array.isArray(chatRequest.tools)) {
			response.writeHead(400).end('Invalid chat request.');
			return;
		}
		const config = vscode.workspace.getConfiguration('wuchat');
		const providerId = config.get<string>('provider', 'anthropic');
		const provider = this.providers.get(providerId);
		const model = typeof payload.modelOverride === 'string' && payload.modelOverride
			? payload.modelOverride
			: config.get<string>('model', '');
		if (!provider) { response.writeHead(503).end(`Provider ${providerId} is unavailable.`); return; }
		const cancellation = createCancellationToken();
		const cancelOnClose = () => cancellation.cancel();
		response.on('close', cancelOnClose);
		response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
		try {
			const requestWithToken = { ...chatRequest, token: cancellation.token } as ChatRequest;
			for await (const chunk of provider.chat(requestWithToken, model)) {
				if (cancellation.token.isCancellationRequested) break;
				response.write(`data: ${JSON.stringify(chunk)}\n\n`);
			}
			if (!cancellation.token.isCancellationRequested) response.write('data: [DONE]\n\n');
		} catch (error) {
			response.write(`data: ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n\n`);
			response.write('data: [DONE]\n\n');
		} finally {
			response.end();
			response.off('close', cancelOnClose);
			cancellation.dispose();
		}
	}
}

function authorized(header: string | undefined, expected: string): boolean {
	const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
	const suppliedBytes = Buffer.from(supplied);
	const expectedBytes = Buffer.from(expected);
	return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

async function readBody(request: http.IncomingMessage): Promise<string> {
	const parts: Buffer[] = [];
	for await (const part of request) parts.push(Buffer.from(part));
	return Buffer.concat(parts).toString('utf8');
}

function createCancellationToken(): { token: CancellationToken; cancel(): void; dispose(): void } {
	let cancelled = false;
	const listeners = new Set<() => void>();
	return {
		token: {
			get isCancellationRequested() { return cancelled; },
			onCancellationRequested(listener) {
				listeners.add(listener);
				return { dispose: () => listeners.delete(listener) };
			}
		},
		cancel() {
			if (cancelled) return;
			cancelled = true;
			for (const listener of listeners) listener();
		},
		dispose: () => listeners.clear()
	};
}