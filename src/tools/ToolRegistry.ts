/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  Tool registry: agents look tools up here; the registry enforces the
 *  confirmation policy before any sensitive tool runs.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, WuchatTool, WuchatToolInvocationContext } from '../common/types';

export class ToolRegistry {
	private readonly tools = new Map<string, WuchatTool>();
	private sessionAutoApprove = false;
	private refreshTools?: () => void;
	/** Per-tool approval policy, e.g. { "wuchat.runCommand": "allow" }. */
	private approvalPolicy = new Map<string, 'allow' | 'ask'>();

	setSessionAutoApprove(value: boolean): void { this.sessionAutoApprove = value; }
	get isSessionAutoApproved(): boolean { return this.sessionAutoApprove; }
	setToolRefresh(refresh?: () => void): void { this.refreshTools = refresh; }

	/** Updates the granular allow/ask policy (wildcard keys like "mcp.*" supported). */
	setApprovalPolicy(policy: Record<string, string>): void {
		this.approvalPolicy = new Map(Object.entries(policy).map(([key, level]) => [key, level === 'allow' ? 'allow' : 'ask']));
	}

	/** "allow" when the policy explicitly allows the tool (wildcards, most specific wins). */
	private policyAllows(toolId: string): boolean {
		let decision: 'allow' | 'ask' | undefined;
		for (const [pattern, level] of this.approvalPolicy) {
			const matches = pattern.endsWith('*')
				? toolId.startsWith(pattern.slice(0, -1))
				: toolId === pattern;
			if (matches) decision = level;
		}
		return decision === 'allow';
	}

	register(tool: WuchatTool): void {
		this.tools.set(tool.id, tool);
	}

	unregister(id: string): void {
		this.tools.delete(id);
	}

	get(id: string): WuchatTool | undefined {
		this.refreshTools?.();
		return this.tools.get(id);
	}

	getRequired(id: string): WuchatTool {
		const tool = this.get(id);
		if (!tool) {
			throw new Error(`Wuchat: unknown tool "${id}".`);
		}
		return tool;
	}

	list(): WuchatTool[] {
		this.refreshTools?.();
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
		confirm: (title: string, detail: string) => Promise<boolean>,
			events?: Pick<WuchatToolInvocationContext, 'onFileChange' | 'onTodos' | 'onOutput'>
	): Promise<string> {
		const tool = this.getRequired(id);
		const ctx: WuchatToolInvocationContext = { token, confirm, ...events };
		if (tool.requiresApproval && !autoApprove && !this.policyAllows(id)) {
			const approved = await confirm(`Wuchat: allow "${tool.name}"?`, tool.description);
			if (!approved) {
				return `Tool "${tool.name}" was not approved by the user.`;
			}
		}
		return tool.invoke(rawInput, ctx);
	}
}
