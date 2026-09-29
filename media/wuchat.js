/* Wuchat webview: rendering and small UI state only. The extension owns data and actions. */
const vscodeApi = acquireVsCodeApi();
const messagesEl = document.getElementById('wuchat-messages');
const sessionPanel = document.getElementById('wuchat-session-panel');
const sessionList = document.getElementById('wuchat-session-list');
const sessionSearch = document.getElementById('wuchat-session-search');
const historyBtn = document.getElementById('wuchat-history');
const attachmentsEl = document.getElementById('wuchat-attachments');
const inputEl = document.getElementById('wuchat-input');
const sendBtn = document.getElementById('wuchat-send');
const stopBtn = document.getElementById('wuchat-stop');
const agentSelect = document.getElementById('wuchat-agent');
const modelSelect = document.getElementById('wuchat-model');
const effortSelect = document.getElementById('wuchat-effort');
const executionModeSelect = document.getElementById('wuchat-execution-mode');
const brandIcon = document.getElementById('wuchat-brand-icon');

const ICONS = {
	add: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2z"/></svg>',
	history: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 6.9 8.2l-1-.2A6 6 0 1 1 8 2v3l4-3.5L8-2v3z" transform="translate(0 1)"/><path d="M8 4.5a.5.5 0 0 1 .5.5v3l2.3 1.4-.5.9L7.5 8.7V5a.5.5 0 0 1 .5-.5z"/></svg>',
	gear: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M9.1 1l.4 1.8c.4.1.8.3 1.1.5l1.7-.8 1.4 1.4-.8 1.7c.2.3.4.7.5 1.1L15 7v2l-1.8.4c-.1.4-.3.8-.5 1.1l.8 1.7-1.4 1.4-1.7-.8c-.3.2-.7.4-1.1.5L9.1 15H7l-.4-1.8c-.4-.1-.8-.3-1.1-.5l-1.7.8-1.4-1.4.8-1.7c-.2-.3-.4-.7-.5-1.1L1 9V7l1.8-.4c.1-.4.3-.7.5-1.1l-.8-1.7 1.4-1.4 1.7.8c.3-.2.7-.4 1.1-.5L7 1h2.1zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>',
	send: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M4 7l4-4 4 4"/></svg>',
	stop: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>'
};
for (const [id, icon] of [['wuchat-new', 'add'], ['wuchat-history', 'history'], ['wuchat-settings', 'gear'], ['wuchat-attach', 'add']]) {
	document.getElementById(id).innerHTML = ICONS[icon];
}
sendBtn.innerHTML = ICONS.send;
stopBtn.innerHTML = ICONS.stop;

let busy = false;
let currentAgentId = 'wuchat.ask';
let currentSessionId = '';
let sessions = [];
let showingSessions = false;
let hasAvailableModel = false;

function post(message) { vscodeApi.postMessage(message); }

const effortLevels = {
	'anthropic': ['low', 'medium', 'high'],
	'openai-codex': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
	'zai-glm': ['low', 'high', 'max'],
	echo: []
};

function setSelectOptions(select, options, selected) {
	select.replaceChildren(...options);
	select.value = selected;
}

function syncSelectors(state) {
	const agents = state.agents ?? [];
	currentAgentId = state.defaultAgent || agents[0]?.id || 'wuchat.ask';
	setSelectOptions(agentSelect, agents.map(agent => {
		const option = document.createElement('option');
		option.value = agent.id;
		option.textContent = agent.name;
		option.title = agent.description || agent.name;
		return option;
	}), currentAgentId);

	const provider = state.provider || 'anthropic';
	const providerName = (state.modelGroups ?? []).find(group => group.id === provider)?.name || provider;
	const auto = document.createElement('option');
	auto.value = 'auto';
	auto.textContent = 'Auto model';
	const modelOptions = [auto];
	for (const group of state.modelGroups ?? []) {
		if (!group.models?.length) continue;
		const optgroup = document.createElement('optgroup');
		optgroup.label = group.name;
		for (const model of group.models) {
			const option = document.createElement('option');
			option.value = JSON.stringify({ provider: group.id, id: model.id });
			option.textContent = model.name;
			option.title = model.detail || `${group.name} · ${model.id}`;
			optgroup.appendChild(option);
		}
		modelOptions.push(optgroup);
	}
	const selectedModel = state.model ? JSON.stringify({ provider, id: state.model }) : 'auto';
	const hasSelectedModel = modelOptions.some(option => option.value === selectedModel || [...(option.children ?? [])].some(child => child.value === selectedModel));
	if (state.model && !hasSelectedModel) {
		const missing = document.createElement('option');
		missing.value = selectedModel;
		missing.textContent = state.model;
		modelOptions.push(missing);
	}
	setSelectOptions(modelSelect, modelOptions, selectedModel);
	hasAvailableModel = (state.modelGroups ?? []).some(group => group.models?.length);
	modelSelect.disabled = !hasAvailableModel;
	modelSelect.title = modelSelect.disabled ? 'Connect an AI provider in Settings to list models' : `Model · ${providerName}; Auto uses this provider default`;

	const levels = ['auto', ...(effortLevels[provider] ?? [])];
	const labels = { auto: 'Auto effort', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };
	setSelectOptions(effortSelect, levels.map(level => {
		const option = document.createElement('option');
		option.value = level;
		option.textContent = labels[level] || level;
		return option;
	}), levels.includes(state.effort) ? state.effort : 'auto');
	effortSelect.title = `Thinking effort · ${providerName}`;
}

