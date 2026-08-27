import { describe, expect, test } from "bun:test";
import {
	MessageReferenceCache,
	refreshHistoryReferences,
	refreshMessageReferences,
} from "../../src/extension/links/message-reference-lifecycle.js";
import {
	DEFAULT_OPAQUE_REFERENCE_TTL_MS,
	OPAQUE_REFERENCE_REFRESH_INTERVAL_MS,
	OpaqueReferenceStore,
} from "../../src/extension/links/opaque-reference-store.js";
import { parseMessageReferences } from "../../src/extension/links/reference-parser.js";
import type { OpenTarget } from "../../src/extension/links/reference-registry.js";
import type { ChatMessage } from "../../src/shared/protocol.js";

function testStore(options: { ttlMs?: number; maxEntries?: number } = {}) {
	let now = 1_000;
	let sequence = 0;
	const store = new OpaqueReferenceStore<OpenTarget>({
		...options,
		now: () => now,
		createId: () => `opaque-${++sequence}`,
		equals: (left, right) => JSON.stringify(left) === JSON.stringify(right),
	});
	return {
		store,
		advance(milliseconds: number) {
			now += milliseconds;
		},
	};
}

function message(text = "Read src/auth.ts:4 and https://pi.dev/docs"): ChatMessage {
	return { id: "message-1", role: "assistant", text, timestamp: 1 };
}

function refresh(messageToRender: ChatMessage, store: OpaqueReferenceStore<OpenTarget>) {
	return refreshMessageReferences(messageToRender, store);
}

describe("message reference lifecycle", () => {
	test("uses a visible-view refresh cadence shorter than the default lease TTL", () => {
		expect(OPAQUE_REFERENCE_REFRESH_INTERVAL_MS).toBeLessThan(DEFAULT_OPAQUE_REFERENCE_TTL_MS);
	});

	test("keeps active leases stable and renews them when a snapshot is rendered", () => {
		const { store, advance } = testStore({ ttlMs: 100 });
		const first = refresh(message(), store);
		const firstReferences = first.references ?? [];
		advance(75);
		const renewed = refresh(first, store);
		expect(renewed).toBe(first);
		advance(75);
		for (const reference of firstReferences) {
			expect(store.resolve(reference.refId, reference.epoch)).toBeDefined();
		}
	});

	test("parses immutable history once while continuing to renew its leases", () => {
		const { store } = testStore();
		let parseCalls = 0;
		const cache = new MessageReferenceCache((markdown) => {
			parseCalls += 1;
			return parseMessageReferences(markdown);
		});
		const first = refreshMessageReferences(message(), store, cache);
		const second = refreshMessageReferences(first, store, cache);
		expect(second).toBe(first);
		expect(parseCalls).toBe(1);

		refreshMessageReferences({ ...second, text: `${second.text} and src/new.ts` }, store, cache);
		expect(parseCalls).toBe(2);
	});

	test("budgets history leases newest-first without ID churn or self-eviction", () => {
		const { store } = testStore({ maxEntries: 8 });
		const cache = new MessageReferenceCache();
		const history = [
			message("src/old-a.ts src/old-b.ts src/old-c.ts"),
			{ ...message("src/mid-a.ts src/mid-b.ts src/mid-c.ts"), id: "message-2" },
			{ ...message("src/new-a.ts src/new-b.ts src/new-c.ts"), id: "message-3" },
		];
		const first = refreshHistoryReferences(history, store, cache, 4);
		expect(first[0]?.references).toBeUndefined();
		expect(first[1]?.references).toHaveLength(1);
		expect(first[2]?.references).toHaveLength(3);
		const firstIds = first.flatMap(
			(item) => item.references?.map((reference) => reference.refId) ?? [],
		);
		for (const item of first) {
			for (const reference of item.references ?? []) {
				expect(store.resolve(reference.refId, reference.epoch)).toBeDefined();
			}
		}
		const second = refreshHistoryReferences(first, store, cache, 4);
		expect(
			second.flatMap((item) => item.references?.map((reference) => reference.refId) ?? []),
		).toEqual(firstIds);
	});

	test("reissues expired leases without changing the rendered message", () => {
		const { store, advance } = testStore({ ttlMs: 100 });
		const first = refresh(message(), store);
		advance(101);
		const second = refresh(first, store);
		expect(second.text).toBe(first.text);
		expect(second.id).toBe(first.id);
		expect(second.references?.map((reference) => reference.refId)).not.toEqual(
			first.references?.map((reference) => reference.refId),
		);
		for (const reference of first.references ?? []) {
			expect(store.resolve(reference.refId, reference.epoch)).toBeUndefined();
		}
	});

	test.each(["Webview recreation", "workspace-folder change"])(
		"reissues current-epoch leases after %s invalidates the registry",
		(_reason) => {
			const { store } = testStore();
			const first = refresh(message(), store);
			const oldEpoch = store.epoch;
			store.invalidate();
			const second = refresh(first, store);
			expect(store.epoch).not.toBe(oldEpoch);
			expect(second.text).toBe(first.text);
			expect(second.references?.every((reference) => reference.epoch === store.epoch)).toBe(true);
			for (const reference of first.references ?? []) {
				expect(store.resolve(reference.refId, reference.epoch)).toBeUndefined();
			}
		},
	);

	test("reissues a lease removed by capacity pressure", () => {
		const { store } = testStore({ maxEntries: 2 });
		const first = refresh(message("Read src/auth.ts:4"), store);
		const stale = first.references?.[0];
		expect(stale).toBeDefined();
		store.issue({ kind: "external", href: "https://one.example" });
		store.issue({ kind: "external", href: "https://two.example" });
		expect(store.resolve(stale?.refId ?? "", stale?.epoch ?? "")).toBeUndefined();

		const second = refresh(first, store);
		const current = second.references?.[0];
		expect(current?.refId).not.toBe(stale?.refId);
		expect(store.resolve(current?.refId ?? "", current?.epoch ?? "")).toEqual({
			kind: "workspace",
			relativePath: "src/auth.ts",
			line: 4,
		});
	});

	test("never rebinds a valid opaque lease to a different target", () => {
		const { store } = testStore();
		const safeTarget: OpenTarget = { kind: "workspace", relativePath: "src/safe.ts" };
		const otherTarget: OpenTarget = { kind: "external", href: "https://example.com" };
		const safeLease = store.issue(safeTarget);
		const otherLease = store.issue(otherTarget, safeLease);
		expect(otherLease.refId).not.toBe(safeLease.refId);
		expect(store.resolve(safeLease.refId, safeLease.epoch)).toEqual(safeTarget);
		expect(store.resolve(otherLease.refId, otherLease.epoch)).toEqual(otherTarget);
		expect(store.resolve(otherLease.refId, "wrong-epoch")).toBeUndefined();
	});

	test("issues no clickable lease for slash-separated tool prose", () => {
		const { store } = testStore();
		const rendered = refresh(
			message("edit/write前後の内容から確認し、find/ls の結果を整理します。"),
			store,
		);

		expect(rendered.references).toBeUndefined();
	});
});
