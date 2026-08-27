import { describe, expect, test } from "bun:test";
import type { PiHostEvent, PiSessionSnapshotDto } from "../../src/extension/pi/types.js";
import { turnToolTransitionForEvent } from "../../src/extension/views/turn-tool-lifecycle.js";
import {
	attachLiveTurnTool,
	hideLatestTurnTools,
	restoreLatestTurnTools,
	settleLatestTurnTools,
	TurnToolTracker,
} from "../../src/extension/views/turn-tools.js";
import type { ChatMessage, ToolItem } from "../../src/shared/protocol.js";

const priorTurn: ChatMessage[] = [
	{ id: "u-1", role: "user", text: "Earlier", timestamp: 1 },
	{
		id: "a-1",
		role: "assistant",
		text: "Earlier answer",
		timestamp: 2,
		tools: [{ id: "old", label: "read", phase: "success" }],
	},
];

function sessionSnapshot(busy: boolean): PiSessionSnapshotDto {
	return {
		id: "session",
		generation: 1,
		cwd: "workspace",
		piSessionId: "pi-session",
		persistent: true,
		phase: busy ? "running" : "idle",
		busy,
		thinkingLevel: "off",
		availableThinkingLevels: ["off"],
		pendingMessages: 0,
		activeTools: [],
		stats: {
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			costKind: "unknown",
		},
	};
}

type PiHostEventDraft = PiHostEvent extends infer Event
	? Event extends PiHostEvent
		? Omit<Event, "sessionId" | "generation">
		: never
	: never;

function event(value: PiHostEventDraft): PiHostEvent {
	return { ...value, sessionId: "session", generation: 1 } as PiHostEvent;
}

