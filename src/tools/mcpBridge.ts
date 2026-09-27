/*---------------------------------------------------------------------------------------------
 *  Wuchat — MCP bridge.
 *  Exposes the language model tools contributed by MCP servers and other
 *  extensions (vscode.lm.tools) as Wuchat tools, so any agent can call them
 *  through the same approval policy as the built-in tools.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { WuchatTool, WuchatToolInvocationContext } from '../common/types';
import { Logger } from '../common/logger';
import { ToolRegistry } from './ToolRegistry';

const MCP_PREFIX = 'mcp.';

export function isMcpToolId(id: string): boolean {
	return id.startsWith(MCP_PREFIX);
}

/** Registers every `vscode.lm.tools` contribution as a Wuchat tool (`mcp.<name>`). */
export function registerMcpTools(registry: ToolRegistry, logger: Logger): vscode.Disposable {
	const registered = new Map<string, vscode.Disposable>();

	const sync = () => {
		const contributed = vscode.lm.tools ?? [];
		const seen = new Set<string>();
		for (const tool of contributed) {
			const id = MCP_PREFIX + tool.name;
			seen.add(id);
			if (registered.has(id)) continue;
			const wuchatTool = wrapLanguageModelTool(tool);
			registry.register(wuchatTool);
			registered.set(id, {
				dispose: () => registry.unregister(id)
			});
		}
		for (const [id, disposable] of registered) {
			if (!seen.has(id)) {
				disposable.dispose();
				registered.delete(id);
			}
		}
		logger.info(`MCP bridge: ${registered.size} contributed tool(s) available.`);
	};

	sync();
	return vscode.lm.onDidChangeChatTools?.(() => sync()) ?? {
		dispose: () => { /* provider without change events */ }
	};
}

function wrapLanguageModelTool(tool: vscode.LanguageModelChatTool): WuchatTool {
	const source = tool.tags?.includes('mcp') ? 'MCP server' : 'VS Code extension';
	return {
		id: MCP_PREFIX + tool.name,
		name: tool.name,
		description: `${tool.description} (provided by a ${source})`,
		requiresApproval: true,
		inputSchema: describeSchema(tool.inputSchema),
		async invoke(rawInput: string, _ctx: WuchatToolInvocationContext): Promise<string> {
			let parsed: unknown;
			try {
				parsed = JSON.parse(rawInput);
			} catch {
				parsed = { input: rawInput };
			}
			const result = await vscode.lm.invokeTool(tool.name, { input: parsed instanceof Object ? parsed : { input: parsed }, toolInvocationToken: undefined });
			return stringifyToolResult(result.content);
		}
	};
}

function describeSchema(schema: { type: string | undefined }): string {
	if (!schema?.type) return 'JSON object with the fields the tool expects';
	return `Input matching JSON schema type "${schema.type}"`;
}

function stringifyToolResult(parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart | unknown>): string {
	return parts.map(part => {
		if (part instanceof vscode.LanguageModelTextPart) return part.value;
		if (part instanceof vscode.LanguageModelPromptTsxPart) return '[prompt-tsx result]';
		return JSON.stringify(part);
	}).join('\n').slice(0, 20_000);
}