function escapeHtml(text) {
	return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Minimal Markdown with escaped text and actionable fenced code blocks. */
function renderMarkdown(text) {
	const codeBlocks = [];
	let work = String(text ?? '').replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
		const index = codeBlocks.length;
		codeBlocks.push({ lang, code });
		return `\n___WUCHAT_CODEBLOCK_${index}___\n`;
	});
	work = escapeHtml(work)
		.replace(/`([^`\n]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="#" data-href="$2">$1</a>')
		.replace(/\n/g, '<br>');
	codeBlocks.forEach((block, index) => {
		const html = '<pre data-lang="' + escapeHtml(block.lang) + '"><code>' + escapeHtml(block.code) + '</code></pre>' +
			'<div class="code-actions"><button data-action="copy">Copy</button><button data-action="insert">Insert</button><button data-action="apply">Apply</button></div>';
		work = work.replace('<br>___WUCHAT_CODEBLOCK_' + index + '___<br>', html);
		work = work.replace('___WUCHAT_CODEBLOCK_' + index + '___', html);
	});
	return work;
}

function makeAvatar(className) {
	const avatar = brandIcon.cloneNode(true);
	avatar.removeAttribute('id');
	avatar.className = className;
	return avatar;
}

function makeMessageHeader(message) {
	const header = document.createElement('div');
	header.className = 'msg-header';
	if (message.role === 'assistant') header.appendChild(makeAvatar('msg-avatar'));
	const label = document.createElement('span');
	label.className = 'msg-agent';
	label.textContent = message.role === 'user' ? 'You' : message.agent || 'Wuchat';
	header.appendChild(label);
	if (message.role === 'assistant' && message.executionMode) {
		const badge = document.createElement('span');
		badge.className = 'msg-execution';
		badge.textContent = message.executionMode === 'cli' ? 'CLI' : 'Local';
		header.appendChild(badge);
	}
	return header;
}

function createActivity() {
	const activity = document.createElement('details');
	activity.className = 'msg-activity';
	const summary = document.createElement('summary');
	const title = document.createElement('strong');
	title.textContent = 'Activity';
	const count = document.createElement('span');
	count.className = 'activity-count';
	const meter = document.createElement('span');
	meter.className = 'activity-meter';
	meter.setAttribute('aria-hidden', 'true');
	meter.appendChild(document.createElement('span'));
	summary.append(title, count, meter);
	const steps = document.createElement('div');
	steps.className = 'activity-steps';
	steps.setAttribute('role', 'list');
	activity.append(summary, steps);
	return activity;
}

function addActivityStep(activity, step) {
	const steps = activity.querySelector('.activity-steps');
	let row = [...steps.children].find(item => item.dataset.stepId === step.id);
	if (!row) {
		row = document.createElement('div');
		row.className = 'activity-step';
		row.setAttribute('role', 'listitem');
		row.dataset.stepId = step.id;
		row.dataset.status = 'queued';
		const header = document.createElement('div');
		header.className = 'activity-step-header';
		const marker = document.createElement('span');
		marker.className = 'activity-marker';
		marker.setAttribute('aria-hidden', 'true');
		const label = document.createElement('span');
		label.className = 'activity-label';
		const status = document.createElement('span');
		status.className = 'activity-status';
		header.append(marker, label, status);
		row.appendChild(header);
		steps.appendChild(row);
	}
	row.querySelector('.activity-label').textContent = step.label;
	if (step.tool === 'wuchat.runCommand') {
		let action = row.querySelector('.activity-terminal');
		if (!action) {
			action = document.createElement('button');
			action.className = 'activity-terminal';
			action.setAttribute('aria-haspopup', 'true');
			action.textContent = 'Open terminal';
			action.addEventListener('click', () => post({ type: 'openAgentTerminal' }));
			row.querySelector('.activity-step-header').appendChild(action);
		}
	}
	return row;
}

function updateActivitySummary(activity) {
	const rows = [...activity.querySelectorAll('.activity-step')];
	const completed = rows.filter(row => ['finished', 'failed', 'rejected'].includes(row.dataset.status)).length;
	const active = rows.find(row => ['awaiting', 'started', 'retrying'].includes(row.dataset.status));
	const issues = rows.filter(row => ['failed', 'rejected'].includes(row.dataset.status)).length;
	const count = activity.querySelector('.activity-count');
	count.textContent = active ? `${completed}/${rows.length} · ${({ awaiting: 'Awaiting approval', retrying: 'Retrying', started: 'Running' })[active.dataset.status]}`
		: issues ? `${completed}/${rows.length} · ${issues} needs attention`
			: `${completed}/${rows.length} steps`;
	activity.querySelector('.activity-meter span').style.width = `${rows.length ? completed / rows.length * 100 : 0}%`;
}

