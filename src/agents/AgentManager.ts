/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  Built-in agents plus custom agents discovered from workspace .github/agents files.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Agent, AgentCapabilities } from '../common/types';
import { ToolRegistry } from '../tools/ToolRegistry';
import { BaseAgent } from './Agent';

const readWorkspaceCaps: AgentCapabilities = { readEditor: true, readWorkspace: true, editFiles: false, runTerminal: false };
const fullCaps: AgentCapabilities = { readEditor: true, readWorkspace: true, editFiles: true, runTerminal: true };
const allTools = ['wuchat.readFile', 'wuchat.writeFile', 'wuchat.openFile', 'wuchat.runCommand', 'wuchat.listWorkspace', 'wuchat.applyEdit', 'wuchat.runPlaywright', 'wuchat.browser'];

export class AgentManager {
	private readonly agents = new Map<string, Agent>();
	private readonly workspaceAgentIds = new Set<string>();

	constructor(private readonly toolRegistry: ToolRegistry) {
		this.registerDefaults();
	}

	private registerDefaults(): void {
		this.register(new BaseAgent({
			id: 'wuchat.ask',
			name: 'Ask',
			description: 'Answers questions about your code and workspace. Read-only.',
			systemPrompt: 'You are Wuchat Ask, a concise coding assistant embedded in VS Code. Answer clearly, use fenced code blocks for code, and prefer Markdown.',
			tools: ['wuchat.readFile', 'wuchat.listWorkspace', 'wuchat.openFile'],
			capabilities: readWorkspaceCaps
		}, this.toolRegistry));

		this.register(new BaseAgent({
			id: 'wuchat.explain',
			name: 'Explain',
			description: 'Explains the selected code or the current file in depth.',
			systemPrompt: 'You are Wuchat Explain. Produce a structured, in-depth explanation of the given code: purpose, behavior, edge cases and suggestions.',
			tools: ['wuchat.readFile', 'wuchat.listWorkspace'],
			capabilities: readWorkspaceCaps
		}, this.toolRegistry));

		this.register(new BaseAgent({
			id: 'wuchat.agent',
			name: 'Agent',
			description: 'Coding agent that reads and edits files or runs commands with approval.',
			systemPrompt: 'You are Wuchat Agent, an autonomous coding agent inside VS Code. Plan briefly, then use the supplied structured tools directly when needed. Prefer minimal, focused changes.',
			tools: [...new Set([...allTools, ...customTools()])],
			capabilities: fullCaps
		}, this.toolRegistry));
	}

	register(agent: Agent): void {
		this.agents.set(agent.id, agent);
	}

	get(agentId: string): Agent | undefined {
		return this.agents.get(agentId);
	}

	getRequired(agentId: string): Agent {
		const agent = this.agents.get(agentId);
		if (!agent) {
			throw new Error(`Wuchat: unknown agent "${agentId}".`);
		}
		return agent;
	}

	get defaultAgent(): Agent {
		const configured = vscode.workspace.getConfiguration('wuchat').get<string>('defaultAgent', 'wuchat.ask');
		return this.agents.get(configured) ?? this.agents.get('wuchat.ask')!;
	}

	list(): Agent[] {
		return [...this.agents.values()];
	}

