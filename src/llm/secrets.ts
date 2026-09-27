/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  Credential handling. API keys live exclusively in VS Code SecretStorage,
 *  never in settings.json or files.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const KEY_PREFIX = 'wuchat.apiKey.';

export class SecretManager {
	constructor(private readonly secrets: vscode.SecretStorage) { }

	async setApiKey(providerId: string, value: string): Promise<void> {
		await this.secrets.store(KEY_PREFIX + providerId, value);
	}

	async getApiKey(providerId: string): Promise<string | undefined> {
		return this.secrets.get(KEY_PREFIX + providerId);
	}

	async deleteApiKey(providerId: string): Promise<void> {
		await this.secrets.delete(KEY_PREFIX + providerId);
	}
}

/** Prompts for and stores the API key of the given provider. */
export async function configureApiKey(secretManager: SecretManager, providerId: string): Promise<void> {
	const current = await secretManager.getApiKey(providerId);
	const value = await vscode.window.showInputBox({
		title: `Wuchat: API key for "${providerId}"`,
		prompt: current
			? 'A key is already stored. Enter a new key to replace it, or press Escape to keep it.'
			: 'The key is stored in VS Code SecretStorage and never written to settings or files.',
		password: true,
		ignoreFocusOut: true
	});
	if (value === undefined) {
		return;
	}
	if (value === '') {
		await secretManager.deleteApiKey(providerId);
		vscode.window.showInformationMessage(`Wuchat: API key for "${providerId}" removed.`);
		return;
	}
	await secretManager.setApiKey(providerId, value);
	vscode.window.showInformationMessage(`Wuchat: API key for "${providerId}" saved securely.`);
}
