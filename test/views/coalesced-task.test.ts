import { describe, expect, test } from "bun:test";
import { CoalescedTask } from "../../src/extension/views/coalesced-task.js";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

describe("CoalescedTask", () => {
	test("serializes a burst and retains only one trailing run", async () => {
		const firstRun = deferred();
		let calls = 0;
		let active = 0;
		let maximumActive = 0;
		const task = new CoalescedTask(async () => {
			calls += 1;
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			if (calls === 1) await firstRun.promise;
			active -= 1;
		});

		const completion = task.request();
		task.request();
		task.request();
		expect(calls).toBe(1);
		firstRun.resolve();
		await completion;

		expect(calls).toBe(2);
		expect(maximumActive).toBe(1);
	});

	test("takes a fresh state snapshot only after an older write completes", async () => {
		const firstWrite = deferred();
		const writes: number[] = [];
		let current = 1;
		const task = new CoalescedTask(async () => {
			writes.push(current);
			if (writes.length === 1) await firstWrite.promise;
		});

		const completion = task.request();
		current = 2;
		task.request();
		expect(writes).toEqual([1]);

		firstWrite.resolve();
		await completion;
		expect(writes).toEqual([1, 2]);
	});

	test("retains an immutable trailing value when its mutable owner is disposed", async () => {
		const firstWrite = deferred();
		const writes: Array<readonly string[]> = [];
		let pending: readonly string[] = [];
		const task = new CoalescedTask(async () => {
			const value = pending;
			writes.push(value);
			if (writes.length === 1) await firstWrite.promise;
		});
		const request = (records: readonly string[]): Promise<void> => {
			pending = [...records];
			return task.request();
		};

		const completion = request(["older"]);
		request(["latest-before-dispose"]);
		const mutableRecords: string[] = ["latest-before-dispose"];
		request(mutableRecords);
		mutableRecords.length = 0;
		firstWrite.resolve();
		await completion;

		expect(writes).toEqual([["older"], ["latest-before-dispose"]]);
	});

	test("reports a failure and accepts a later request", async () => {
		const failures: unknown[] = [];
		let calls = 0;
		const task = new CoalescedTask(
			async () => {
				calls += 1;
				if (calls === 1) throw new Error("first run failed");
			},
			(error) => failures.push(error),
		);

		await task.request();
		await task.request();
		expect(calls).toBe(2);
		expect(failures).toHaveLength(1);
	});

	test("contains an error thrown by its failure reporter", async () => {
		const task = new CoalescedTask(
			async () => {
				throw new Error("task failed");
			},
			() => {
				throw new Error("reporter failed");
			},
		);

		await expect(task.request()).resolves.toBeUndefined();
	});

	test("does not start a queued run after disposal", async () => {
		const firstRun = deferred();
		let calls = 0;
		const task = new CoalescedTask(async () => {
			calls += 1;
			await firstRun.promise;
		});

		const completion = task.request();
		task.request();
		task.dispose();
		firstRun.resolve();
		await completion;

		expect(calls).toBe(1);
		await task.request();
		expect(calls).toBe(1);
	});
});
