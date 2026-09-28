#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AgentCapabilities, ChatMessage, ChatRequest, CancellationToken, WuchatTool } from '../common/types';
import { BaseAgent } from '../agents/Agent';
import { ToolRegistry } from '../tools/ToolRegistry';
import { resolveCliProvider, listConnectedModels } from './provider';
import { createCliUi } from './ui';

const execAsync = promisify(exec);
const root = path.resolve(process.env.WUCHAT_WORKSPACE ?? process.cwd());
const storeDir = path.join(homedir(), '.wuchat', 'sessions');
const token: CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

async function main(): Promise<void> {
	if (process.argv.includes('--help') || process.argv.includes('-h')) {
		console.log('Wuchat CLI\n\nUsage: wuchat [sessions] [--connected] [--api] [--session ID] [--agent ask|agent] [--yes]\n\nsessions: list saved CLI sessions.\nDefault: use the authenticated provider selected in Wuchat while VS Code is active.\n--api: use a direct API-key provider selected by WUCHAT_PROVIDER.\nIn-chat commands: /model, /sessions, /history, /exit.\nRun inside tmux to keep a session alive across SSH disconnects.');
		return;
	}
	if (process.argv[2] === 'sessions') {
		if (process.argv[3] === 'delete') {
			const target = process.argv[4];
			if (!target) throw new Error('Usage: wuchat sessions delete <id>');
			await deleteCliSession(target);
			return;
		}
		await listSessions();
		return;
	}
	const { provider, model } = await resolveCliProvider({
		connectedOnly: process.argv.includes('--connected'),
		apiMode: process.argv.includes('--api')
	});
	const sessionIndex = process.argv.indexOf('--session');
	const sessionId = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : randomUUID().slice(0, 8);
	if (!sessionId || sessionId.startsWith('-')) throw new Error('--session requires an ID.');
	const sessionFile = path.join(storeDir, `${sessionId}.json`);
	await mkdir(storeDir, { recursive: true });
	let history = await readSession(sessionFile);
	const agentMode = process.argv.includes('--agent') || process.env.WUCHAT_AGENT === 'agent';
	const autoApprove = process.argv.includes('--yes');
	const promptIndex = process.argv.indexOf('--prompt');
	const oneShotPrompt = promptIndex >= 0 ? process.argv[promptIndex + 1] : undefined;
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
	let activeModel = model;
	const ui = createCliUi(provider.name, activeModel);
	if (oneShotPrompt !== undefined) {
		// Non-interactive mode: process a single prompt and exit (used by the chat's CLI execution mode).
		// Stdin is not ours; keep it paused so the readline instance never holds the event loop open.
		stdin.pause();
		history = [...history, { role: 'user', content: oneShotPrompt }];
		await writeSession(sessionFile, sessionId, history, provider.id, activeModel);
		const request: ChatRequest = {
			requestId: randomUUID(), agent: agent.id, prompt: oneShotPrompt, history: history.slice(0, -1), context: { attachments: [] },
			tools: [], token
		};
		const result = await agent.invoke(request, provider, activeModel, { onText: text => stdout.write(text) });
		history = [
			...history,
			{ role: 'assistant', content: result.text, toolCalls: result.toolCalls }
		];
		await writeSession(sessionFile, sessionId, history, provider.id, activeModel);
		stdout.write('');
		process.exit(result.error ? 1 : 0);
	}
	ui.header(sessionId);
	try {
		while (true) {
			const prompt = (await terminal.question(ui.prompt())).trim();
			if (!prompt) continue;
			if (prompt === '/exit' || prompt === '/quit') break;
			if (prompt === '/model' || prompt.startsWith('/model ')) {
				activeModel = await pickModel(terminal, provider, activeModel, prompt.slice(6).trim());
				continue;
			}
			if (prompt === '/sessions') {
				await listSessions();
				continue;
			}
			if (prompt === '/history') {
				console.log(ui.dim(`Loaded ${history.length} messages from ${sessionId}.`));
				continue;
			}
			const request: ChatRequest = {
				requestId: randomUUID(), agent: agent.id, prompt, history, context: { attachments: [] },
				tools: [], token
			};
			const spinner = ui.spinner(`${provider.name} · ${activeModel || 'auto'}`);
			const result = await agent.invoke(request, provider, activeModel, {
				onText: text => { spinner.stop(); stdout.write(text); },
				onToolCall: (_tool, status) => { if (status === 'started') spinner.stop(); else if (status === 'finished') spinner.start(); },
				onSystemMessage: text => { spinner.stop(); console.log(ui.dim(text)); spinner.start(); }
			});
			spinner.stop();
			if (result.error) console.error(ui.dim(`Provider error: ${result.error}`));
			else if (!result.text) console.log('(No response)');
			console.log();
			history = [
				...history,
				{ role: 'user', content: prompt },
				{ role: 'assistant', content: result.text, toolCalls: result.toolCalls }
			];
			await writeFile(sessionFile, JSON.stringify({ id: sessionId, workspace: root, updatedAt: new Date().toISOString(), provider: provider.id, model: activeModel, messages: history }, null, 2), { mode: 0o600 });
		}
	} finally {
		terminal.close();
	}
}

