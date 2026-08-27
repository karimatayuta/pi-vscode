import { describe, expect, test } from "bun:test";
import { commitChatTitle } from "../../src/extension/views/chat-title-transaction.js";

describe("chat title transaction", () => {
	test("commits local title state after the session accepts it", async () => {
		const state = { title: "Before", manualTitle: false };
		const controller = {
			setTitle: async (title: string) => {
				expect(title).toBe("After");
			},
		};

		await commitChatTitle(state, { title: "After", manualTitle: true }, (title) =>
			controller.setTitle(title),
		);

		expect(state).toEqual({ title: "After", manualTitle: true });
	});

	test("leaves local state unchanged when the session rejects the title", async () => {
		const state = { title: "Before", manualTitle: true };
		const controller = {
			setTitle: async (_title: string) => {
				throw new Error("session write failed");
			},
		};

		await expect(
			commitChatTitle(state, { title: "Uncommitted", manualTitle: false }, (title) =>
				controller.setTitle(title),
			),
		).rejects.toThrow("session write failed");
		expect(state).toEqual({ title: "Before", manualTitle: true });
	});
});
