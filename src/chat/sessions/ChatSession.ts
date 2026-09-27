/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  Chat session model: a Wuchat conversation kept in memory while active and
 *  persisted to Wuchat's own storage.
 *--------------------------------------------------------------------------------------------*/

import { ChatMessage, ToolCallRecord } from '../../common/types';
import { StoredSession } from '../history/SessionStore';
let sessionCounter = 0;

export class ChatSession {
	readonly id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messages: ChatMessage[];

	constructor(title = 'New chat', id?: string) {
		this.id = id ?? `session-${Date.now()}-${sessionCounter++}`;
		this.title = title;
		this.createdAt = Date.now();
		this.updatedAt = this.createdAt;
		this.messages = [];
	}

	static from(stored: StoredSession): ChatSession {
		// Recreate with the stored id so sessions keep their identity across reloads.
		const session = new ChatSession(stored.title, stored.id);
		session.createdAt = stored.createdAt;
		session.updatedAt = stored.updatedAt;
		session.messages = stored.messages;
		return session;
	}
	get lastUserMessage(): string {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const m = this.messages[i];
			if (m.role === 'user') {
				return m.content;
			}
		}
		return 'New chat';
	}

	append(message: ChatMessage): void {
		this.messages.push(message);
		this.updatedAt = Date.now();
		if (this.title === 'New chat' && message.role === 'user') {
			this.title = message.content.slice(0, 40) || 'New chat';
		}
	}

	appendToolCalls(calls: ToolCallRecord[]): void {
		const last = this.messages[this.messages.length - 1];
		if (last && last.role === 'assistant') {
			last.toolCalls = [...(last.toolCalls ?? []), ...calls];
			this.updatedAt = Date.now();
		}
	}

	/** Replaces the message list (used by context compaction). */
	replaceMessages(messages: ChatMessage[]): void {
		this.messages = [...messages];
		this.updatedAt = Date.now();
	}

	toStored(): StoredSession {
		return {
			id: this.id,
			title: this.title,
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
			messages: this.messages
		};
	}
}