async function writeSession(file: string, id: string, messages: ChatMessage[], provider: string, model: string): Promise<void> {
	await writeFile(file, JSON.stringify({ id, workspace: root, updatedAt: new Date().toISOString(), provider, model, messages }, null, 2), { mode: 0o600 });
}

/** Interactive model picker; `preselected` switches without listing. */
async function pickModel(
	terminal: ReturnType<typeof createInterface>,
	provider: { id: string; name: string; setModel?: (model: string) => void },
	current: string,
	preselected: string
): Promise<string> {
	if (preselected) {
		provider.setModel?.(preselected);
		console.log(`Model set to ${preselected} for this session.`);
		return preselected;
	}
	try {
		const listing = await listConnectedModels();
		if (!listing.models.length) {
			console.log('No models are listed for the active provider.');
			return current;
		}
		listing.models.forEach((candidate, index) => {
			const marker = candidate.id === current ? ' *' : '';
			console.log(`  ${index + 1}. ${candidate.name} (${candidate.id})${marker}`);
		});
		const answer = (await terminal.question('Model number or id (empty cancels): ')).trim();
		if (!answer) return current;
		const numeric = Number.parseInt(answer, 10);
		const chosen = Number.isInteger(numeric) && numeric >= 1 && numeric <= listing.models.length
			? listing.models[numeric - 1].id
			: answer;
		provider.setModel?.(chosen);
		console.log(`Model set to ${chosen} for this session.`);
		return chosen;
	} catch (error) {
		console.log(error instanceof Error ? error.message : String(error));
		return current;
	}
}

/** Prints saved CLI sessions from ~/.wuchat/sessions with brief titles. */
async function listSessions(): Promise<void> {
	const sessions = await loadCliSessions();
	if (!sessions.length) {
		console.log('No saved CLI sessions yet.');
		return;
	}
	sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
	console.log('Saved CLI sessions (resume: wuchat --session <id> · delete: wuchat sessions delete <id>):');
	for (const session of sessions) {
		console.log(`  ${session.id}  ${session.title}  ${session.updatedAt ?? '?'}`);
	}
}

/** Deletes one CLI session file by id. */
async function deleteCliSession(id: string): Promise<void> {
	const file = path.join(storeDir, `${id}.json`);
	await rm(file, { force: true });
	console.log(`Deleted CLI session ${id}.`);
}

interface CliSessionSummary { id: string; title: string; updatedAt?: string; workspace?: string }

/** Reads all CLI session files, deriving a short title like the chat history does. */
async function loadCliSessions(): Promise<CliSessionSummary[]> {
	let entries: string[];
	try {
		entries = await readdir(storeDir);
	} catch {
		return [];
	}
	const sessions: CliSessionSummary[] = [];
	for (const entry of entries.filter(name => name.endsWith('.json'))) {
		try {
			const parsed = JSON.parse(await readFile(path.join(storeDir, entry), 'utf8')) as { id?: string; workspace?: string; updatedAt?: string; messages?: ChatMessage[] };
			const firstUser = parsed.messages?.find(message => message.role === 'user')?.content ?? '';
			const id = parsed.id ?? entry.replace(/\.json$/, '');
			sessions.push({
				id,
				title: firstUser ? firstUser.replace(/\s+/g, ' ').trim().slice(0, 48) : 'New chat',
				updatedAt: parsed.updatedAt,
				workspace: parsed.workspace
			});
		} catch { /* skip unreadable session files */ }
	}
	return sessions;
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