	async refreshWorkspaceAgents(): Promise<void> {
		for (const id of this.workspaceAgentIds) this.agents.delete(id);
		this.workspaceAgentIds.clear();
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const root = vscode.Uri.joinPath(folder.uri, '.github', 'agents');
			await this.scanAgentDirectory(folder, root, root);
		}
	}

	private async scanAgentDirectory(folder: vscode.WorkspaceFolder, root: vscode.Uri, directory: vscode.Uri): Promise<void> {
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(directory);
		} catch {
			return;
		}
		for (const [name, type] of entries) {
			const uri = vscode.Uri.joinPath(directory, name);
			if (type & vscode.FileType.Directory) {
				await this.scanAgentDirectory(folder, root, uri);
				continue;
			}
			if (!(type & vscode.FileType.File) || !name.toLowerCase().endsWith('.md')) continue;
			try {
				const source = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
				const parsed = parseCustomAgent(source, name);
				if (!parsed || parsed.userInvocable === false) continue;
				const relative = uri.path.slice(root.path.length + 1);
				const id = `workspace.${folder.name}.${relative.replace(/\.md$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '.')}`;
				const tools = mapAgentTools(parsed.tools);
				const capabilities: AgentCapabilities = {
					readEditor: true,
					readWorkspace: tools.some(tool => ['wuchat.readFile', 'wuchat.listWorkspace', 'wuchat.openFile'].includes(tool)),
					editFiles: tools.some(tool => ['wuchat.writeFile', 'wuchat.applyEdit'].includes(tool)),
					runTerminal: tools.includes('wuchat.runCommand')
				};
				const agent = new BaseAgent({
					id,
					name: parsed.name || name.replace(/\.md$/i, ''),
					description: parsed.description || `${folder.name} · ${relative}`,
					systemPrompt: parsed.body || `Follow the ${name} custom agent instructions.`,
					tools,
					capabilities
				}, this.toolRegistry);
				this.agents.set(agent.id, agent);
				this.workspaceAgentIds.add(agent.id);
			} catch {
				// Ignore a malformed or unreadable agent file and keep other agents available.
			}
		}
	}
}

interface ParsedAgent {
	name?: string;
	description?: string;
	tools?: string[];
	userInvocable?: boolean;
	body: string;
}

function customTools(): string[] {
	return vscode.workspace.getConfiguration('wuchat').get<string[]>('agent.customTools', []);
}

function parseCustomAgent(source: string, fileName: string): ParsedAgent | undefined {
	const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/);
	if (!match) return { body: source.trim(), name: fileName.replace(/\.md$/i, '') };
	const frontmatter = match[1];
	const body = match[2].trim();
	const parsed: ParsedAgent = { body };
	let currentList: 'tools' | undefined;
	for (const line of frontmatter.split(/\r?\n/)) {
		const key = line.match(/^([a-zA-Z-]+):\s*(.*)$/);
		if (key) {
			currentList = undefined;
			const [, rawKey, rawValue] = key;
			const value = rawValue.trim().replace(/^['"]|['"]$/g, '');
			if (rawKey === 'name') parsed.name = value;
			else if (rawKey === 'description') parsed.description = value;
			else if (rawKey === 'user-invocable') parsed.userInvocable = value.toLowerCase() !== 'false';
			else if (rawKey === 'tools') {
				parsed.tools = [];
				currentList = 'tools';
				if (value.startsWith('[') && value.endsWith(']')) {
					parsed.tools.push(...value.slice(1, -1).split(',').map(item => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
				} else if (value) parsed.tools.push(value);
			}
			continue;
		}
		const item = line.match(/^\s+-\s+(.+?)\s*$/);
		if (currentList === 'tools' && item) parsed.tools?.push(item[1].replace(/^['"]|['"]$/g, ''));
	}
	return parsed;
}

function mapAgentTools(declared?: string[]): string[] {
	if (declared === undefined) return ['wuchat.readFile', 'wuchat.listWorkspace', 'wuchat.openFile'];
	const tools = new Set<string>();
	for (const value of declared) {
		const normalized = value.toLowerCase();
		if (value === '*') allTools.forEach(tool => tools.add(tool));
		else if (allTools.includes(value)) tools.add(value);
		else if (['read', 'search', 'search/codebase', 'search/files'].includes(normalized)) ['wuchat.readFile', 'wuchat.listWorkspace', 'wuchat.openFile'].forEach(tool => tools.add(tool));
		else if (normalized === 'edit') ['wuchat.writeFile', 'wuchat.applyEdit'].forEach(tool => tools.add(tool));
		else if (['terminal', 'runinterminal'].includes(normalized)) tools.add('wuchat.runCommand');
		else if (normalized === 'playwright') tools.add('wuchat.runPlaywright');
		else if (normalized === 'browser') tools.add('wuchat.browser');
	}
	return [...tools];
}
