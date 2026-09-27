/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  Built-in tools exposed to agents. Each tool declares whether it requires
 *  user approval; the ToolRegistry enforces the policy.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { WuchatTool } from '../../common/types';
import {
	listWorkspaceTree,
	openWorkspaceFile,
	readWorkspaceFile,
	runTerminalCommand,
	writeWorkspaceFile
} from '../../vscode/workspaceBridge';

function firstLine(rawInput: string): string {
	return rawInput.trim().split('\n')[0] ?? '';
}

const readFileTool: WuchatTool = {
	id: 'wuchat.readFile',
	name: 'Read File',
	description: 'Reads a text file from the workspace.',
	requiresApproval: false,
	inputSchema: 'relative file path, e.g. "src/index.ts"',
	async invoke(rawInput: string) {
		return readWorkspaceFile(firstLine(rawInput));
	}
};

const writeFileTool: WuchatTool = {
	id: 'wuchat.writeFile',
	name: 'Write File',
	description: 'Creates or overwrites a workspace file with the provided content. Requires approval.',
	requiresApproval: true,
	inputSchema: 'first line: file path; remaining lines: file content',
	async invoke(rawInput: string) {
		const trimmed = rawInput.trim();
		const newlineIndex = trimmed.indexOf('\n');
		if (newlineIndex < 0) {
			throw new Error('Wuchat: provide the file path on the first line and the content afterwards.');
		}
		const path = trimmed.slice(0, newlineIndex).trim();
		const content = trimmed.slice(newlineIndex + 1);
		return writeWorkspaceFile(path, content);
	}
};

const openFileTool: WuchatTool = {
	id: 'wuchat.openFile',
	name: 'Open File',
	description: 'Opens a workspace file in the editor.',
	requiresApproval: false,
	inputSchema: 'relative file path, optionally followed by "line" and "column"',
	async invoke(rawInput: string) {
		const parts = firstLine(rawInput).split(/\s+/).filter(Boolean);
		if (parts.length === 0) {
			throw new Error('Wuchat: file path is required.');
		}
		const line = parts.length > 1 ? Number.parseInt(parts[1], 10) : undefined;
		const column = parts.length > 2 ? Number.parseInt(parts[2], 10) : undefined;
		await openWorkspaceFile(parts[0], Number.isNaN(line!) ? undefined : line, Number.isNaN(column!) ? undefined : column);
		return `Opened ${parts[0]}${Number.isNaN(line!) ? '' : ` at line ${line}`}.`;
	}
};

const runCommandTool: WuchatTool = {
	id: 'wuchat.runCommand',
	name: 'Run Terminal Command',
	description: 'Sends a command to the Wuchat terminal. Requires approval.',
	requiresApproval: true,
	inputSchema: 'the command line to run',
	async invoke(rawInput: string) {
		return runTerminalCommand(rawInput.trim());
	}
};

const listWorkspaceTool: WuchatTool = {
	id: 'wuchat.listWorkspace',
	name: 'List Workspace',
	description: 'Lists the top-level files and folders of the workspace.',
	requiresApproval: false,
	inputSchema: '(no input)',
	async invoke(): Promise<string> {
		return listWorkspaceTree();
	}
};

const applyEditTool: WuchatTool = {
	id: 'wuchat.applyEdit',
	name: 'Apply Edit',
	description: 'Applies a text edit to an open editor at a given line range. Requires approval.',
	requiresApproval: true,
	inputSchema: 'first line: "<file> <startLine> <endLine>"; remaining lines: replacement text',
	async invoke(rawInput: string) {
		const trimmed = rawInput.trim();
		const newlineIndex = trimmed.indexOf('\n');
		if (newlineIndex < 0) {
			throw new Error('Wuchat: expected "<file> <startLine> <endLine>" on the first line.');
		}
		const header = trimmed.slice(0, newlineIndex).split(/\s+/);
		const replacement = trimmed.slice(newlineIndex + 1);
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			throw new Error('Wuchat: no active text editor.');
		}
		const startLine = Math.max(0, Number.parseInt(header[1] ?? '1', 10) - 1);
		const endLine = Math.max(startLine, Number.parseInt(header[2] ?? header[1] ?? '1', 10) - 1);
		const range = new vscode.Range(startLine, 0, endLine, editor.document.lineAt(Math.min(endLine, editor.document.lineCount - 1)).text.length);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(editor.document.uri, range, replacement);
		await vscode.workspace.applyEdit(edit);
		return `Applied edit to lines ${startLine + 1}-${endLine + 1}.`;
	}
};

const runPlaywrightTool: WuchatTool = {
	id: 'wuchat.runPlaywright',
	name: 'Run Playwright',
	description: 'Runs workspace Playwright tests and returns their output. Requires a local Playwright installation and user approval.',
	requiresApproval: true,
	inputSchema: 'optional relative Playwright test file path; leave empty to run all tests',
	async invoke(rawInput: string, ctx) {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder || folder.uri.scheme !== 'file') throw new Error('Wuchat: open a local workspace to run Playwright.');
		const cwd = folder.uri.fsPath;
		const requested = rawInput.trim();
		if (requested.includes('\n') || requested.startsWith('-') || path.isAbsolute(requested)) {
			throw new Error('Wuchat: provide one relative test file path, or no input for all tests.');
		}
		if (requested) {
			const target = path.resolve(cwd, requested);
			if (!target.startsWith(cwd + path.sep) && target !== cwd) {
				throw new Error('Wuchat: the Playwright test file must be inside the workspace.');
			}
		}
		const candidates = [
			path.join(cwd, 'node_modules', 'playwright', 'cli.js'),
			path.join(cwd, 'node_modules', '@playwright', 'test', 'cli.js')
		];
		const cli = candidates.find(existsSync);
		if (!cli) return 'Playwright is not installed in this workspace. Install @playwright/test as a dev dependency, then run this tool again.';
		if (ctx.token.isCancellationRequested) return 'Playwright run cancelled.';
		return new Promise<string>(resolve => {
			const child = spawn(process.execPath, [cli, 'test', ...(requested ? [requested] : [])], {
				cwd, shell: false, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe']
			});
			let output = '';
			let truncated = false;
			let timedOut = false;
			const append = (chunk: Buffer): void => {
				output += chunk.toString('utf8');
				if (output.length > 16_000) { output = output.slice(-16_000); truncated = true; }
			};
			child.stdout.on('data', append);
			child.stderr.on('data', append);
			const stop = (): void => { child.kill('SIGTERM'); };
			const cancellation = ctx.token.onCancellationRequested(stop);
			const timeout = setTimeout(() => { timedOut = true; stop(); }, 120_000);
			child.on('error', error => {
				clearTimeout(timeout); cancellation.dispose();
				resolve(`Could not start Playwright: ${error.message}`);
			});
			child.on('close', (code, signal) => {
				clearTimeout(timeout); cancellation.dispose();
				const status = timedOut ? 'timed out after 120 seconds' : signal ? `stopped (${signal})` : `exit code ${code}`;
				resolve(`Playwright ${status}.\n${truncated ? '[Earlier output truncated]\n' : ''}${output || '(no output)'}`);
			});
		});
	}
};

export const defaultTools: WuchatTool[] = [
	readFileTool,
	writeFileTool,
	openFileTool,
	runCommandTool,
	listWorkspaceTool,
	applyEditTool,
	runPlaywrightTool
];
