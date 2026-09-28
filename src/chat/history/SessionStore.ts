/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  Independent persistence: globalState + globalStorage. Never touches any
 *  other extension's storage.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatMessage } from '../../common/types';

export interface StoredSession {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messages: ChatMessage[];
	running?: boolean;
	processId?: number;
}

/**
 * Keys are Wuchat-namespaced and stored in Wuchat's own globalState /
 * globalStorage directory, so sessions survive reloads and stay independent
 * from GitHub Copilot.
 */
export class SessionStore implements vscode.Disposable {
	private static readonly INDEX_KEY = 'wuchat.sessions.index';
	private static readonly SESSION_PREFIX = 'wuchat.session.';

	private readonly indexListener: vscode.Disposable;
	private index: string[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {
		this.index = context.globalState.get<string[]>(SessionStore.INDEX_KEY, []);
		this.indexListener = vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('wuchat.history.maxSessions')) {
				void this.trim();
			}
		});
	}

	get sessions(): StoredSession[] {
		return this.index
			.map(id => this.context.globalState.get<StoredSession>(SessionStore.SESSION_PREFIX + id))
			.filter((s): s is StoredSession => !!s)
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	get(id: string): StoredSession | undefined {
		return this.context.globalState.get<StoredSession>(SessionStore.SESSION_PREFIX + id);
	}

	async save(session: StoredSession): Promise<void> {
		if (!this.index.includes(session.id)) {
			this.index.push(session.id);
		}
		await this.context.globalState.update(SessionStore.SESSION_PREFIX + session.id, session);
		await this.context.globalState.update(SessionStore.INDEX_KEY, this.index);
		await this.trim();
	}

	async delete(id: string): Promise<void> {
		this.index = this.index.filter(x => x !== id);
		await this.context.globalState.update(SessionStore.SESSION_PREFIX + id, undefined);
		await this.context.globalState.update(SessionStore.INDEX_KEY, this.index);
	}

	async clear(): Promise<void> {
		for (const id of this.index) {
			await this.context.globalState.update(SessionStore.SESSION_PREFIX + id, undefined);
		}
		this.index = [];
		await this.context.globalState.update(SessionStore.INDEX_KEY, this.index);
	}

	async reconcileRunning(): Promise<void> {
		for (const session of this.sessions) {
			if (!session.running || isProcessAlive(session.processId)) continue;
			const messages = [...session.messages];
			if (messages.at(-1)?.role === 'user') {
				messages.push({
					role: 'assistant',
					content: '_(CLI process stopped before completing this response. The user prompt and previous history were preserved.)_',
					agent: 'CLI Agent',
					error: 'Process interrupted'
				});
			}
			await this.context.globalState.update(SessionStore.SESSION_PREFIX + session.id, {
				...session,
				updatedAt: Date.now(),
				messages,
				running: false,
				processId: undefined
			});
		}
	}

	private async trim(): Promise<void> {
		const max = Math.max(1, vscode.workspace.getConfiguration('wuchat').get<number>('history.maxSessions', 50));
		const ordered = this.sessions;
		if (ordered.length <= max) {
			return;
		}
		const remove = ordered.filter(session => !session.running).slice(max);
		for (const s of remove) {
			await this.delete(s.id);
		}
	}

	dispose(): void {
		this.indexListener.dispose();
	}
}

function isProcessAlive(pid: number | undefined): boolean {
	if (!Number.isInteger(pid) || !pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}
