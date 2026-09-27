/*---------------------------------------------------------------------------------------------
 *  Wuchat — standalone AI chat extension for VS Code.
 *  Provider registry: the UI and agents resolve providers exclusively through
 *  this registry, never against a concrete vendor SDK.
 *--------------------------------------------------------------------------------------------*/

import { LLMProvider, ModelInfo } from '../common/types';

export class ProviderRegistry {
	private readonly providers = new Map<string, LLMProvider>();

	register(provider: LLMProvider): void {
		this.providers.set(provider.id, provider);
	}

	unregister(providerId: string): void {
		this.providers.delete(providerId);
	}

	get(providerId: string): LLMProvider | undefined {
		return this.providers.get(providerId);
	}

	getRequired(providerId: string): LLMProvider {
		const p = this.providers.get(providerId);
		if (!p) {
			throw new Error(`Wuchat: unknown LLM provider "${providerId}".`);
		}
		return p;
	}

	list(): LLMProvider[] {
		return [...this.providers.values()];
	}

	async listModels(providerId: string): Promise<ModelInfo[]> {
		const provider = this.providers.get(providerId);
		if (!provider?.models) {
			return [];
		}
		return provider.models();
	}
}
