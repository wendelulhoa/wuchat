/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  Logging helper on top of the VS Code output channel.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

type Level = 'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const ORDER: Record<Level, number> = {
	off: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
	trace: 5
};

export class Logger implements vscode.Disposable {
	private channel: vscode.LogOutputChannel;
	private level: Level = 'info';
	private readonly configListener: vscode.Disposable;

	constructor() {
		this.channel = vscode.window.createOutputChannel('Wuchat', { log: true });
		this.configListener = vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('wuchat.logging.level')) {
				this.readLevel();
			}
		});
		this.readLevel();
	}

	private readLevel(): void {
		this.level = vscode.workspace.getConfiguration('wuchat').get<Level>('logging.level', 'info');
	}

	private enabled(level: Level): boolean {
		return this.level !== 'off' && ORDER[level] <= ORDER[this.level];
	}

	error(msg: string, ...rest: unknown[]): void {
		if (this.enabled('error')) { this.channel.error([msg, ...rest].join(' ')); }
	}

	warn(msg: string, ...rest: unknown[]): void {
		if (this.enabled('warn')) { this.channel.warn([msg, ...rest].join(' ')); }
	}

	info(msg: string, ...rest: unknown[]): void {
		if (this.enabled('info')) { this.channel.info([msg, ...rest].join(' ')); }
	}

	debug(msg: string, ...rest: unknown[]): void {
		if (this.enabled('debug')) { this.channel.debug([msg, ...rest].join(' ')); }
	}

	trace(msg: string, ...rest: unknown[]): void {
		if (this.enabled('trace')) { this.channel.trace([msg, ...rest].join(' ')); }
	}

	dispose(): void {
		this.configListener.dispose();
		this.channel.dispose();
	}
}
