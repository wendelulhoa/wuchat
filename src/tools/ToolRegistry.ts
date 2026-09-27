/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  Tool registry: agents look tools up here; the registry enforces the
 *  confirmation policy before any sensitive tool runs.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, WuchatTool, WuchatToolInvocationContext } from '../common/types';

export class ToolRegistry {
	private readonly tools = new Map<string, WuchatTool>();
	private sessionAutoApprove = false;

	setSessionAutoApprove(value: boolean): void { this.sessionAutoApprove = value; }
	get isSessionAutoApproved(): boolean { return this.sessionAutoApprove; }

	register(tool: WuchatTool): void {
		this.tools.set(tool.id, tool);
	}

	unregister(id: string): void {
		this.tools.delete(id);
	}

	get(id: string): WuchatTool | undefined {
		return this.tools.get(id);
	}

	getRequired(id: string): WuchatTool {
		const tool = this.tools.get(id);
		if (!tool) {
			throw new Error(`Wuchat: unknown tool "${id}".`);
		}
		return tool;
	}

	list(): WuchatTool[] {
		return [...this.tools.values()];
	}

	/**
	 * Runs a tool applying the approval policy:
	 * auto-approve setting OR tool not requiring approval -> run directly,
	 * otherwise ask the user through `confirm`.
	 */
	async run(
		id: string,
		rawInput: string,
		autoApprove: boolean,
		token: CancellationToken,
		confirm: (title: string, detail: string) => Promise<boolean>
	): Promise<string> {
		const tool = this.getRequired(id);
		const ctx: WuchatToolInvocationContext = { token, confirm };
		if (tool.requiresApproval && !autoApprove) {
			const approved = await confirm(`Wuchat: allow "${tool.name}"?`, tool.description);
			if (!approved) {
				return `Tool "${tool.name}" was not approved by the user.`;
			}
		}
		return tool.invoke(rawInput, ctx);
	}
}
