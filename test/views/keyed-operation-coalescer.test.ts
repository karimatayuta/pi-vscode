import { describe, expect, test } from "bun:test";
import { KeyedOperationCoalescer } from "../../src/extension/views/keyed-operation-coalescer.js";

function deferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

describe("KeyedOperationCoalescer", () => {
	test("shares one in-flight close transaction and permits a later retry", async () => {
		const coalescer = new KeyedOperationCoalescer<string, void>();
		const firstRun = deferred();
		let calls = 0;
		const task = async () => {
			calls += 1;
			await firstRun.promise;
		};

		const first = coalescer.run("chat", task);
		const duplicate = coalescer.run("chat", task);
		expect(duplicate).toBe(first);
		await Promise.resolve();
		expect(calls).toBe(1);

		firstRun.resolve();
		await first;
		await coalescer.run("chat", async () => {
			calls += 1;
		});
		expect(calls).toBe(2);
	});

	test("shares a rejection and releases the key afterwards", async () => {
		const coalescer = new KeyedOperationCoalescer<string, void>();
		const first = coalescer.run("chat", async () => {
			throw new Error("close failed");
		});
		const duplicate = coalescer.run("chat", async () => undefined);
		expect(duplicate).toBe(first);
		await expect(first).rejects.toThrow("close failed");
		await expect(coalescer.run("chat", async () => undefined)).resolves.toBeUndefined();
	});
});
