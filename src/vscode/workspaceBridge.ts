/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  VS Code integrations used by tools: workspace file access, editor and
 *  terminal operations. Kept in one adapter module so tools remain testable
 *  and UI-independent.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

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
	confirm: (title: string, detail: string) => Promise<boolean>
): Promise<string> {
	if (!command) {
		throw new Error('Wuchat: terminal command cannot be empty.');
	}
	if (isDestructiveCommand(command) && !await confirm('Wuchat: confirm potentially destructive command', command)) {
		return 'Command was not approved by the user.';
	}
	let terminal = vscode.window.terminals.find(t => t.name === 'Wuchat Agent');
	if (!terminal) {
		const root = vscode.workspace.workspaceFolders?.[0];
		terminal = vscode.window.createTerminal({ name: 'Wuchat Agent', cwd: root?.uri });
	}
	terminal.show(true);
	const shellIntegration = terminal.shellIntegration ?? await waitForShellIntegration(terminal);
	if (!shellIntegration) {
		terminal.sendText(command, true);
		return 'Command sent to the Wuchat Agent terminal. Shell integration is unavailable, so command output and exit status could not be collected.';
	}
	const execution = shellIntegration.executeCommand(command);
	let output = '';
	for await (const chunk of execution.read()) {
		if (output.length < 24_000) {
			output += chunk.slice(0, 24_000 - output.length);
		}
	}
	const exitCode = await execution.exitCode;
	const cleanedOutput = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
	return [
		`Command exited with code ${exitCode ?? 'unknown'}.`,
		cleanedOutput || '(no output)',
		output.length > 24_000 ? '[Output truncated]' : ''
	].filter(Boolean).join('\n');
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

export async function listWorkspaceTree(limit = 50): Promise<string> {
	const root = vscode.workspace.workspaceFolders?.[0];
	if (!root) {
		throw new Error('Wuchat: no workspace folder is open.');
	}
	const entries = await vscode.workspace.fs.readDirectory(root.uri);
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

export function resolveWorkspacePath(root: vscode.WorkspaceFolder, relPath: string): vscode.Uri {
	const normalized = relPath.replace(/^\.\//, '').replace(/^\/+/, '');
	return vscode.Uri.joinPath(root.uri, normalized);
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
