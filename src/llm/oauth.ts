/*---------------------------------------------------------------------------------------------
 *  Wuchat — OAuth PKCE sign-in for Claude (claude.ai) and ChatGPT Codex.
 *  Ported from the claude-for-copilot logic so Wuchat needs no companion
 *  extension: tokens live in Wuchat's SecretStorage and refresh automatically.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { SecretManager } from './secrets';
import { fetchJson } from './sse';

export type OAuthVendor = 'claude' | 'codex';

export interface OAuthSession {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
	email?: string;
	accountId?: string;
	subscriptionType?: string;
}

const SESSION_KEY: Record<OAuthVendor, string> = {
	claude: 'wuchat.claudeOauth.v1',
	codex: 'wuchat.codexOauth.v1'
};

const CLAUDE = {
	clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
	authorizeUrl: 'https://claude.com/cai/oauth/authorize',
	tokenUrl: 'https://platform.claude.com/v1/oauth/token',
	profileUrl: 'https://api.anthropic.com/api/oauth/profile',
	scopes: ['org:create_api_key', 'user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'].join(' ')
};

const CODEX = {
	clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
	authorizeUrl: 'https://auth.openai.com/oauth/authorize',
	tokenUrl: 'https://auth.openai.com/oauth/token',
	redirectUri: 'http://localhost:1455/auth/callback',
	scopes: 'openid email profile offline_access',
	originator: 'openai-oauth-copilot-chat'
};

interface Pkce {
	verifier: string;
	challenge: string;
	state: string;
}

function base64url(input: Buffer): string {
	return input.toString('base64url');
}

function createPkce(): Pkce {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash('sha256').update(verifier).digest());
	return { verifier, challenge, state: base64url(randomBytes(16)) };
}

/** Accepts `CODE#STATE` (claude CLI style), `code=...&state=...` or a raw code. */
export function parseCallback(input: string, expectedState?: string): { code: string; state?: string } {
	const trimmed = input.trim();
	if (trimmed.includes('#')) {
		const [code, state] = trimmed.split('#', 2);
		return { code: code.trim(), state: state.trim() || undefined };
	}
	try {
		const url = new URL(trimmed);
		const code = url.searchParams.get('code');
		if (code) return { code, state: url.searchParams.get('state') ?? undefined };
	} catch { /* not a URL */ }
	if (trimmed.includes('code=')) {
		const params = new URLSearchParams(trimmed.slice(trimmed.indexOf('?') + 1));
		const code = params.get('code');
		if (code) return { code, state: params.get('state') ?? undefined };
	}
	return { code: trimmed, state: expectedState };
}

async function tokenRequest(vendor: OAuthVendor, body: Record<string, string>): Promise<Record<string, unknown>> {
	const isClaude = vendor === 'claude';
	const response = await fetchJson(isClaude ? CLAUDE.tokenUrl : CODEX.tokenUrl, {
		method: 'POST',
		headers: isClaude
			? { 'content-type': 'application/json' }
			: { 'content-type': 'application/x-www-form-urlencoded' },
		body: isClaude ? JSON.stringify(body) : new URLSearchParams(body).toString()
	}, 30_000);
	const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
	if (!response.ok) {
		throw new Error(`OAuth token request failed (${response.status}): ${payload.error_description ?? payload.error ?? response.statusText}`);
	}
	return payload;
}

async function persistSession(secretManager: SecretManager, vendor: OAuthVendor, session: OAuthSession): Promise<void> {
	await secretManager.setSecret(SESSION_KEY[vendor], JSON.stringify(session));
}

export async function readOAuthSession(secretManager: SecretManager, vendor: OAuthVendor): Promise<OAuthSession | undefined> {
	const raw = await secretManager.getSecret(SESSION_KEY[vendor]);
	if (!raw) return undefined;
	try { return JSON.parse(raw) as OAuthSession; } catch { return undefined; }
}

export async function clearOAuthSession(secretManager: SecretManager, vendor: OAuthVendor): Promise<void> {
	await secretManager.deleteSecret(SESSION_KEY[vendor]);
}

async function refreshSession(secretManager: SecretManager, vendor: OAuthVendor, session: OAuthSession): Promise<OAuthSession> {
	if (!session.refreshToken) throw new Error(`${vendor} session expired and has no refresh token. Sign in again.`);
	const payload = await tokenRequest(vendor, {
		grant_type: 'refresh_token',
		client_id: vendor === 'claude' ? CLAUDE.clientId : CODEX.clientId,
		refresh_token: session.refreshToken,
		...(vendor === 'claude' ? { scope: CLAUDE.scopes } : {})
	});
	const refreshed: OAuthSession = {
		accessToken: String(payload.access_token),
		refreshToken: (payload.refresh_token as string | undefined) ?? session.refreshToken,
		expiresAt: Date.now() + Number(payload.expires_in ?? 28_800) * 1_000,
		email: session.email,
		accountId: session.accountId,
		subscriptionType: session.subscriptionType
	};
	await persistSession(secretManager, vendor, refreshed);
	return refreshed;
}