function updateActivityStep(activity, progress) {
	const row = addActivityStep(activity, { id: progress.id, label: progress.label });
	row.dataset.status = progress.status;
	row.querySelector('.activity-status').textContent = ({ queued: 'Waiting', awaiting: 'Approval', started: 'Running', retrying: 'Retrying', finished: 'Done', failed: 'Failed', rejected: 'Skipped' })[progress.status] || progress.status;
	if (!progress.output && progress.status === 'finished') row.querySelector('.activity-result')?.remove();
	if (progress.output) {
		let result = row.querySelector('.activity-result');
		if (!result) {
			result = document.createElement('details');
			result.className = 'activity-result';
			const summary = document.createElement('summary');
			summary.textContent = 'View result';
			const output = document.createElement('pre');
			result.append(summary, output);
			row.appendChild(result);
		}
		result.querySelector('pre').textContent = String(progress.output).slice(0, 2000);
		if (progress.tool === 'wuchat.runCommand') {
			result.querySelector('summary').textContent = 'Command output';
			result.open = true;
		}
	}
	updateActivitySummary(activity);
}

function renderTodos(wrap, todos) {
	let panel = wrap.querySelector('.msg-todos');
	if (!todos?.length) { panel?.remove(); return; }
	if (!panel) {
		panel = document.createElement('details');
		panel.className = 'msg-todos';
		panel.open = true;
		const summary = document.createElement('summary');
		const title = document.createElement('strong');
		title.textContent = 'Tasks';
		const count = document.createElement('span');
		count.className = 'todo-count';
		summary.append(title, count);
		const list = document.createElement('div');
		list.className = 'todo-list';
		list.setAttribute('role', 'list');
		panel.append(summary, list);
		wrap.insertBefore(panel, wrap.querySelector('.msg-changes, .msg-activity, .msg-body'));
	}
	panel.querySelector('.todo-count').textContent = `${todos.filter(item => item.status === 'completed').length}/${todos.length}`;
	const list = panel.querySelector('.todo-list');
	const current = new Map([...list.children].map(row => [row.dataset.todoId, row]));
	for (const item of todos) {
		let row = current.get(item.id);
		if (!row) {
			row = document.createElement('div');
			row.className = 'todo-item';
			row.setAttribute('role', 'listitem');
			row.dataset.todoId = item.id;
			const marker = document.createElement('span');
			marker.className = 'todo-marker';
			marker.setAttribute('aria-hidden', 'true');
			const label = document.createElement('span');
			label.className = 'todo-label';
			const state = document.createElement('span');
			state.className = 'todo-status';
			row.append(marker, label, state);
		}
		row.dataset.status = item.status;
		row.querySelector('.todo-label').textContent = item.title;
		row.querySelector('.todo-status').textContent = ({ 'not-started': 'Waiting', 'in-progress': 'In progress', completed: 'Done' })[item.status];
		list.appendChild(row);
		current.delete(item.id);
	}
	for (const row of current.values()) row.remove();
}

function addFileChange(wrap, change) {
	if (!change?.path) return;
	let panel = wrap.querySelector('.msg-changes');
	if (!panel) {
		panel = document.createElement('details');
		panel.className = 'msg-changes';
		panel.open = true;
		const summary = document.createElement('summary');
		const title = document.createElement('strong');
		title.textContent = 'Files changed';
		const count = document.createElement('span');
		count.className = 'change-count';
		summary.append(title, count);
		const list = document.createElement('div');
		list.className = 'change-list';
		panel.append(summary, list);
		wrap.insertBefore(panel, wrap.querySelector('.msg-activity, .msg-body'));
	}
	const list = panel.querySelector('.change-list');
	const file = document.createElement('details');
	file.className = 'change-file';
	const summary = document.createElement('summary');
	const name = document.createElement('span');
	name.className = 'change-path';
	name.textContent = change.path;
	name.title = change.path;
	const counts = document.createElement('span');
	counts.className = 'change-stats';
	if (change.created) {
		const badge = document.createElement('span');
		badge.className = 'change-created';
		badge.textContent = 'New';
		counts.appendChild(badge);
	}
	const added = document.createElement('span');
	added.className = 'change-added-count';
	added.textContent = `+${change.added}`;
	const removed = document.createElement('span');
	removed.className = 'change-removed-count';
	removed.textContent = `-${change.removed}`;
	counts.append(added, removed);
	summary.append(name, counts);
	const preview = document.createElement('div');
	preview.className = 'change-preview';
	for (const [kind, text] of [['removed', change.before], ['added', change.after]]) {
		if (!text) continue;
		const lines = document.createElement('pre');
		lines.className = `change-${kind}`;
		lines.textContent = text.split('\n').map(line => `${kind === 'added' ? '+' : '-'} ${line}`).join('\n');
		preview.appendChild(lines);
	}
	const open = document.createElement('button');
	open.type = 'button';
	open.className = 'change-open';
	open.dataset.filePath = change.path;
	open.textContent = 'Open file';
	open.title = `Open ${change.path} in VS Code`;
	preview.appendChild(open);
	file.append(summary, preview);
	list.appendChild(file);
	panel.querySelector('.change-count').textContent = `${new Set([...list.querySelectorAll('.change-path')].map(item => item.textContent)).size}`;
}

