import { describe, expect, test } from "bun:test";
import { ActivationScope } from "../../src/extension/activation-scope.js";

describe("ActivationScope", () => {
	test("disposes every partial resource in reverse order even when one rejects", async () => {
		const scope = new ActivationScope();
		const calls: string[] = [];
		const errors: unknown[] = [];
		scope.add({ dispose: () => void calls.push("first") });
		scope.add({
			dispose: async () => {
				calls.push("second");
				throw new Error("cleanup failed");
			},
		});
		scope.add({ dispose: () => void calls.push("third") });
		await scope.dispose((error) => errors.push(error));
		expect(calls).toEqual(["third", "second", "first"]);
		expect(errors).toHaveLength(1);
	});

	test("transfers successful activation resources without disposing them", async () => {
		const scope = new ActivationScope();
		const resources: Array<{ dispose(): void }> = [];
		let disposed = false;
		scope.add({
			dispose: () => {
				disposed = true;
			},
		});
		scope.commit(resources);
		await scope.dispose();
		expect(disposed).toBe(false);
		expect(resources).toHaveLength(1);
	});
});
