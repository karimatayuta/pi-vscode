const PROVIDER_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_STORED_PROVIDERS = 64;

export function sanitizeStoredProviderIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const output: string[] = [];
	const seen = new Set<string>();
	for (const candidate of value) {
		if (typeof candidate !== "string" || !PROVIDER_ID.test(candidate) || seen.has(candidate)) {
			continue;
		}
		seen.add(candidate);
		output.push(candidate);
		if (output.length >= MAX_STORED_PROVIDERS) break;
	}
	return output;
}

export interface ProviderCredentialRuntime {
	set(provider: string, apiKey: string): PromiseLike<void>;
	remove(provider: string): PromiseLike<void>;
}

export interface ProviderCredentialPersistence {
	getSecret(provider: string): PromiseLike<string | undefined>;
	storeSecret(provider: string, apiKey: string): PromiseLike<void>;
	deleteSecret(provider: string): PromiseLike<void>;
	getProviders(): unknown;
	setProviders(providers: readonly string[]): PromiseLike<void>;
}

async function restoreCredential(
	provider: string,
	apiKey: string | undefined,
	runtime: ProviderCredentialRuntime,
	persistence: ProviderCredentialPersistence,
): Promise<void> {
	if (apiKey === undefined) {
		await Promise.allSettled([persistence.deleteSecret(provider), runtime.remove(provider)]);
		return;
	}
	await Promise.allSettled([
		persistence.storeSecret(provider, apiKey),
		runtime.set(provider, apiKey),
	]);
}

/** Applies a runtime credential first and rolls it back if durable persistence fails. */
export async function updateProviderCredential(
	provider: string,
	apiKey: string,
	runtime: ProviderCredentialRuntime,
	persistence: ProviderCredentialPersistence,
): Promise<void> {
	const previousSecret = await persistence.getSecret(provider);
	const previousProviders = sanitizeStoredProviderIds(persistence.getProviders());
	await runtime.set(provider, apiKey);
	try {
		await persistence.storeSecret(provider, apiKey);
		const nextProviders = previousProviders.filter((candidate) => candidate !== provider);
		nextProviders.push(provider);
		await persistence.setProviders(nextProviders.slice(-MAX_STORED_PROVIDERS));
	} catch (error) {
		await Promise.allSettled([
			restoreCredential(provider, previousSecret, runtime, persistence),
			persistence.setProviders(previousProviders),
		]);
		throw error;
	}
}
