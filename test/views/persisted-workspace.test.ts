import { describe, expect, test } from "bun:test";
import { parsePersistedWorkspace } from "../../src/extension/views/persisted-workspace.js";

describe("persisted workspace parser", () => {
	test("fails closed and bounds malformed restored state", () => {
		const parsed = parsePersistedWorkspace(
			{
				version: 1,
				activeChatId: "chat-1",
				tabs: [
					{
						id: "chat-1",
						title: `API_KEY=top-secret ${"long ".repeat(100)}`,
						manualTitle: "yes",
						approvalMode: "fullAccess",
						sessionFile: "relative/session.jsonl",
						model: { provider: "bad provider", id: "model" },
						thinking: "unbounded",
					},
					{ id: "chat-1", title: "duplicate", approvalMode: "plan" },
					{ id: "invalid id", title: "invalid", approvalMode: "plan" },
				],
			},
			true,
		);
		expect(parsed?.tabs).toHaveLength(1);
		expect(parsed?.tabs[0]).toMatchObject({
			id: "chat-1",
			manualTitle: false,
			approvalMode: "ask",
		});
		expect(parsed?.tabs[0]?.title).not.toContain("top-secret");
		expect([...(parsed?.tabs[0]?.title ?? "")]).toHaveLength(80);
		expect(parsed?.tabs[0]?.sessionFile).toBeUndefined();
		expect(parsed?.tabs[0]?.model).toBeUndefined();
		expect(parsed?.tabs[0]?.thinking).toBeUndefined();
	});

	test("forces restored sessions into Plan in an untrusted workspace", () => {
		const parsed = parsePersistedWorkspace(
			{ version: 1, tabs: [{ id: "chat", title: "Title", approvalMode: "autoEdit" }] },
			false,
		);
		expect(parsed?.tabs[0]?.approvalMode).toBe("plan");
	});

	test("rejects invalid roots and caps tab work", () => {
		expect(parsePersistedWorkspace("corrupt", true)).toBeUndefined();
		const parsed = parsePersistedWorkspace(
			{
				version: 1,
				tabs: Array.from({ length: 100 }, (_, index) => ({
					id: `chat-${index}`,
					title: `Chat ${index}`,
					approvalMode: "ask",
				})),
			},
			true,
		);
		expect(parsed?.tabs).toHaveLength(20);
	});
});
