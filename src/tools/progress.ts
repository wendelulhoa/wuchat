import { FileChange, TodoItem, WuchatTool } from '../common/types';

export function fileChange(filePath: string, before: string, after: string, created = false): FileChange {
	const oldLines = before ? before.split('\n') : [];
	const newLines = after ? after.split('\n') : [];
	let start = 0;
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
	let oldEnd = oldLines.length;
	let newEnd = newLines.length;
	while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
	return {
		path: filePath,
		before: oldLines.slice(start, oldEnd).join('\n').slice(0, 4000),
		after: newLines.slice(start, newEnd).join('\n').slice(0, 4000),
		added: newEnd - start,
		removed: oldEnd - start,
		created
	};
}

export const updateTodosTool: WuchatTool = {
	id: 'wuchat.updateTodos',
	name: 'Update Todos',
	description: 'Shows a task checklist in Wuchat. For multi-step work, publish tasks before editing and update their status as work progresses. Do not mark a task completed until verified.',
	requiresApproval: false,
	inputSchema: 'JSON: {"todos":[{"id":"1","title":"Inspect project","status":"not-started|in-progress|completed"}]}',
	async invoke(rawInput: string, ctx) {
		let input: { todos?: TodoItem[] };
		try { input = JSON.parse(rawInput); } catch { throw new Error('Wuchat: expected JSON with a todos array.'); }
		if (!Array.isArray(input?.todos) || input.todos.length < 1 || input.todos.length > 20 ||
			input.todos.some(item => !item || typeof item.id !== 'string' || !item.id.trim() || typeof item.title !== 'string' || !item.title.trim() ||
				!['not-started', 'in-progress', 'completed'].includes(item.status)) ||
			new Set(input.todos.map(item => item.id.trim().slice(0, 80))).size !== input.todos.length ||
			input.todos.filter(item => item.status === 'in-progress').length > 1) {
			throw new Error('Wuchat: supply 1-20 unique todos with a title and valid status (at most one in progress).');
		}
		const todos = input.todos.map(item => ({ id: item.id.trim().slice(0, 80), title: item.title.trim().slice(0, 200), status: item.status }));
		ctx.onTodos?.(todos);
		return `Updated ${todos.length} tasks.`;
	}
};