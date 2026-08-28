import { afterEach, describe, expect, test } from "bun:test";
import {
	activeMessagesSignal,
	activeTabSignal,
	clearOptimisticUserMessages,
	mergeSnapshot,
	snapshotSignal,
	stageOptimisticUserMessage,
} from "../../src/webview/store.js";
import { EMPTY_SNAPSHOT } from "../../src/webview/types.js";

const tabs = [
	{
		id: "chat-a",
		title: "A",
		phase: "idle" as const,
		progress: "Ready",
		unread: false,
		manualTitle: false,
	},
	{
		id: "chat-b",
		title: "B",
		phase: "running" as const,
		progress: "Working",
		unread: true,
		manualTitle: false,
	},
];

afterEach(() => {
	clearOptimisticUserMessages();
	snapshotSignal.value = EMPTY_SNAPSHOT;
});

describe("active chat snapshot projection", () => {
	test("shows a submitted user request immediately and reconciles the host copy by ID", () => {
		mergeSnapshot({
			...EMPTY_SNAPSHOT,
			tabs,
			activeChatId: "chat-a",
			messages: { "chat-a": [] },
		});
		stageOptimisticUserMessage("chat-a", {
			id: "wv-request-1",
			role: "user",
			text: "Review this change",
			timestamp: 1,
			contexts: [],
		});
		expect(activeMessagesSignal.value).toEqual([
			{
				id: "wv-request-1",
				role: "user",
				text: "Review this change",
				timestamp: 1,
				contexts: [],
			},
		]);

		// An unrelated, older snapshot must not make the local request disappear.
		mergeSnapshot({
			...EMPTY_SNAPSHOT,
			tabs,
			activeChatId: "chat-a",
			messages: { "chat-a": [] },
		});
		expect(activeMessagesSignal.value.map((message) => message.id)).toEqual(["wv-request-1"]);

		mergeSnapshot({
			...EMPTY_SNAPSHOT,
			tabs,
			activeChatId: "chat-a",
			messages: {
				"chat-a": [
					{
						id: "wv-request-1",
						role: "user",
						text: "Review this change",
						timestamp: 2,
						contexts: [],
					},
				],
			},
		});
		expect(activeMessagesSignal.value.map((message) => message.id)).toEqual(["wv-request-1"]);
		expect(activeMessagesSignal.value[0]?.timestamp).toBe(2);
	});

	test("replaces the visible history when a newly selected tab snapshot arrives", () => {
		mergeSnapshot({
			...EMPTY_SNAPSHOT,
			tabs,
			activeChatId: "chat-a",
			messages: {
				"chat-a": [{ id: "a-1", role: "assistant", text: "First", timestamp: 1 }],
			},
		});
		expect(activeTabSignal.value?.id).toBe("chat-a");
		expect(activeMessagesSignal.value.map((message) => message.id)).toEqual(["a-1"]);

		mergeSnapshot({
			...EMPTY_SNAPSHOT,
			tabs,
			activeChatId: "chat-b",
			messages: {
				"chat-b": [{ id: "b-1", role: "assistant", text: "Second", timestamp: 2 }],
			},
		});
		expect(activeTabSignal.value?.id).toBe("chat-b");
		expect(activeMessagesSignal.value.map((message) => message.id)).toEqual(["b-1"]);
		expect(snapshotSignal.value.messages["chat-a"]).toBeUndefined();
	});
});
