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
	'claude-plan': ['low', 'medium', 'high'],
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

	const provider = state.provider || 'claude-plan';
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
	return header;
}

function addMessageElement(message) {
	messagesEl.querySelector('.wuchat-welcome')?.remove();
	const wasNearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
	const wrap = document.createElement('article');
	wrap.className = `msg msg-${message.role}`;
	if (message.role !== 'system') wrap.appendChild(makeMessageHeader(message));
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
		wrap.appendChild(details);
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
	if (message.toolCalls?.length) {
		const activity = document.createElement('details');
		activity.className = 'tool-activity';
		const summary = document.createElement('summary');
		summary.textContent = `${message.toolCalls.length} action${message.toolCalls.length === 1 ? '' : 's'} completed`;
		const content = document.createElement('div');
		content.className = 'tool-activity-content';
		for (const call of message.toolCalls) {
			const row = document.createElement('div');
			row.className = 'tool-row';
			const name = document.createElement('strong');
			name.textContent = call.tool;
			const output = document.createElement('span');
			output.textContent = String(call.output).slice(0, 280);
			row.append(name, output);
			content.appendChild(row);
		}
		activity.append(summary, content);
		wrap.appendChild(activity);
	}
	messagesEl.appendChild(wrap);
	if (wasNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
	return wrap;
}

function renderMessages(messages) {
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
	for (const message of messages) addMessageElement(message);
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
		row.className = `session-row${session.failed ? ' failed' : ''}${session.id === currentSessionId ? ' active' : ''}`;
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
		meta.textContent = session.failed ? 'Failed' : session.id === currentSessionId ? 'Current chat' : 'Conversation';
		copy.append(title, meta);
		const age = document.createElement('span');
		age.className = 'session-age';
		age.textContent = relativeTime(session.updatedAt);
		row.append(dot, copy, age);
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

function sendPrompt() {
	const text = inputEl.value.trim();
	if (!text || busy) return;
	inputEl.value = '';
	updateComposer();
	showSessions(false);
	setBusy(true);
	post({ type: 'send', text, agentId: currentAgentId });
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
sendBtn.addEventListener('click', sendPrompt);
stopBtn.addEventListener('click', () => post({ type: 'stop' }));
inputEl.addEventListener('input', updateComposer);
inputEl.addEventListener('keydown', event => {
	if (event.key === 'Enter' && !event.shiftKey) {
		event.preventDefault();
		sendPrompt();
	}
});
document.getElementById('wuchat-new').addEventListener('click', () => {
	showSessions(false);
	post({ type: 'newChat' });
	inputEl.focus();
});
historyBtn.addEventListener('click', () => showSessions(!showingSessions));
document.getElementById('wuchat-settings').addEventListener('click', () => post({ type: 'openSettings' }));
document.getElementById('wuchat-browser').addEventListener('click', () => post({ type: 'openBrowser' }));
document.getElementById('wuchat-approval-mode').addEventListener('change', event => post({ type: 'setApprovalMode', effort: event.target.value }));
sessionSearch.addEventListener('input', renderSessions);
sessionList.addEventListener('click', event => {
	const row = event.target.closest('[data-session-id]');
	if (!row) return;
	showSessions(false);
	post({ type: 'openSession', sessionId: row.dataset.sessionId });
});
messagesEl.addEventListener('click', event => {
	const target = event.target;
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
			syncSelectors(message);
			sessions = message.sessions ?? [];
			currentSessionId = message.currentSessionId ?? '';
			renderSessions();
			document.getElementById('wuchat-workspace-label').textContent = message.workspaceName || 'No workspace';
			document.getElementById('wuchat-approval-mode').value = message.approvalMode || 'ask';
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
			if (message.transientError) addTransientError(message.transientError);
			break;
		}
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
			const pending = document.createElement('article');
			pending.className = 'msg msg-assistant';
			pending.id = 'wuchat-pending';
			pending.appendChild(makeMessageHeader({ role: 'assistant', agent: message.agent }));
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
				body.classList.remove('pending-indicator');
				body.dataset.raw = (body.dataset.raw ?? '') + (message.text ?? '');
				body.innerHTML = renderMarkdown(body.dataset.raw);
				messagesEl.scrollTop = messagesEl.scrollHeight;
			}
			break;
		}
		case 'assistantReasoning': {
			const pending = document.getElementById('wuchat-pending');
			if (pending) {
				let details = pending.querySelector('.msg-reasoning');
				if (!details) {
					details = document.createElement('details');
					details.className = 'msg-reasoning';
					const summary = document.createElement('summary');
					summary.textContent = 'Thinking';
					const body = document.createElement('div');
					body.className = 'reasoning-content';
					details.append(summary, body);
					pending.appendChild(details);
				}
				const body = details.querySelector('.reasoning-content');
				body.dataset.raw = (body.dataset.raw ?? '') + (message.text ?? '');
				body.innerHTML = renderMarkdown(body.dataset.raw);
			}
			break;
		}
		case 'toolCall': {
			const pending = document.getElementById('wuchat-pending');
			if (pending) {
				let status = [...pending.querySelectorAll('.msg-tool')].find(el => el.dataset.tool === message.tool);
				if (!status) {
					status = document.createElement('div');
					status.className = 'msg-tool';
					status.dataset.tool = message.tool;
					pending.appendChild(status);
				}
				status.dataset.status = message.status;
				status.textContent = `${message.status === 'started' ? 'Running' : message.status === 'retrying' ? 'Retrying' : message.status === 'finished' ? 'Completed' : 'Skipped'} · ${message.tool}`;
			}
			break;
		}
		case 'assistantDone':
			document.getElementById('wuchat-pending')?.remove();
			addMessageElement(message.message);
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
