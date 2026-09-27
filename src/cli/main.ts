#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AgentCapabilities, ChatMessage, ChatRequest, CancellationToken, WuchatTool } from '../common/types';
import { BaseAgent } from '../agents/Agent';
import { ToolRegistry } from '../tools/ToolRegistry';
import { configuredCliProvider } from './provider';

const execAsync = promisify(exec);
const root = path.resolve(process.env.WUCHAT_WORKSPACE ?? process.cwd());
const storeDir = path.join(homedir(), '.wuchat', 'sessions');
const token: CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

async function main(): Promise<void> {
	if (process.argv.includes('--help') || process.argv.includes('-h')) {
		console.log('Wuchat CLI\n\nUsage: wuchat [--session ID] [--agent ask|agent] [--yes]\n\nRun inside tmux to keep a session alive across SSH disconnects.');
		return;
	}
	const { provider, model } = configuredCliProvider();
	const sessionIndex = process.argv.indexOf('--session');
	const sessionId = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : randomUUID().slice(0, 8);
	if (!sessionId || sessionId.startsWith('-')) throw new Error('--session requires an ID.');
	const sessionFile = path.join(storeDir, `${sessionId}.json`);
	await mkdir(storeDir, { recursive: true });
	let history = await readSession(sessionFile);
	const agentMode = process.argv.includes('--agent') || process.env.WUCHAT_AGENT === 'agent';
	const autoApprove = process.argv.includes('--yes');
	const registry = new ToolRegistry();
	registerCliTools(registry);
	const caps: AgentCapabilities = { readEditor: false, readWorkspace: true, editFiles: agentMode, runTerminal: agentMode };
	const agent = new BaseAgent({
		id: agentMode ? 'wuchat.agent' : 'wuchat.ask',
		name: agentMode ? 'Agent' : 'Ask',
		description: 'Wuchat CLI agent',
		systemPrompt: agentMode
			? 'You are Wuchat Agent, a coding assistant running in a terminal. Make focused changes using tools. Ask before destructive actions.'
			: 'You are Wuchat Ask, a concise coding assistant. Answer clearly and inspect workspace files only when useful.',
		tools: agentMode
			? ['wuchat.readFile', 'wuchat.listWorkspace', 'wuchat.writeFile', 'wuchat.runCommand']
			: ['wuchat.readFile', 'wuchat.listWorkspace'],
		capabilities: caps,
		runtime: {
			confirm: async (title, detail) => {
				if (autoApprove) return true;
				const answer = await terminal.question(`${title}\n${detail}\nAllow? [y/N] `);
				return answer.trim().toLowerCase() === 'y';
			}
		}
	}, registry);
	const terminal = createInterface({ input: stdin, output: stdout });
	console.log(`Wuchat · ${provider.name} / ${model} · ${root}\nSession ${sessionId}. Type /exit to leave.`);
	try {
		while (true) {
			const prompt = (await terminal.question('\nYou> ')).trim();
			if (!prompt) continue;
			if (prompt === '/exit' || prompt === '/quit') break;
			if (prompt === '/history') {
				console.log(`Loaded ${history.length} messages from ${sessionId}.`);
				continue;
			}
			const request: ChatRequest = {
				requestId: randomUUID(), agent: agent.id, prompt, history, context: { attachments: [] },
				tools: [], token
			};
			const result = await agent.invoke(request, provider, model, { onText: text => stdout.write(text) });
			if (result.error) console.error(`\nProvider error: ${result.error}`);
			else if (!result.text) console.log('(No response)');
			console.log();
			history = [
				...history,
				{ role: 'user', content: prompt },
				{ role: 'assistant', content: result.text, toolCalls: result.toolCalls }
			];
			await writeFile(sessionFile, JSON.stringify({ id: sessionId, workspace: root, updatedAt: new Date().toISOString(), messages: history }, null, 2), { mode: 0o600 });
		}
	} finally {
		terminal.close();
	}
}

async function readSession(file: string): Promise<ChatMessage[]> {
	try {
		const parsed = JSON.parse(await readFile(file, 'utf8')) as { messages?: ChatMessage[] };
		return Array.isArray(parsed.messages) ? parsed.messages : [];
	} catch { return []; }
}

function registerCliTools(registry: ToolRegistry): void {
	const resolveWorkspacePath = (raw: string) => {
		const target = path.resolve(root, raw);
		if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Path must stay inside the workspace.');
		return target;
	};
	const tools: WuchatTool[] = [
		{
			id: 'wuchat.readFile', name: 'Read File', description: 'Reads a UTF-8 text file from the workspace.', requiresApproval: false,
			inputSchema: 'relative file path',
			async invoke(raw) { return readFile(resolveWorkspacePath(raw.trim().split('\n')[0]), 'utf8'); }
		},
		{
			id: 'wuchat.listWorkspace', name: 'List Workspace', description: 'Lists files and folders in the workspace.', requiresApproval: false,
			inputSchema: '(no input)',
			async invoke() { return (await readdir(root, { withFileTypes: true })).map(entry => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`).join('\n'); }
		},
		{
			id: 'wuchat.writeFile', name: 'Write File', description: 'Creates or overwrites a workspace file. Requires approval.', requiresApproval: true,
			inputSchema: 'first line: relative file path; remaining lines: file content',
			async invoke(raw) {
				const split = raw.indexOf('\n');
				if (split < 0) throw new Error('Provide a relative path on the first line and content afterwards.');
				const file = resolveWorkspacePath(raw.slice(0, split).trim());
				await mkdir(path.dirname(file), { recursive: true });
				await writeFile(file, raw.slice(split + 1));
				return `Wrote ${path.relative(root, file)}.`;
			}
		},
		{
			id: 'wuchat.runCommand', name: 'Run Command', description: 'Runs a shell command in the workspace. Requires approval.', requiresApproval: true,
			inputSchema: 'shell command',
			async invoke(raw) {
				const { stdout: output, stderr } = await execAsync(raw.trim(), { cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024 });
				return `${output}${stderr ? `\n${stderr}` : ''}`.trim() || '(command completed without output)';
			}
		}
	];
	for (const tool of tools) registry.register(tool);
}

main().catch(error => {
	console.error(`wuchat: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});