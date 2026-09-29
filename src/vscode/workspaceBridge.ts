/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  VS Code integrations used by tools: workspace file access, editor and
 *  terminal operations. Kept in one adapter module so tools remain testable
 *  and UI-independent.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { CancellationToken } from '../common/types';

export async function readWorkspaceFile(relPath: string): Promise<string> {
	const root = vscode.workspace.workspaceFolders?.[0];
	if (!root) {
		throw new Error('Wuchat: no workspace folder is open.');
	}
	const uri = resolveWorkspacePath(root, relPath);
	const bytes = await vscode.workspace.fs.readFile(uri);
	return new TextDecoder().decode(bytes);
}

export async function writeWorkspaceFile(relPath: string, content: string): Promise<string> {
	const root = vscode.workspace.workspaceFolders?.[0];
	if (!root) {
		throw new Error('Wuchat: no workspace folder is open.');
	}
	const uri = resolveWorkspacePath(root, relPath);
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
	await showFileInEditorIfOpen(uri);
	return `Wrote ${content.length} characters to ${relPath}.`;
}

export async function openWorkspaceFile(relPath: string, line?: number, column?: number): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0];
	if (!root) {
		throw new Error('Wuchat: no workspace folder is open.');
	}
	const uri = resolveWorkspacePath(root, relPath);
	const doc = await vscode.workspace.openTextDocument(uri);
	const position = line !== undefined
		? new vscode.Position(Math.max(0, line - 1), Math.max(0, (column ?? 1) - 1))
		: undefined;
	await vscode.window.showTextDocument(doc, {
		selection: position ? new vscode.Selection(position, position) : undefined
	});
}

export function getActiveSelection(): { uri: string; text: string; language: string } | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.selection.isEmpty) {
		return undefined;
	}
	return {
		uri: vscode.workspace.asRelativePath(editor.document.uri),
		text: editor.document.getText(editor.selection),
		language: editor.document.languageId
	};
}

export async function runTerminalCommand(
	command: string,
	confirm: (title: string, detail: string) => Promise<boolean>,
	token?: CancellationToken,
	onOutput?: (delta: string) => void
): Promise<string> {
	if (!command) {
		throw new Error('Wuchat: terminal command cannot be empty.');
	}
	if (isDestructiveCommand(command) && !await confirm('Wuchat: confirm potentially destructive command', command)) {
		return 'Command was not approved by the user.';
	}
	const root = vscode.workspace.workspaceFolders?.[0];
	// Prefer the visible Wuchat Agent terminal: the user can watch the command,
	// interact with it (passwords, Ctrl+C) and stop long-running servers.
	let terminal = vscode.window.terminals.find(t => t.name === 'Wuchat Agent');
	if (!terminal) {
		terminal = vscode.window.createTerminal({ name: 'Wuchat Agent', cwd: root?.uri });
	}
	terminal.show(true);
	const shellIntegration = terminal.shellIntegration ?? await waitForShellIntegration(terminal);
	if (!shellIntegration) {
		if (root && root.uri.scheme !== 'file') throw new Error('Wuchat: shell integration is required to run commands in a remote workspace.');
		// Fallback for terminals without shell integration: capture output from a hidden process.
		return runCapturedCommand(command, root?.uri.fsPath ?? process.cwd(), token, onOutput);
	}
	// Anchor every command at the workspace root so relative paths (grep, ls…)
	// behave like Kilo Code's shell integration, which prefixes `cd <cwd> &&`.
	const cwd = root?.uri.fsPath;
	if (cwd) {
		void shellIntegration.executeCommand(`cd "${cwd}"`);
		// Give the cd a moment; execution identity tracking starts below.
		await new Promise(resolve => setTimeout(resolve, 120));
	}
	let execution: vscode.TerminalShellExecution | undefined;
	let exitCode: number | undefined;
	let closed = false;
	const finish = (code: number | undefined) => {
		exitCode = code;
	};
	const endSubscription = vscode.window.onDidEndTerminalShellExecution(event => {
		if (event.execution === execution) finish(event.exitCode);
	});
	const closeSubscription = vscode.window.onDidCloseTerminal(closedTerminal => {
		if (closedTerminal !== terminal) return;
		closed = true;
		finish(undefined);
	});
	try {
		execution = shellIntegration.executeCommand(command);
		let output = '';
		let truncated = false;
		const readOutput = (async () => {
			for await (const chunk of execution.read()) {
				if (output.length + chunk.length > 24_000) truncated = true;
				output = (output + chunk).slice(-24_000);
			}
		})();
		// Never wait forever: long-running commands (grep in big trees, servers)
		// return the collected output after the timeout instead of blocking the
		// agent (Kilo Code-style command timeout).
		const timeoutMs = Math.max(10, vscode.workspace.getConfiguration('wuchat').get<number>('commandTimeoutSeconds', 90)) * 1_000;
		let timedOut = false;
		await Promise.race([
			readOutput.catch(() => undefined),
			new Promise<void>(resolve => setTimeout(() => { timedOut = true; resolve(); }, timeoutMs))
		]);
		const cleanedOutput = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
		if (timedOut && !closed) {
			return [
				`Command still running after ${Math.round(timeoutMs / 1_000)}s (output collected so far, exit status unknown).`,
				cleanedOutput || '(no output yet)',
				truncated ? '[Output truncated]' : '',
				'Use "Open terminal" to interact with it, or run a narrower command.'
			].filter(Boolean).join('\n');
		}
		return formatCommandResult(exitCode, cleanedOutput, truncated);
	} finally {
		endSubscription.dispose();
		closeSubscription.dispose();
	}
}

