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

export async function runTerminalCommand(command: string): Promise<string> {
	let terminal = vscode.window.terminals.find(t => t.name === 'Wuchat');
	if (!terminal) {
		terminal = vscode.window.createTerminal({ name: 'Wuchat' });
	}
	terminal.show(true);
	terminal.sendText(command, true);
	return `Command sent to the "Wuchat" terminal: ${command}`;
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