/** Returns a valid access token, refreshing it when close to expiry (single-flight). */
const refreshing = new Map<OAuthVendor, Promise<OAuthSession>>();
export async function getAccessToken(secretManager: SecretManager, vendor: OAuthVendor, forceRefresh = false): Promise<string> {
	const session = await readOAuthSession(secretManager, vendor);
	if (!session) throw new Error(`${vendor === 'claude' ? 'Anthropic' : 'ChatGPT Codex'} is not connected. Run "Wuchat: Connect AI Provider" to sign in.`);
	const needsRefresh = forceRefresh || session.expiresAt <= Date.now() + 60_000;
	if (!needsRefresh) return session.accessToken;
	let pending = refreshing.get(vendor);
	if (!pending) {
		pending = refreshSession(secretManager, vendor, session);
		refreshing.set(vendor, pending);
		pending.finally(() => refreshing.delete(vendor)).catch(() => undefined);
	}
	return (await pending).accessToken;
}

/** Builds the authorization URL the user must open in a browser. */
export function createAuthorizationUrl(vendor: OAuthVendor): { url: string; pkce: Pkce } {
	const pkce = createPkce();
	if (vendor === 'claude') {
		const params = new URLSearchParams({
			code: 'true',
			client_id: CLAUDE.clientId,
			redirect_uri: 'https://platform.claude.com/oauth/code/callback',
			response_type: 'code',
			scope: CLAUDE.scopes,
			code_challenge: pkce.challenge,
			code_challenge_method: 'S256',
			state: pkce.state
		});
		return { url: `${CLAUDE.authorizeUrl}?${params}`, pkce };
	}
	const params = new URLSearchParams({
		client_id: CODEX.clientId,
		redirect_uri: CODEX.redirectUri,
		response_type: 'code',
		scope: CODEX.scopes,
		code_challenge: pkce.challenge,
		code_challenge_method: 'S256',
		state: pkce.state,
		prompt: 'login',
		id_token_add_organizations: 'true',
		codex_cli_simplified_flow: 'true',
		originator: CODEX.originator
	});
	return { url: `${CODEX.authorizeUrl}?${params}`, pkce };
}

