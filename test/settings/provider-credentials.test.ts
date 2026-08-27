import { describe, expect, test } from "bun:test";
import {
	sanitizeStoredProviderIds,
	updateProviderCredential,
} from "../../src/extension/settings/provider-credentials.js";

describe("provider credential persistence", () => {
	test("bounds and validates restored provider IDs", () => {
		const input = [
			"openai",
			"openai",
			"bad provider",
			42,
			...Array.from({ length: 80 }, (_, index) => `p${index}`),
		];
		const sanitized = sanitizeStoredProviderIds(input);
		expect(sanitized[0]).toBe("openai");
		expect(sanitized).toHaveLength(64);
		expect(sanitized).not.toContain("bad provider");
		expect(sanitizeStoredProviderIds("openai")).toEqual([]);
	});

	test("does not persist a credential rejected by the runtime", async () => {
		const calls: string[] = [];
		await expect(
			updateProviderCredential(
				"openai",
				"new",
				{
					set: async () => {
						calls.push("runtime:set");
						throw new Error("rejected");
					},
					remove: async () => undefined,
				},
				{
					getSecret: async () => "old",
					storeSecret: async () => void calls.push("secret:store"),
					deleteSecret: async () => void calls.push("secret:delete"),
					getProviders: () => ["openai"],
					setProviders: async () => void calls.push("providers:set"),
				},
			),
		).rejects.toThrow("rejected");
		expect(calls).toEqual(["runtime:set"]);
	});

	test("restores runtime and durable state after a persistence failure", async () => {
		const calls: string[] = [];
		let providerWrites = 0;
		await expect(
			updateProviderCredential(
				"openai",
				"new",
				{
					set: async (_provider, apiKey) => void calls.push(`runtime:${apiKey}`),
					remove: async () => void calls.push("runtime:remove"),
				},
				{
					getSecret: async () => "old",
					storeSecret: async (_provider, apiKey) => void calls.push(`secret:${apiKey}`),
					deleteSecret: async () => void calls.push("secret:delete"),
					getProviders: () => ["anthropic", "openai"],
					setProviders: async (providers) => {
						calls.push(`providers:${providers.join(",")}`);
						providerWrites += 1;
						if (providerWrites === 1) throw new Error("storage failed");
					},
				},
			),
		).rejects.toThrow("storage failed");
		expect(calls).toContain("runtime:old");
		expect(calls).toContain("secret:old");
		expect(calls.at(-1)).toBe("providers:anthropic,openai");
	});
});
