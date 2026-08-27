import { describe, expect, test } from "bun:test";
import {
	boundChatHistory,
	boundChatMessage,
	MAX_RETAINED_HISTORY_BYTES,
	MAX_RETAINED_MESSAGES,
	MAX_THOUGHT_BYTES,
	truncateUtf8,
} from "../../src/extension/views/bounded-chat-history.js";
import type { ChatMessage } from "../../src/shared/protocol.js";

function message(id: string, role: ChatMessage["role"], text: string): ChatMessage {
	return { id, role, text, timestamp: 1 };
}

describe("bounded chat history", () => {
	test("truncates without splitting a UTF-8 sequence", () => {
		const value = truncateUtf8("🙂".repeat(100), 31);
		expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(31);
		expect(value).not.toContain("�");
	});

	test("bounds streaming text and tool detail before protocol validation", () => {
		const bounded = boundChatMessage({
			...message("assistant", "assistant", "🙂".repeat(500_000)),
			streaming: true,
			tools: Array.from({ length: 1_000 }, (_, index) => ({
				id: `tool-${index}`,
				label: "read",
				detail: "x".repeat(100_000),
				phase: "running" as const,
			})),
		});
		expect(new TextEncoder().encode(bounded.text).byteLength).toBeLessThanOrEqual(512 * 1024);
		expect(bounded.tools).toHaveLength(64);
		expect(
			new TextEncoder().encode(bounded.tools?.[0]?.detail ?? "").byteLength,
		).toBeLessThanOrEqual(2 * 1024);
	});

	test("caps thought independently and truncates it before answer text", () => {
		const bounded = boundChatMessage({
			...message("assistant", "assistant", "answer"),
			thought: "t".repeat(400_000),
		});
		expect(new TextEncoder().encode(bounded.thought ?? "").byteLength).toBeLessThanOrEqual(
			MAX_THOUGHT_BYTES,
		);
		expect(bounded.text).toBe("answer");

		const overflowed = boundChatMessage({
			...message("assistant", "assistant", "a".repeat(500_000)),
			thought: "t".repeat(300_000),
			tools: Array.from({ length: 64 }, (_, index) => ({
				id: `tool-${index}`,
				label: "read",
				detail: "x".repeat(2_000),
				phase: "success" as const,
			})),
			edits: Array.from({ length: 8 }, (_, index) => ({
				id: `edit-${index}`,
				path: "src/file.ts",
				patch: "p".repeat(30_000),
				additions: 1,
				deletions: 1,
				status: "applied" as const,
			})),
		});
		expect(overflowed.text.startsWith("a")).toBe(true);
		expect(new TextEncoder().encode(overflowed.text).byteLength).toBeGreaterThan(100_000);
		expect(new TextEncoder().encode(JSON.stringify(overflowed)).byteLength).toBeLessThanOrEqual(
			1024 * 1024,
		);
	});

	test("keeps the current user and assistant while pruning old history", () => {
		const messages = Array.from({ length: 400 }, (_, index) =>
			message(`old-${index}`, "assistant", "x".repeat(20_000)),
		);
		messages.push(message("user", "user", "current request"));
		messages.push({ ...message("assistant", "assistant", "working"), streaming: true });
		const bounded = boundChatHistory(messages, "assistant");
		expect(bounded.some((item) => item.id === "user")).toBe(true);
		expect(bounded.some((item) => item.id === "assistant")).toBe(true);
		expect(bounded.length).toBeLessThanOrEqual(MAX_RETAINED_MESSAGES);
		expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(
			MAX_RETAINED_HISTORY_BYTES,
		);
	});
});