function formatCommandResult(code: number | null | undefined, output: string, truncated: boolean): string {
	const result = [
		`Command exited with code ${code ?? 'unknown'}.`,
		output.trim() || '(no output)',
		truncated ? '[Output truncated]' : ''
	].filter(Boolean).join('\n');
	if (code !== 0) throw new Error(`Wuchat: ${result}`);
	return result;
}

/** Opens (or creates) the Wuchat Agent terminal so the user can inspect, cancel or interact with commands. */
export function showWuchatTerminal(): vscode.Terminal {
	const root = vscode.workspace.workspaceFolders?.[0];
	let terminal = vscode.window.terminals.find(t => t.name === 'Wuchat Agent');
	if (!terminal) {
		terminal = vscode.window.createTerminal({ name: 'Wuchat Agent', cwd: root?.uri });
	}
	terminal.show(true);
	return terminal;
}

function runCapturedCommand(command: string, cwd: string, token?: CancellationToken, onOutput?: (delta: string) => void): Promise<string> {
	return new Promise((resolve, reject) => {
		if (token?.isCancellationRequested) { reject(new Error('Wuchat: command cancelled.')); return; }
		const child = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		let truncated = false;
		const collect = (chunk: Buffer) => {
			const text = chunk.toString();
			if (output.length + text.length > 24_000) truncated = true;
			output = (output + text).slice(-24_000);
			onOutput?.(text);
		};
		child.stdout.on('data', collect);
		child.stderr.on('data', collect);
		let settled = false;
		const finish = (error?: Error, code?: number | null, rawResult?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			cancellation?.dispose();
			if (error) reject(error);
			else if (rawResult) resolve(rawResult);
			else {
				try { resolve(formatCommandResult(code, output, truncated)); }
				catch (failure) { reject(failure); }
			}
		};
		// Long-running commands (dev servers, watchers) keep running in the
		// background; report the output collected so far instead of killing them.
		const timeout = setTimeout(() => finish(undefined, undefined, [
			'Command is still running in the background after 120 seconds (long-running server or watcher).',
			output.trim() || '(no output yet)',
			`Use "Open terminal" to interact with it or stop it. To wait for completion, run a follow-up check such as "curl http://localhost:<port>".`,
			truncated ? '[Output truncated]' : ''
		].filter(Boolean).join('\n')), 120_000);
		const cancellation = token?.onCancellationRequested(() => {
			if (child.pid && process.platform !== 'win32') {
				try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
			} else child.kill();
			finish(new Error('Wuchat: command cancelled.'));
		});
		child.once('error', error => finish(error));
		child.once('close', code => finish(undefined, code));
		if (token?.isCancellationRequested) {
			child.kill();
			finish(new Error('Wuchat: command cancelled.'));
		}
	});
}

function waitForShellIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
	return new Promise(resolve => {
		if (terminal.shellIntegration) {
			resolve(terminal.shellIntegration);
			return;
		}
		const subscription = vscode.window.onDidChangeTerminalShellIntegration(event => {
			if (event.terminal === terminal) {
				clearTimeout(timeout);
				subscription.dispose();
				resolve(event.shellIntegration);
			}
		});
		const timeout = setTimeout(() => {
			subscription.dispose();
			resolve(terminal.shellIntegration);
		}, 3000);
	});
}

function isDestructiveCommand(command: string): boolean {
	return /(?:^|[;&|()]\s*)(?:sudo\s+)?(?:rm|rmdir|del|erase|format|mkfs(?:\.\w+)?|diskpart|dd|truncate)\b/i.test(command)
		|| /\bfind\b[^;&|]*\s-delete\b/i.test(command)
		|| /\bchmod\b[^;&|]*\s-R\b/i.test(command)
		|| /\bchown\b[^;&|]*\s-R\b/i.test(command)
		|| /\bgit\s+(?:reset\s+--hard|clean\s+[^;&|]*-f|checkout\s+--|restore\s+--worktree|push\s+[^;&|]*--force)/i.test(command);
}

export async function listWorkspaceTree(subPath = '', limit = 50): Promise<string> {
	const root = vscode.workspace.workspaceFolders?.[0];
	if (!root) {
		throw new Error('Wuchat: no workspace folder is open.');
	}
	// Absolute paths (inside or outside the workspace) are allowed for read-only
	// browsing so the agent can inspect sibling projects via the terminal.
	const uri = path.isAbsolute(subPath) || /^[a-zA-Z]:[\\/]/.test(subPath)
		? vscode.Uri.file(subPath)
		: resolveWorkspacePath(root, subPath || '.');
	let entries: Array<[string, vscode.FileType]>;
	try {
		entries = await vscode.workspace.fs.readDirectory(uri);
	} catch (error) {
		throw new Error(`Wuchat: cannot list ${subPath || 'workspace root'}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const sorted = entries
		.filter(([name]) => !name.startsWith('.'))
		.sort((a, b) => {
			if (a[1] !== b[1]) {
				return a[1] === vscode.FileType.Directory ? -1 : 1;
			}
			return a[0].localeCompare(b[0]);
		})
		.slice(0, limit);
	return sorted.map(([name, type]) => type === vscode.FileType.Directory ? `${name}/` : name).join('\n');
}

/**
 * Resolves a user-supplied path. Relative paths stay inside the workspace;
 * absolute paths are allowed for read-only access to other folders.
 */
export function resolveWorkspacePath(root: vscode.WorkspaceFolder, relPath: string): vscode.Uri {
	if (path.isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
		return vscode.Uri.file(path.normalize(relPath));
	}
	const normalized = relPath.replace(/^\.\//, '').replace(/^\/+/, '');
	const uri = vscode.Uri.joinPath(root.uri, normalized);
	const rootPath = root.uri.path.replace(/\/+$/, '');
	if (uri.scheme !== root.uri.scheme || uri.authority !== root.uri.authority ||
		(uri.path !== rootPath && !uri.path.startsWith(`${rootPath}/`))) {
		throw new Error('Wuchat: relative paths cannot escape the workspace folder. Use an absolute path to read outside it.');
	}
	return uri;
}

async function showFileInEditorIfOpen(uri: vscode.Uri): Promise<void> {
	const open = vscode.window.tabGroups.all
		.flatMap(g => g.tabs)
		.some(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
	if (open) {
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preserveFocus: true });
	}
}
