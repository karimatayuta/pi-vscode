import { describe, expect, test } from "bun:test";
import {
	costKindForModel,
	modelCostIsKnown,
	toMessageDto,
	toMessageHistory,
	toModelDto,
	toStatsDto,
} from "../../src/extension/pi/dto.js";
import { mapPiSessionEvent } from "../../src/extension/pi/event-mapper.js";
import { safeErrorMessage, toSafeJson } from "../../src/extension/pi/sanitize.js";
import { validateAppSnapshot } from "../../src/shared/protocol.js";
import { DEFAULT_VIEW_DESIGN } from "../../src/shared/view-design.js";

describe("Pi DTO boundary", () => {
	test("omits image payloads and redacts credentials", () => {
		const message = toMessageDto({
			role: "assistant",
			content: [
				{ type: "image", mimeType: "image/png", data: "base64-secret" },
				{ type: "text", text: "Authorization: Bearer abcdefghijklmnop" },
			],
		});
		expect(message.content[0]).toEqual({ type: "image", mimeType: "image/png", omitted: true });
		expect(JSON.stringify(message)).not.toContain("base64-secret");
		expect(JSON.stringify(message)).toContain("Authorization: [redacted]");
		expect(
			toMessageDto({
				role: "toolResult",
				content: [{ type: "text", text: "API_TOKEN=raw-tool-secret" }],
			}).content,
		).toEqual([]);
	});

	test("distinguishes unavailable zero pricing and unknown context usage", () => {
		const zeroCostModel = {
			provider: "local",
			id: "model",
			name: "Model",
			reasoning: false,
			input: ["text"],
			contextWindow: 32_000,
			maxTokens: 4_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		expect(modelCostIsKnown(zeroCostModel)).toBe(false);
		expect(costKindForModel(zeroCostModel, true)).toBe("unknown");
		expect(
			costKindForModel({ ...zeroCostModel, cost: { ...zeroCostModel.cost, input: 0.001 } }, true),
		).toBe("subscription");
		expect(
			costKindForModel({ ...zeroCostModel, cost: { ...zeroCostModel.cost, output: 0.001 } }, false),
		).toBe("estimated");
		expect(toModelDto(zeroCostModel, ["off"])?.cost.known).toBe(false);
		expect(
			toStatsDto(
				{
					userMessages: 1,
					tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
					cost: 0,
					contextUsage: { tokens: null, contextWindow: 32_000, percent: null },
				},
				"unknown",
			).context,
		).toEqual({ tokens: null, contextWindow: 32_000, percent: null });
		expect(
			toStatsDto({ contextUsage: { tokens: 125, contextWindow: 100, percent: 125 } }, "estimated")
				.context,
		).toEqual({ tokens: 125, contextWindow: 100, percent: 100 });
	});

	test("bounds arbitrary tool data and removes secret-shaped properties", () => {
		const cyclic: Record<string, unknown> = { apiKey: "secret-value", data: "x".repeat(300) };
		cyclic.self = cyclic;
		expect(toSafeJson(cyclic)).toEqual({
			apiKey: "[redacted]",
			data: "[binary omitted]",
			self: "[circular]",
		});
	});

	test("redacts provider errors before they can cross into the Webview", () => {
		const message = safeErrorMessage(
			new Error(
				[
					"Request failed",
					"Authorization: Bearer abcdefghijklmnop",
					"Authorization: Basic dXNlcjpwYXNz",
					"x-api-key: abcdefghijklmnop",
					"password: hunter2",
					"token=raw-provider-token",
					"https://user:password@example.com/path",
				].join("\n"),
			),
		);
		expect(message).toContain("Authorization: [redacted]");
		expect(message).toContain("x-api-key: [redacted]");
		expect(message).toContain("password: [redacted]");
		expect(message).toContain("token=[redacted]");
		expect(message).toContain("https://[redacted]@example.com/path");
		expect(message).not.toContain("abcdefghijklmnop");
		expect(message).not.toContain("dXNlcjpwYXNz");
		expect(message).not.toContain("hunter2");
		expect(message).not.toContain("raw-provider-token");
		expect(message).not.toContain("user:password");
	});

	test("keeps the newest messages when the history reaches its size budget", () => {
		const older = { role: "user", content: "older ".repeat(100) };
		const middle = { role: "assistant", content: "middle" };
		const latest = { role: "assistant", content: "latest" };
		const expected = [toMessageDto(middle), toMessageDto(latest)];
		const budget = expected.reduce((total, message) => total + JSON.stringify(message).length, 0);

		expect(toMessageHistory([older, middle, latest], 256, budget)).toEqual(expected);
	});

	test("normalizes malformed provider numbers to the Webview protocol boundary", () => {
		const message = toMessageDto({
			role: "assistant",
			content: "Safe output",
			timestamp: -1.5,
			usage: {
				input: -2.5,
				output: 3.9,
				cacheRead: Number.POSITIVE_INFINITY,
				cacheWrite: Number.MAX_VALUE,
				totalTokens: Number.NaN,
				cost: { total: -4 },
			},
		});
		expect(message.timestamp).toBe(0);
		expect(message.usage).toEqual({
			input: 0,
			output: 3,
			cacheRead: 0,
			cacheWrite: Number.MAX_SAFE_INTEGER,
			total: Number.MAX_SAFE_INTEGER,
			cost: 0,
			costKnown: false,
		});

		const model = toModelDto({
			provider: "provider",
			id: "model",
			name: "Model",
			contextWindow: 1.9,
			maxTokens: -3,
			cost: { input: -1, output: 0.25, cacheRead: Number.NaN, cacheWrite: 0 },
		});
		expect(model).toMatchObject({
			contextWindow: 1,
			cost: { input: 0, output: 0.25, cacheRead: 0, cacheWrite: 0, known: true },
		});
		expect(model).not.toHaveProperty("maxTokens");

		const stats = toStatsDto(
			{
				userMessages: -1,
				assistantMessages: 2.9,
				toolCalls: Number.NaN,
				toolResults: Number.POSITIVE_INFINITY,
				totalMessages: Number.MAX_VALUE,
				tokens: {
					input: -1.5,
					output: 5.8,
					cacheRead: Number.NaN,
					cacheWrite: Number.MAX_VALUE,
					total: Number.POSITIVE_INFINITY,
				},
				cost: -2,
				contextUsage: { tokens: -3.2, contextWindow: 2.9, percent: 150.5 },
			},
			"estimated",
		);
		expect(stats).toMatchObject({
			userMessages: 0,
			assistantMessages: 2,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: Number.MAX_SAFE_INTEGER,
			tokens: {
				input: 0,
				output: 5,
				cacheRead: 0,
				cacheWrite: Number.MAX_SAFE_INTEGER,
				total: 0,
			},
			cost: 0,
			context: { tokens: 0, contextWindow: 2, percent: 100 },
		});

		expect(
			validateAppSnapshot({
				protocolVersion: 1,
				epoch: "epoch",
				workspace: "workspace",
				trusted: true,
				tabs: [
					{
						id: "chat",
						title: "Chat",
						phase: "idle",
						progress: "Ready",
						unread: false,
						manualTitle: false,
					},
				],
				activeChatId: "chat",
				messages: {
					chat: [
						{
							id: "message",
							role: "assistant",
							text: "Safe output",
							timestamp: message.timestamp,
						},
					],
				},
				context: [],
				approvalMode: "ask",
				usage: {
					contextTokens: stats.context?.tokens ?? null,
					contextWindow: stats.context?.contextWindow ?? null,
					contextPercent: stats.context?.percent ?? null,
					...stats.tokens,
					cost: stats.cost,
					costKind: stats.costKind,
				},
				model: { name: model?.name ?? "Model", thinking: "off", options: [], loading: false },
				commands: [],
				fileSuggestions: [],
				design: DEFAULT_VIEW_DESIGN,
				designScope: "global",
			}).ok,
		).toBe(true);
	});
});

describe("Pi event mapping", () => {
	test("treats agent_settled as the authoritative idle event", () => {
		expect(mapPiSessionEvent({ type: "agent_end", willRetry: false }).phase).toBeUndefined();
		const settled = mapPiSessionEvent({ type: "agent_settled" });
		expect(settled.phase).toBe("idle");
		expect(settled.statsRefresh).toEqual({ mode: "confirmed" });
	});

	test("maps cumulative streaming usage to preview and final refresh boundaries", () => {
		const rawUsage = {
			input: 100,
			output: 8,
			cacheRead: 20,
			cacheWrite: 0,
			totalTokens: 128,
			cost: { total: 0.012 },
		};
		const update = mapPiSessionEvent({
			type: "message_update",
			message: { role: "assistant", content: [], usage: rawUsage },
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		});
		expect(update.statsRefresh).toEqual({
			mode: "preview",
			usage: {
				input: 100,
				output: 8,
				cacheRead: 20,
				cacheWrite: 0,
				total: 128,
				cost: 0.012,
				costKnown: true,
			},
		});
		const end = mapPiSessionEvent({
			type: "message_end",
			message: { role: "assistant", content: [], usage: rawUsage },
		});
		expect(end.statsRefresh?.mode).toBe("confirmed");
		expect(mapPiSessionEvent({ type: "turn_end", turnIndex: 0 }).statsRefresh).toEqual({
			mode: "confirmed",
		});
	});

	test("does not append the final text block a second time at text_end", () => {
		const updates = [
			mapPiSessionEvent({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
				assistantMessageEvent: { type: "text_delta", delta: "hello" },
			}),
			mapPiSessionEvent({
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
				assistantMessageEvent: { type: "text_end", content: "hello" },
			}),
		];
		const deltas = updates
			.flatMap(({ events }) => events)
			.filter((event) => event.type === "message.update")
			.map((event) => event.delta);
		const displayed = deltas.reduce(
			(text, delta) => (delta.kind === "text" ? text + (delta.text ?? "") : text),
			"",
		);

		expect(deltas).toEqual([
			{ kind: "text", text: "hello" },
			{ kind: "status", text: "text_end" },
		]);
		expect(displayed).toBe("hello");
	});

	test("marks absent streamed cost data as unknown", () => {
		expect(
			toMessageDto({
				role: "assistant",
				content: [],
				usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
			}).usage,
		).toMatchObject({ cost: 0, costKnown: false });
	});

	test("sanitizes tool events and ignores raw transcript events", () => {
		const mapped = mapPiSessionEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: { authorization: "Bearer abcdefghijklmnop", command: "pwd" },
		});
		expect(mapped.events[0]).toMatchObject({
			type: "tool.start",
			tool: { toolCallId: "call-1", toolName: "bash" },
		});
		expect(JSON.stringify(mapped.events)).not.toContain("abcdefghijklmnop");
		expect(mapped.events[0]).toMatchObject({ tool: { args: { command: "pwd" } } });
		const write = mapPiSessionEvent({
			type: "tool_execution_start",
			toolCallId: "call-2",
			toolName: "write",
			args: { path: "file.ts", content: "API_TOKEN=raw-write-secret" },
		});
		expect(JSON.stringify(write.events)).not.toContain("raw-write-secret");
		const streamedArguments = mapPiSessionEvent({
			type: "message_update",
			message: { role: "assistant", content: [] },
			assistantMessageEvent: {
				type: "toolcall_delta",
				delta: "API_TOKEN=raw-stream-secret",
				toolCall: { id: "call-2", name: "write" },
			},
		});
		expect(JSON.stringify(streamedArguments.events)).not.toContain("raw-stream-secret");
		expect(mapPiSessionEvent({ type: "entry_appended", entry: { secret: "raw" } }).events).toEqual(
			[],
		);
	});
});