function followResponse(update) {
	const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
	update();
	if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessageElement(message, messageIndex = -1) {
	messagesEl.querySelector('.wuchat-welcome')?.remove();
	const wasNearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
	const wrap = document.createElement('article');
	wrap.className = `msg msg-${message.role}`;
	if (message.role !== 'system') {
		const header = makeMessageHeader(message);
		if (messageIndex >= 0 && message.content) {
			const actions = document.createElement('span');
			actions.className = 'msg-actions';
			const copy = document.createElement('button');
			copy.className = 'msg-action';
			copy.dataset.action = 'copyMessage';
			copy.dataset.messageIndex = String(messageIndex);
			copy.textContent = 'Copy';
			copy.title = 'Copy message';
			const fork = document.createElement('button');
			fork.className = 'msg-action';
			fork.dataset.action = 'forkSession';
			fork.dataset.upToIndex = String(messageIndex);
			fork.textContent = 'Fork';
			fork.title = 'Continue this conversation in a new branch from here';
			actions.append(copy, fork);
			header.appendChild(actions);
		}
		wrap.appendChild(header);
	}
	const body = document.createElement('div');
	body.className = 'msg-body';
	body.innerHTML = renderMarkdown(message.content);
	if (message.role === 'user' && message.attachments?.length) {
		const sentFiles = document.createElement('div');
		sentFiles.className = 'message-attachments';
		for (const attachment of message.attachments) {
			const item = document.createElement('span');
			item.className = 'message-attachment';
			const icon = document.createElement('span');
			icon.className = 'message-attachment-icon';
			icon.textContent = attachment.mimeType?.startsWith('image/') ? 'IMG' : attachment.mimeType === 'text/html' ? '</>' : 'FILE';
			const name = document.createElement('span');
			name.className = 'message-attachment-name';
			name.textContent = attachment.name;
			item.append(icon, name);
			sentFiles.appendChild(item);
		}
		body.appendChild(sentFiles);
	}
	wrap.appendChild(body);

	if (message.reasoning) {
		const details = document.createElement('details');
		details.className = 'msg-reasoning';
		const summary = document.createElement('summary');
		summary.textContent = 'Thinking';
		const reasoning = document.createElement('div');
		reasoning.className = 'reasoning-content';
		reasoning.innerHTML = renderMarkdown(message.reasoning);
		details.append(summary, reasoning);
		wrap.insertBefore(details, body);
	}
	if (message.todos?.length) renderTodos(wrap, message.todos);
	for (const call of message.toolCalls ?? []) {
		if (call.status === 'finished' && call.change) addFileChange(wrap, call.change);
	}
	if (message.plan?.length || message.toolCalls?.length) {
		const activity = createActivity();
		for (const [index, step] of (message.plan ?? []).entries()) {
			addActivityStep(activity, typeof step === 'string' ? { id: `legacy-${index}`, label: step } : step);
		}
		for (const [index, call] of (message.toolCalls ?? []).entries()) {
			const step = message.plan?.find(item => item.id === call.id);
			updateActivityStep(activity, {
				id: step?.id ?? call.id ?? `call-${index}`,
				label: step?.label ?? call.tool,
				tool: call.tool,
				status: call.status ?? 'finished',
				output: call.output
			});
		}
		updateActivitySummary(activity);
		wrap.insertBefore(activity, body);
	}
	if (message.error) {
		const error = document.createElement('div');
		error.className = 'msg-error';
		const title = document.createElement('strong');
		title.textContent = 'Request failed';
		const text = document.createElement('div');
		text.textContent = message.error;
		const test = document.createElement('button');
		test.className = 'secondary-button error-action';
		test.dataset.action = 'testProvider';
		if (message.provider) test.dataset.providerId = message.provider;
		test.textContent = 'Test connection';
		const retry = document.createElement('button');
		retry.className = 'primary-button error-action';
		retry.dataset.action = 'retry';
		retry.textContent = 'Retry';
		const actions = document.createElement('div');
		actions.className = 'error-actions';
		actions.append(retry, test);
		error.append(title, text, actions);
		wrap.appendChild(error);
	}
	messagesEl.appendChild(wrap);
	if (wasNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
	return wrap;
}

function renderMessages(messages) {
	// While streaming, keep the live pending bubble (and its partial text)
	// instead of wiping it — a state refresh must not interrupt the response.
	const pending = document.getElementById('wuchat-pending');
	messagesEl.replaceChildren();
	if (!messages.length) {
		const welcome = document.createElement('div');
		welcome.className = 'wuchat-welcome';
		welcome.appendChild(makeAvatar('welcome-icon'));
		const title = document.createElement('h1');
		title.textContent = 'What would you like to build?';
		const description = document.createElement('p');
		description.textContent = 'Explore your code, ask a question, or give an agent a task. Start with a prompt below.';
		const actions = document.createElement('div');
		actions.className = 'welcome-actions';
		for (const prompt of ['Explain this project', 'Help me fix an error', 'Build a new feature']) {
			const chip = document.createElement('button');
			chip.className = 'prompt-chip';
			chip.dataset.prompt = prompt;
			chip.textContent = prompt;
			actions.appendChild(chip);
		}
		welcome.append(title, description, actions);
		if (!hasAvailableModel) {
			const connect = document.createElement('button');
			connect.className = 'primary-button welcome-connect';
			connect.dataset.action = 'connect';
			connect.textContent = 'Connect an AI provider';
			welcome.appendChild(connect);
		}
		messagesEl.appendChild(welcome);
		return;
	}
let index = 0;
for (const message of messages) {
	addMessageElement(message, index++);
}
if (pending) {
	// Re-append the streaming bubble so partial text keeps updating.
	messagesEl.appendChild(pending);
}
messagesEl.scrollTop = messagesEl.scrollHeight;
}

function relativeTime(timestamp) {
	const elapsed = Math.max(0, Date.now() - timestamp);
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (elapsed < minute) return 'now';
	if (elapsed < hour) return `${Math.floor(elapsed / minute)}m ago`;
	if (elapsed < day) return `${Math.floor(elapsed / hour)}h ago`;
	if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}d ago`;
	return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function sessionGroup(timestamp) {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	if (timestamp >= today.getTime()) return 'Today';
	if (timestamp >= today.getTime() - 86_400_000) return 'Yesterday';
	return 'Earlier';
}

function renderSessions() {
	sessionList.replaceChildren();
	const query = sessionSearch.value.trim().toLocaleLowerCase();
	const filtered = sessions.filter(session => session.title.toLocaleLowerCase().includes(query));
	document.getElementById('session-count').textContent = `${filtered.length} conversation${filtered.length === 1 ? '' : 's'}`;
	if (!filtered.length) {
		const empty = document.createElement('div');
		empty.className = 'session-empty';
		empty.textContent = query ? 'No conversations match your search.' : 'No conversations yet. Start a chat below.';
		sessionList.appendChild(empty);
		return;
	}
	let lastGroup = '';
	for (const session of filtered) {
		const group = sessionGroup(session.updatedAt);
		if (group !== lastGroup) {
			const heading = document.createElement('div');
			heading.className = 'session-group-label';
			heading.textContent = group;
			sessionList.appendChild(heading);
			lastGroup = group;
		}
		const row = document.createElement('button');
		row.className = `session-row${session.failed ? ' failed' : ''}${session.running ? ' running' : ''}${session.id === currentSessionId ? ' active' : ''}`;
		row.dataset.sessionId = session.id;
		row.title = session.title;
		const dot = document.createElement('span');
		dot.className = 'session-dot';
		const copy = document.createElement('span');
		copy.className = 'session-copy';
		const title = document.createElement('span');
		title.className = 'session-title';
		title.textContent = session.title || 'New chat';
		const meta = document.createElement('span');
		meta.className = 'session-meta';
		meta.textContent = session.running ? 'Running · open to monitor' : session.failed ? 'Failed' : session.id === currentSessionId ? 'Current chat' : 'Conversation';
		copy.append(title, meta);
		const age = document.createElement('span');
		age.className = 'session-age';
		age.textContent = relativeTime(session.updatedAt);
		const del = document.createElement('span');
		del.className = 'session-delete';
		del.textContent = '×';
		del.dataset.deleteSessionId = session.id;
		del.title = 'Delete conversation';
		row.append(dot, copy, age, del);
		sessionList.appendChild(row);
	}
}

function showSessions(value) {
	showingSessions = value;
	messagesEl.hidden = value;
	sessionPanel.hidden = !value;
	historyBtn.setAttribute('aria-pressed', String(value));
	historyBtn.title = value ? 'Back to chat' : 'Sessions';
	if (value) {
		renderSessions();
		sessionSearch.focus();
	}
}

function addTransientError(text) {
	const el = document.createElement('div');
	el.className = 'msg msg-system msg-transient-error';
	const title = document.createElement('strong');
	title.textContent = 'Request failed';
	const errorText = document.createElement('div');
	errorText.textContent = text;
	const test = document.createElement('button');
	test.className = 'secondary-button error-action';
	test.dataset.action = 'testProvider';
	test.textContent = 'Test connection';
	const retry = document.createElement('button');
	retry.className = 'primary-button error-action';
	retry.dataset.action = 'retry';
	retry.textContent = 'Retry';
	const actions = document.createElement('div');
	actions.className = 'error-actions';
	actions.append(retry, test);
	el.append(title, errorText, actions);
	messagesEl.appendChild(el);
	messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateComposer() {
	inputEl.style.height = 'auto';
	inputEl.style.height = `${Math.min(inputEl.scrollHeight, 180)}px`;
	sendBtn.disabled = busy || !inputEl.value.trim();
}

function setBusy(value) {
	busy = value;
	const composerCard = document.querySelector('.composer-card');
	composerCard.classList.toggle('is-running', value);
	composerCard.setAttribute('aria-busy', String(value));
	sendBtn.style.display = value ? 'none' : '';
	stopBtn.style.display = value ? '' : 'none';
	updateComposer();
}

function sendPrompt(steer = false) {
	const text = inputEl.value.trim();
	if (!text) return;
	if (busy && !steer) {
		// Queue the message while the agent is still working.
		queued.push({ text, agentId: currentAgentId });
		inputEl.value = '';
		updateComposer();
		renderQueue();
		post({ type: 'queueSync', items: queued });
		return;
	}
	inputEl.value = '';
	updateComposer();
	showSessions(false);
	setBusy(true);
	post(steer ? { type: 'steer', text, agentId: currentAgentId } : { type: 'send', text, agentId: currentAgentId });
}

let queued = [];

function renderQueue() {
	const strip = document.getElementById('wuchat-queue');
	if (!strip) return;
	strip.replaceChildren();
	strip.hidden = queued.length === 0;
	queued.forEach((item, index) => {
		const row = document.createElement('div');
		row.className = 'queue-item';
		const label = document.createElement('span');
		label.className = 'queue-text';
		label.textContent = item.text;
		label.title = item.text;
		const sendNow = document.createElement('button');
		sendNow.className = 'queue-action';
		sendNow.textContent = 'Send now';
		sendNow.title = 'Move to the front and send immediately';
		sendNow.dataset.action = 'sendNow';
		sendNow.dataset.queueIndex = String(index);
		const remove = document.createElement('button');
		remove.className = 'queue-action';
		remove.textContent = '×';
		remove.title = 'Remove from queue';
		remove.dataset.action = 'remove';
		remove.dataset.queueIndex = String(index);
		row.append(label, sendNow, remove);
		strip.appendChild(row);
	});
}

document.getElementById('wuchat-attach').addEventListener('click', () => post({ type: 'attachFiles' }));
attachmentsEl.addEventListener('click', event => {
	const button = event.target.closest('.attachment-remove');
	if (!button) return;
	if (button.dataset.removeBrowserElement) post({ type: 'removeBrowserElement' });
	else post({ type: 'removeAttachment', attachmentIndex: Number(button.dataset.attachmentIndex) });
});
agentSelect.addEventListener('change', () => {
	currentAgentId = agentSelect.value;
	post({ type: 'setAgent', agentId: currentAgentId });
});
modelSelect.addEventListener('change', () => {
	let model = null;
	if (modelSelect.value !== 'auto') {
		try { model = JSON.parse(modelSelect.value); } catch { model = null; }
	}
	post({ type: 'setModel', model });
});
effortSelect.addEventListener('change', () => post({ type: 'setEffort', effort: effortSelect.value }));
sendBtn.addEventListener('click', () => sendPrompt());
stopBtn.addEventListener('click', () => post({ type: 'stop' }));
inputEl.addEventListener('input', updateComposer);
inputEl.addEventListener('keydown', event => {
	if (event.key === 'Enter' && !event.shiftKey) {
		event.preventDefault();
		sendPrompt();
	}
});
// Ctrl+Enter while the agent is working steers the running response.
inputEl.addEventListener('keydown', event => {
	if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && busy) {
		event.preventDefault();
		sendPrompt(true);
	}
});
document.getElementById('wuchat-queue').addEventListener('click', event => {
	const button = event.target.closest('.queue-action');
	if (!button) return;
	const index = Number(button.dataset.queueIndex);
	if (button.dataset.action === 'sendNow') {
		const [item] = queued.splice(index, 1);
		if (item) {
			renderQueue();
			post({ type: 'queueSync', items: queued });
			setBusy(true);
			post({ type: 'send', text: item.text, agentId: item.agentId });
		}
	} else if (button.dataset.action === 'remove') {
		queued.splice(index, 1);
		renderQueue();
		post({ type: 'queueSync', items: queued });
	}
});
document.getElementById('wuchat-new').addEventListener('click', () => {
	showSessions(false);
	post({ type: 'newChat' });
	inputEl.focus();
});
historyBtn.addEventListener('click', () => showSessions(!showingSessions));
document.getElementById('wuchat-settings').addEventListener('click', () => post({ type: 'openSettings' }));
document.getElementById('wuchat-cli').addEventListener('click', () => post({ type: 'openCli' }));
document.getElementById('wuchat-browser').addEventListener('click', () => post({ type: 'openBrowser' }));
document.getElementById('wuchat-browser-pick').addEventListener('click', () => post({ type: 'pickBrowserElement' }));
document.getElementById('wuchat-browser-capture').addEventListener('click', () => post({ type: 'captureBrowser' }));
document.getElementById('wuchat-approval-mode').addEventListener('change', event => post({ type: 'setApprovalMode', effort: event.target.value }));
executionModeSelect.addEventListener('change', event => post({ type: 'setExecutionMode', effort: event.target.value }));
sessionSearch.addEventListener('input', renderSessions);
sessionList.addEventListener('click', event => {
	const del = event.target.closest('[data-delete-session-id]');
	if (del) {
		event.stopPropagation();
		post({ type: 'deleteSession', sessionId: del.dataset.deleteSessionId });
		return;
	}
	const row = event.target.closest('[data-session-id]');
	if (!row) return;
	showSessions(false);
	post({ type: 'openSession', sessionId: row.dataset.sessionId });
});
messagesEl.addEventListener('click', event => {
	const target = event.target;
	const file = target.closest('[data-file-path]');
	if (file) { post({ type: 'openChangedFile', text: file.dataset.filePath }); return; }
	const prompt = target.closest('[data-prompt]');
	if (prompt) {
		inputEl.value = prompt.dataset.prompt;
		updateComposer();
		inputEl.focus();
		return;
	}
	const button = target.closest('button');
	if (button) {
		const action = button.dataset.action;
		if (action === 'connect') post({ type: 'connectProvider' });
		else if (action === 'testProvider') post({ type: 'testProvider', providerId: button.dataset.providerId });
		else if (action === 'retry') post({ type: 'retry' });
		else if (action === 'copyMessage') post({ type: 'copyMessage', messageIndex: Number(button.dataset.messageIndex) });
		else if (action === 'forkSession') post({ type: 'forkSession', upToIndex: Number(button.dataset.upToIndex) });
		else {
			const pre = button.parentElement?.previousElementSibling;
			const code = pre?.textContent ?? '';
			if (action === 'copy') post({ type: 'copy', text: code });
			else if (action === 'insert') post({ type: 'insertCode', text: code });
			else if (action === 'apply') post({ type: 'applyCode', text: code });
		}
		return;
	}
	const anchor = target.closest('a');
	if (anchor?.dataset.href) post({ type: 'openFile', text: anchor.dataset.href });
});

window.addEventListener('message', event => {
	const message = event.data;
	switch (message.type) {
		case 'ready':
		case 'state': {
				const previousSessionId = currentSessionId;
			syncSelectors(message);
			sessions = message.sessions ?? [];
			currentSessionId = message.currentSessionId ?? '';
				if (previousSessionId !== currentSessionId) document.getElementById('wuchat-pending')?.remove();
			renderSessions();
			document.getElementById('wuchat-workspace-label').textContent = message.workspaceName || 'No workspace';
			document.getElementById('wuchat-approval-mode').value = message.approvalMode || 'ask';
			if (!executionModeSelect.options.length) {
				for (const [value, label] of [['local', 'Local'], ['cli', 'CLI']]) {
					const option = document.createElement('option');
					option.value = value;
					option.textContent = label;
					executionModeSelect.appendChild(option);
				}
			}
			executionModeSelect.value = message.executionMode || 'local';
			attachmentsEl.replaceChildren();
			for (const attachment of message.attachments ?? []) {
				const tag = document.createElement('span');
				tag.className = 'attachment-tag';
				const name = document.createElement('span');
				name.className = 'attachment-name';
				name.textContent = attachment.name || 'Attachment';
				const remove = document.createElement('button');
				remove.className = 'attachment-remove';
				remove.type = 'button';
				remove.textContent = '×';
				remove.title = `Remove ${attachment.name || 'attachment'}`;
				remove.setAttribute('aria-label', remove.title);
				if (attachment.browserElement) remove.dataset.removeBrowserElement = 'true';
				else remove.dataset.attachmentIndex = String(attachment.index);
				tag.append(name, remove);
				attachmentsEl.appendChild(tag);
			}
			renderMessages(message.messages ?? []);
			queued = message.queue ?? [];
			renderQueue();
			if (message.running && !document.getElementById('wuchat-pending')) {
				const events = message.pendingEvents?.length
					? message.pendingEvents
					: [{ type: 'assistantStart', agent: 'Agent', executionMode: message.executionMode }];
				for (const entry of events) window.dispatchEvent(new MessageEvent('message', { data: entry }));
			}
			setBusy(Boolean(message.running));
			const meter = document.getElementById('wuchat-context-meter');
			if (meter && message.contextEstimate) {
				meter.textContent = `${message.contextEstimate.tokens.toLocaleString()} tokens · ${message.contextEstimate.messages} msg`;
				meter.title = 'Estimated context size sent to the model. Use Wuchat: Compact Context to summarize older turns.';
			}
			if (message.transientError) addTransientError(message.transientError);
			break;
		}
		case 'sessions':
			sessions = message.sessions ?? sessions;
			renderSessions();
			break;
		case 'queue':
			queued = message.items ?? [];
			renderQueue();
			break;
		case 'clearError':
			messagesEl.querySelector('.msg-transient-error')?.remove();
			break;
		case 'clearComposerAttachments':
			attachmentsEl.replaceChildren();
			break;
		case 'streamStart':
			setBusy(true);
			break;
		case 'streamEnd':
			setBusy(false);
			break;
		case 'userMessage':
			addMessageElement(message.message);
			break;
		case 'assistantStart': {
			document.getElementById('wuchat-pending')?.remove();
			const pending = document.createElement('article');
			pending.className = 'msg msg-assistant';
			pending.id = 'wuchat-pending';
			pending.appendChild(makeMessageHeader({ role: 'assistant', agent: message.agent, executionMode: message.executionMode }));
			const body = document.createElement('div');
			body.className = 'msg-body pending-indicator';
			body.id = 'wuchat-pending-text';
			body.textContent = 'Thinking';
			pending.appendChild(body);
			messagesEl.appendChild(pending);
			messagesEl.scrollTop = messagesEl.scrollHeight;
			break;
		}
		case 'assistantChunk': {
			const body = document.getElementById('wuchat-pending-text');
			if (body) {
				followResponse(() => {
					body.classList.remove('pending-indicator');
					body.dataset.raw = (body.dataset.raw ?? '') + (message.text ?? '');
					body.innerHTML = renderMarkdown(body.dataset.raw);
				});
			}
			break;
		}
		case 'assistantReasoning': {
			const pending = document.getElementById('wuchat-pending');
			if (pending) {
				followResponse(() => {
					let details = pending.querySelector('.msg-reasoning');
					if (!details) {
						details = document.createElement('details');
						details.className = 'msg-reasoning';
						details.open = true;
						const summary = document.createElement('summary');
						summary.textContent = 'Thinking';
						const body = document.createElement('div');
						body.className = 'reasoning-content';
						details.append(summary, body);
						pending.insertBefore(details, pending.querySelector('.msg-activity, .msg-body'));
					}
					const body = details.querySelector('.reasoning-content');
					body.dataset.raw = (body.dataset.raw ?? '') + (message.text ?? '');
					body.innerHTML = renderMarkdown(body.dataset.raw);
					const placeholder = pending.querySelector('#wuchat-pending-text.pending-indicator');
					if (placeholder) { placeholder.textContent = ''; placeholder.classList.remove('pending-indicator'); }
				});
			}
			break;
		}
		case 'plan': {
			const pending = document.getElementById('wuchat-pending');
			if (pending) {
				followResponse(() => {
					let activity = pending.querySelector('.msg-activity');
					if (!activity) {
						activity = createActivity();
						activity.open = true;
						pending.insertBefore(activity, pending.querySelector('.msg-body'));
					}
					for (const [index, step] of (message.steps ?? []).entries()) {
						addActivityStep(activity, typeof step === 'string' ? { id: `legacy-${index}`, label: step } : step);
					}
					updateActivitySummary(activity);
				});
			}
			break;
		}
		case 'todos': {
			const pending = document.getElementById('wuchat-pending');
			if (pending) followResponse(() => renderTodos(pending, message.todos));
			break;
		}
		case 'toolCall': {
			const pending = document.getElementById('wuchat-pending');
			if (pending) {
				followResponse(() => {
					let activity = pending.querySelector('.msg-activity');
					if (!activity) {
						activity = createActivity();
						activity.open = true;
						pending.insertBefore(activity, pending.querySelector('.msg-body'));
					}
					const legacyRows = !message.id ? [...activity.querySelectorAll('.activity-step')].filter(row => row.dataset.stepId.startsWith('legacy-')) : [];
					const legacyStep = message.status === 'started'
						? legacyRows.find(row => row.dataset.status === 'queued')
						: legacyRows.find(row => ['awaiting', 'started', 'retrying'].includes(row.dataset.status)) ?? legacyRows.find(row => row.dataset.status === 'queued');
					updateActivityStep(activity, {
						id: message.id ?? legacyStep?.dataset.stepId ?? message.tool,
						label: message.label ?? legacyStep?.querySelector('.activity-label')?.textContent ?? message.tool,
						tool: message.tool,
						status: message.status,
						output: message.output
					});
					if (message.status === 'finished' && message.change) addFileChange(pending, message.change);
				});
			}
			break;
		}
		case 'assistantDone':
			document.getElementById('wuchat-pending')?.remove();
			addMessageElement({ ...message.message, executionMode: message.executionMode });
			break;
		case 'system':
			addMessageElement({ role: 'system', content: message.text });
			break;
		case 'error': {
			document.getElementById('wuchat-pending')?.remove();
			addTransientError(message.text);
			break;
		}
	}
});

updateComposer();
post({ type: 'ready' });
