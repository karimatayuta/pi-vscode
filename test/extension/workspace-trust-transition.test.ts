import { describe, expect, test } from "bun:test";
import {
	WorkspaceTrustReloadCoordinator,
	WorkspaceTrustState,
} from "../../src/extension/workspace-trust-transition.js";

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

describe("WorkspaceTrustState", () => {
	test("never elevates a live Extension Host after trust changes", () => {
		const state = new WorkspaceTrustState(true);
		expect(state.trusted).toBe(true);
		expect(state.reloadRequired).toBe(false);

		expect(state.requireReload()).toBe(true);
		expect(state.trusted).toBe(false);
		expect(state.reloadRequired).toBe(true);
		expect(state.requireReload()).toBe(false);
	});

	test("keeps an initially restricted host restricted", () => {
		const state = new WorkspaceTrustState(false);
		expect(state.trusted).toBe(false);
		expect(state.requireReload()).toBe(true);
		expect(state.trusted).toBe(false);
	});
});

describe("WorkspaceTrustReloadCoordinator", () => {
	test("latches restricted state synchronously and coalesces duplicate grants", async () => {
		const reload = deferred();
		const calls: string[] = [];
		const coordinator = new WorkspaceTrustReloadCoordinator({
			enterReloadRequired: () => calls.push("restricted"),
			announceReload: () => {
				calls.push("notice");
				return Promise.resolve();
			},
			reloadWindow: () => {
				calls.push("reload");
				return reload.promise;
			},
			reportAnnouncementFailure: () => calls.push("notice-error"),
			handleReloadFailure: () => calls.push("reload-error"),
		});

		const first = coordinator.handleGrant();
		const duplicate = coordinator.handleGrant();
		expect(duplicate).toBe(first);
		expect(calls).toEqual(["restricted", "notice", "reload"]);

		reload.resolve();
		await first;
		expect(coordinator.handleGrant()).toBe(first);
		expect(calls).toEqual(["restricted", "notice", "reload"]);
	});

	test("does not wait for a passive notice before reloading", async () => {
		const notice = deferred();
		let reloads = 0;
		const coordinator = new WorkspaceTrustReloadCoordinator({
			enterReloadRequired: () => undefined,
			announceReload: () => notice.promise,
			reloadWindow: () => {
				reloads += 1;
				return Promise.resolve();
			},
			reportAnnouncementFailure: () => undefined,
			handleReloadFailure: () => undefined,
		});

		await coordinator.handleGrant();
		expect(reloads).toBe(1);
		notice.resolve();
	});

	test("handles a rejected reload once and keeps the transition consumed", async () => {
		const failure = new Error("reload rejected");
		const reloadFailures: unknown[] = [];
		let reloads = 0;
		const coordinator = new WorkspaceTrustReloadCoordinator({
			enterReloadRequired: () => undefined,
			announceReload: () => Promise.resolve(),
			reloadWindow: () => {
				reloads += 1;
				return Promise.reject(failure);
			},
			reportAnnouncementFailure: () => undefined,
			handleReloadFailure: (error) => reloadFailures.push(error),
		});

		const first = coordinator.handleGrant();
		await expect(first).resolves.toBeUndefined();
		await expect(coordinator.handleGrant()).resolves.toBeUndefined();
		expect(reloads).toBe(1);
		expect(reloadFailures).toEqual([failure]);
	});

	test("owns both synchronous and asynchronous notice failures", async () => {
		const failures: unknown[] = [];
		const syncFailure = new Error("sync notice failure");
		const asyncFailure = new Error("async notice failure");
		const actions = (notice: () => PromiseLike<unknown>) => ({
			enterReloadRequired: () => undefined,
			announceReload: notice,
			reloadWindow: () => Promise.resolve(),
			reportAnnouncementFailure: (error: unknown) => failures.push(error),
			handleReloadFailure: () => undefined,
		});

		await new WorkspaceTrustReloadCoordinator(
			actions(() => {
				throw syncFailure;
			}),
		).handleGrant();
		await new WorkspaceTrustReloadCoordinator(
			actions(() => Promise.reject(asyncFailure)),
		).handleGrant();
		await Promise.resolve();

		expect(failures).toEqual([syncFailure, asyncFailure]);
	});
});
