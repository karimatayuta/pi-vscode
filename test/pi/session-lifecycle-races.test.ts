import { describe, expect, test } from "bun:test";
import { CloseAwareOperationQueue } from "../../src/extension/pi/close-aware-operation-queue.js";
import { PendingOperations } from "../../src/extension/pi/pending-operations.js";

describe("Pi session lifecycle coordination", () => {
	test("disposal waits for an already-started open operation", async () => {
		const pending = new PendingOperations();
		let finishOpen: (() => void) | undefined;
		const opening = pending.track(
			new Promise<void>((resolve) => {
				finishOpen = resolve;
			}),
		);
		let disposed = false;
		const disposing = pending.settle().then(() => {
			disposed = true;
		});

		await Promise.resolve();
		expect(disposed).toBe(false);
		finishOpen?.();
		await opening;
		await disposing;
		expect(disposed).toBe(true);
	});

	test("settles rejected opens without failing owner disposal", async () => {
		const pending = new PendingOperations();
		const opening = pending.track(Promise.reject(new Error("open failed")));
		await expect(opening).rejects.toThrow("open failed");
		await expect(pending.settle()).resolves.toBeUndefined();
	});

	test("close waits for running work and rejects work queued behind it", async () => {
		const queue = new CloseAwareOperationQueue(() => new Error("session closing"));
		let finishFirst: (() => void) | undefined;
		const first = queue.run(
			() =>
				new Promise<void>((resolve) => {
					finishFirst = resolve;
				}),
		);
		await Promise.resolve();
		let secondRan = false;
		const second = queue.run(async () => {
			secondRan = true;
		});
		const closing = queue.beginClose();

		expect(() => queue.run(async () => undefined)).toThrow("session closing");
		finishFirst?.();
		await first;
		await expect(second).rejects.toThrow("session closing");
		await closing;
		expect(secondRan).toBe(false);
	});
});