describe("turn tool consolidation", () => {
	test("defines restore and settlement ordering for every relevant Pi event", () => {
		expect(
			turnToolTransitionForEvent(
				event({ type: "session.snapshot", snapshot: sessionSnapshot(true) }),
				"idle",
			),
		).toEqual({ restore: true });
		expect(
			turnToolTransitionForEvent(
				event({ type: "session.snapshot", snapshot: sessionSnapshot(false) }),
				"running",
			),
		).toEqual({ restore: false, settle: "recoverable" });
		expect(
			turnToolTransitionForEvent(
				event({ type: "session.state", phase: "idle", busy: false }),
				"running",
			),
		).toEqual({ restore: false, settle: "recoverable" });
		expect(
			turnToolTransitionForEvent(
				event({
					type: "session.error",
					error: { scope: "agent", code: "retry", message: "Retry", recoverable: true },
				}),
				"running",
			),
		).toEqual({ restore: false, settle: "recoverable" });
		expect(turnToolTransitionForEvent(event({ type: "session.closed" }), "running")).toEqual({
			restore: false,
			settle: "final",
		});
		expect(
			turnToolTransitionForEvent(event({ type: "lifecycle", name: "agent.settled" }), "running"),
		).toEqual({ restore: false, settle: "final" });
		expect(
			turnToolTransitionForEvent(event({ type: "lifecycle", name: "retry.start" }), "error"),
		).toEqual({ restore: true });
		expect(
			turnToolTransitionForEvent(
				event({
					type: "tool.start",
					tool: { toolCallId: "read-1", toolName: "read" },
				}),
				"idle",
			),
		).toEqual({ restore: true });
	});

	test("keeps item and owner state consistent through recoverable and final settlements", () => {
		const tracker = new TurnToolTracker();
		const messages: ChatMessage[] = [
			{ id: "u", role: "user", text: "Inspect", timestamp: 1 },
			{ id: "round", role: "assistant", text: "", timestamp: 2 },
		];
		const live = tracker.attach(messages, { id: "read", label: "read", phase: "running" });
		expect(live[1]?.tools?.[0]?.phase).toBe("running");

		const recoverable = tracker.settle(
			[...live, { id: "final", role: "assistant", text: "Done", timestamp: 3 }],
			"recoverable",
		);
		expect(recoverable[1]?.id).toBe("round");
		expect(recoverable[2]?.tools?.[0]?.phase).toBe("cancelled");
		const resumed = tracker.restore(recoverable);
		expect(resumed[1]?.tools?.[0]?.phase).toBe("running");

		const updated = tracker.attach(resumed, {
			id: "read",
			label: "read",
			detail: "src/a.ts",
			phase: "success",
		});
		const final = tracker.settle(updated, "final");
		expect(final.at(-1)?.tools).toEqual([
			{ id: "read", label: "read", detail: "src/a.ts", phase: "success" },
		]);
		expect(tracker.get("read")).toBeUndefined();
	});

	test("attaches live tools to their current round and updates ids without reordering", () => {
		const firstRound = attachLiveTurnTool(
			[
				...priorTurn,
				{ id: "u-2", role: "user", text: "Current", timestamp: 3 },
				{ id: "round-1", role: "assistant", text: "First round", timestamp: 4 },
			],
			{ id: "read-1", label: "read", phase: "running" },
		);
		expect(firstRound.ownerId).toBe("round-1");
		expect(firstRound.messages[3]?.tools?.[0]?.phase).toBe("running");

		const updated = attachLiveTurnTool(
			firstRound.messages,
			{ id: "read-1", label: "read", detail: "src/a.ts", phase: "success" },
			firstRound.ownerId,
		);
		expect(updated.messages[1]?.tools).toEqual(priorTurn[1]?.tools);
		expect(updated.messages[3]?.tools).toEqual([
			{ id: "read-1", label: "read", detail: "src/a.ts", phase: "success" },
		]);
	});

	test("keeps multiple rounds visible while running then collapses them onto the final response", () => {
		const base: ChatMessage[] = [
			{ id: "u", role: "user", text: "Inspect and fix", timestamp: 1 },
			{ id: "round-1", role: "assistant", text: "Inspecting", timestamp: 2 },
		];
		const read = { id: "read", label: "read", detail: "src/a.ts", phase: "success" } as const;
		const firstRound = attachLiveTurnTool(base, read);
		const withSecondRound: ChatMessage[] = [
			...firstRound.messages,
			{ id: "round-2", role: "assistant", text: "Verifying", timestamp: 3 },
		];
		const testTool = {
			id: "test",
			label: "bash",
			detail: "bun test",
			phase: "success",
		} as const;
		const secondRound = attachLiveTurnTool(withSecondRound, testTool);
		expect(firstRound.messages[1]?.tools?.map((tool) => tool.id)).toEqual(["read"]);
		expect(secondRound.messages[2]?.tools?.map((tool) => tool.id)).toEqual(["test"]);

		const withFinal: ChatMessage[] = [
			...secondRound.messages,
			{ id: "final", role: "assistant", text: "Done", timestamp: 4 },
		];
		const settled = settleLatestTurnTools(withFinal, [read, testTool]);
		expect(settled[1]?.tools).toBeUndefined();
		expect(settled[2]?.tools).toBeUndefined();
		expect(settled[3]?.tools?.map((tool) => tool.id)).toEqual(["read", "test"]);
	});

	test("removes empty tool-only Pi rows after their tools are consolidated", () => {
		const settled = settleLatestTurnTools(
			[
				{ id: "u", role: "user", text: "Inspect", timestamp: 1 },
				{
					id: "tool-only-1",
					role: "assistant",
					text: "",
					timestamp: 2,
					tools: [{ id: "read", label: "read", phase: "success" }],
				},
				{
					id: "meaningful",
					role: "assistant",
					text: "確認を続けます。",
					timestamp: 3,
					tools: [{ id: "ls", label: "ls", phase: "success" }],
				},
				{
					id: "tool-only-2",
					role: "assistant",
					text: "   ",
					timestamp: 4,
					tools: [{ id: "find", label: "find", phase: "success" }],
				},
				{ id: "final", role: "assistant", text: "完了しました。", timestamp: 5 },
			],
			[],
		);

		expect(settled.map((message) => message.id)).toEqual(["u", "meaningful", "final"]);
		expect(settled[1]?.text).toBe("確認を続けます。");
		expect(settled[1]?.tools).toBeUndefined();
		expect(settled[2]?.tools?.map((tool) => tool.id)).toEqual(["read", "ls", "find"]);
	});

	test("keeps tool round owners until a recoverable terminal state is definitively settled", () => {
		const messages: ChatMessage[] = [
			{ id: "u", role: "user", text: "Inspect", timestamp: 1 },
			{
				id: "round-1",
				role: "assistant",
				text: "",
				timestamp: 2,
				tools: [{ id: "read", label: "read", phase: "error" }],
			},
			{ id: "final", role: "assistant", text: "Retry is available.", timestamp: 3 },
		];
		const recoverable = settleLatestTurnTools(
			messages,
			[{ id: "read", label: "read", phase: "error" }],
			false,
		);
		expect(recoverable.map((message) => message.id)).toEqual(["u", "round-1", "final"]);

		const restored = restoreLatestTurnTools(
			recoverable,
			[{ id: "read", label: "read", phase: "running" }],
			new Map([["read", "round-1"]]),
		);
		expect(restored[1]?.tools?.[0]?.phase).toBe("running");
		expect(restored[2]?.tools).toBeUndefined();
	});

	test("retains every meaningful intermediate assistant content kind", () => {
		const settled = settleLatestTurnTools(
			[
				{ id: "u", role: "user", text: "Inspect", timestamp: 1 },
				{
					id: "context",
					role: "assistant",
					text: "",
					timestamp: 2,
					contexts: [{ id: "context-1", label: "src", kind: "folder" }],
				},
				{
					id: "edit",
					role: "assistant",
					text: "",
					timestamp: 3,
					edits: [
						{
							id: "edit-1",
							path: "src/a.ts",
							patch: "+export {};",
							additions: 1,
							deletions: 0,
							status: "applied",
						},
					],
				},
				{
					id: "reference",
					role: "assistant",
					text: "",
					timestamp: 4,
					references: [
						{
							refId: "ref-1",
							epoch: "epoch-1",
							label: "README.md",
							kind: "file",
							ariaLabel: "Open README.md",
						},
					],
				},
				{
					id: "retry",
					role: "assistant",
					text: "",
					timestamp: 5,
					retryable: true,
				},
				{ id: "final", role: "assistant", text: "Done", timestamp: 6 },
			],
			[],
		);
		expect(settled.map((message) => message.id)).toEqual([
			"u",
			"context",
			"edit",
			"reference",
			"retry",
			"final",
		]);
	});

	test("deduplicates one user turn onto only its final assistant in first-seen order", () => {
		const messages: ChatMessage[] = [
			...priorTurn,
			{ id: "u-2", role: "user", text: "Current", timestamp: 3 },
			{
				id: "a-2",
				role: "assistant",
				text: "Checking",
				timestamp: 4,
				tools: [{ id: "read-1", label: "read", detail: "src/a.ts", phase: "running" }],
			},
			{
				id: "a-3",
				role: "assistant",
				text: "Final answer",
				timestamp: 5,
				streaming: true,
				tools: [{ id: "ls-1", label: "ls", detail: "src", phase: "success" }],
			},
		];
		const pending: ToolItem[] = [
			{ id: "read-1", label: "read", detail: "src/a.ts", phase: "success" },
			{ id: "find-1", label: "find", detail: "src/**/*.ts", phase: "success" },
		];

		const settled = settleLatestTurnTools(messages, pending);

		expect(settled[1]?.tools).toEqual(priorTurn[1]?.tools);
		expect(settled[3]?.tools).toBeUndefined();
		expect(settled[4]?.streaming).toBeUndefined();
		expect(settled[4]?.tools).toEqual([
			{ id: "read-1", label: "read", detail: "src/a.ts", phase: "success" },
			{ id: "ls-1", label: "ls", detail: "src", phase: "success" },
			{ id: "find-1", label: "find", detail: "src/**/*.ts", phase: "success" },
		]);
	});

	test("marks an unfinished tool cancelled at terminal settlement", () => {
		const settled = settleLatestTurnTools(
			[
				{ id: "u", role: "user", text: "Stop", timestamp: 1 },
				{ id: "a", role: "assistant", text: "Partial", timestamp: 2, streaming: true },
			],
			[{ id: "bash", label: "bash", detail: "bun test", phase: "running" }],
		);
		expect(settled[1]?.tools?.[0]?.phase).toBe("cancelled");
		expect(settled[1]?.streaming).toBeUndefined();
	});

	test("hides only the latest turn's transient tools when work resumes", () => {
		const hidden = hideLatestTurnTools([
			...priorTurn,
			{ id: "u-2", role: "user", text: "Current", timestamp: 3 },
			{
				id: "a-2",
				role: "assistant",
				text: "Retrying",
				timestamp: 4,
				tools: [{ id: "new", label: "find", phase: "error" }],
			},
		]);
		expect(hidden[1]?.tools).toEqual(priorTurn[1]?.tools);
		expect(hidden[3]?.tools).toBeUndefined();
	});

	test("restores live tools to their round owners after a recoverable terminal state", () => {
		const messages: ChatMessage[] = [
			...priorTurn,
			{ id: "u-2", role: "user", text: "Current", timestamp: 3 },
			{ id: "round-1", role: "assistant", text: "First round", timestamp: 4 },
			{
				id: "round-2",
				role: "assistant",
				text: "Second round",
				timestamp: 5,
				tools: [{ id: "legacy-aggregate", label: "read", phase: "success" }],
			},
		];
		const restored = restoreLatestTurnTools(
			messages,
			[
				{ id: "read-1", label: "read", detail: "src/a.ts", phase: "success" },
				{ id: "find-1", label: "find", detail: "src", phase: "running" },
			],
			new Map([
				["read-1", "round-1"],
				["find-1", "round-2"],
			]),
		);

		expect(restored[1]?.tools).toEqual(priorTurn[1]?.tools);
		expect(restored[3]?.tools?.map((tool) => tool.id)).toEqual(["read-1"]);
		expect(restored[4]?.tools?.map((tool) => tool.id)).toEqual(["find-1"]);
	});
});