function callbackPage(title: string, message: string): string {
	const escape = (value: string) => value.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character);
	return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><style>body{font:16px system-ui;max-width:42rem;margin:12vh auto;padding:2rem;line-height:1.5}</style><h1>${escape(title)}</h1><p>${escape(message)}</p>`;
}

export interface BrowserSignIn {
	url: string;
	completion: Promise<OAuthSession>;
	cancel(): void;
}

/**
 * Opens the browser and captures the redirect on a local server, so the user
 * does not have to paste anything (same flow as the Codex CLI).
 */
export function startBrowserSignIn(
	secretManager: SecretManager,
	vendor: OAuthVendor,
	openExternal: (url: string) => Promise<unknown>
): BrowserSignIn {
	if (vendor !== 'codex') throw new Error('Automatic callback capture is only available for Codex.');
	const flow = createAuthorizationUrl(vendor);
	let server: import('node:http').Server | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let settled = false;
	let rejectCompletion: (reason: Error) => void = () => undefined;
	const close = (): void => {
		if (timeout) clearTimeout(timeout);
		server?.close();
		server = undefined;
	};
	const completion = new Promise<OAuthSession>((resolve, reject) => {
		rejectCompletion = reject;
		server = createServer(async (request, response) => {
			const callback = new URL(request.url ?? '/', CODEX.redirectUri);
			if (callback.pathname !== '/auth/callback') {
				response.writeHead(404).end('Not found');
				return;
			}
			if (settled) {
				response.writeHead(409).end('This sign-in is already complete.');
				return;
			}
			try {
				const session = await completeSignIn(secretManager, vendor, callback.toString(), flow.pkce);
				settled = true;
				response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				response.end(callbackPage('Signed in to Wuchat', 'You can close this tab and return to Visual Studio Code.'));
				close();
				resolve(session);
			} catch (error) {
				settled = true;
				const message = error instanceof Error ? error.message : String(error);
				response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
				response.end(callbackPage('ChatGPT sign-in failed', message));
				close();
				reject(error);
			}
		});
		server.once('error', error => {
			settled = true;
			close();
			reject(new Error(`Unable to listen on ${CODEX.redirectUri}: ${error.message}. Paste the callback URL manually instead.`));
		});
		server.listen(1455, '127.0.0.1');
		timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			close();
			reject(new Error('OpenAI browser sign-in timed out'));
		}, 5 * 60_000);
		void openExternal(flow.url).catch(error => rejectCompletion(error instanceof Error ? error : new Error(String(error))));
	});
	return {
		url: flow.url,
		completion,
		cancel: () => {
			if (settled) return;
			settled = true;
			close();
			rejectCompletion(new Error('OpenAI sign-in cancelled'));
		}
	};
}

/** Exchanges an authorization code for tokens and stores the session. */
export async function completeSignIn(
	secretManager: SecretManager,
	vendor: OAuthVendor,
	callbackInput: string,
	pkce: Pkce
): Promise<OAuthSession> {
	const { code, state } = parseCallback(callbackInput, pkce.state);
	if (state && pkce.state && state !== pkce.state) throw new Error('OAuth state mismatch. Restart the sign-in.');
	const payload = await tokenRequest(vendor, {
		grant_type: 'authorization_code',
		client_id: vendor === 'claude' ? CLAUDE.clientId : CODEX.clientId,
		code,
		redirect_uri: vendor === 'claude' ? 'https://platform.claude.com/oauth/code/callback' : CODEX.redirectUri,
		code_verifier: pkce.verifier,
		...(vendor === 'claude' ? { state: pkce.state } : {})
	});
	const session: OAuthSession = {
		accessToken: String(payload.access_token),
		refreshToken: payload.refresh_token as string | undefined,
		expiresAt: Date.now() + Number(payload.expires_in ?? 28_800) * 1_000
	};
	if (vendor === 'codex') {
		session.accountId = decodeJwtAccountId(session.accessToken);
	} else {
		try {
			const profile = await fetchJson(CLAUDE.profileUrl, {
				headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/json' }
			}, 15_000);
			if (profile.ok) {
				const data = await profile.json() as { email?: string; account?: { uuid?: string; organization?: { uuid?: string } } };
				session.email = data.email;
				session.accountId = data.account?.uuid;
			}
		} catch { /* profile enrichment is optional */ }
	}
	await persistSession(secretManager, vendor, session);
	return session;
}

function decodeJwtAccountId(token: string): string | undefined {
	try {
		const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()) as {
			chatgpt_account_id?: string;
			organizations?: Array<{ id?: string }>;
			'https://api.openai.com/auth'?: { chatgpt_account_id?: string };
		};
		return claims.chatgpt_account_id
			?? claims['https://api.openai.com/auth']?.chatgpt_account_id
			?? claims.organizations?.[0]?.id;
	} catch {
		return undefined;
	}
}

/** Imports an existing claude CLI login (~/.claude/.credentials.json). */
export async function importClaudeCliSession(secretManager: SecretManager): Promise<boolean> {
	try {
		const raw = JSON.parse(await readFile(path.join(homedir(), '.claude', '.credentials.json'), 'utf8')) as {
			claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number; subscriptionType?: string };
		};
		const oauth = raw.claudeAiOauth;
		if (!oauth?.accessToken) return false;
		await persistSession(secretManager, 'claude', {
			accessToken: oauth.accessToken,
			refreshToken: oauth.refreshToken,
			expiresAt: oauth.expiresAt ?? Date.now() + 28_800_000,
			subscriptionType: oauth.subscriptionType
		});
		return true;
	} catch {
		return false;
	}
}

/** Imports an existing Codex CLI login (~/.codex/auth.json). */
export async function importCodexCliSession(secretManager: SecretManager): Promise<boolean> {
	try {
		const raw = JSON.parse(await readFile(path.join(homedir(), '.codex', 'auth.json'), 'utf8')) as {
			tokens?: { access_token?: string; refresh_token?: string; account_id?: string; id_token?: string };
			access_token?: string;
			refresh_token?: string;
			account_id?: string;
		};
		const tokens = raw.tokens ?? raw;
		if (!tokens.access_token) return false;
		const session: OAuthSession = {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresAt: Date.now() + 28_800_000,
			accountId: tokens.account_id ?? decodeJwtAccountId(tokens.access_token)
		};
		await persistSession(secretManager, 'codex', session);
		return true;
	} catch {
		return false;
	}
}

export function newRequestId(): string {
	return randomUUID();
}
