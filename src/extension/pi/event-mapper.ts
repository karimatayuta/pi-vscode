import { toMessageDto } from "./dto.js";
import { redactString } from "./sanitize.js";
import type {
	PiHostEvent,
	PiJsonValue,
	PiSessionPhase,
	PiThinkingLevel,
	PiToolEventDto,
} from "./types.js";

type DistributedEventDraft<T> = T extends PiHostEvent ? Omit<T, "sessionId" | "generation"> : never;
export type PiHostEventDraft = DistributedEventDraft<PiHostEvent>;

export interface PiEventMapResult {
	readonly phase?: PiSessionPhase;
	readonly events: readonly PiHostEventDraft[];
	readonly refreshSnapshot?: boolean;
	readonly statsRefresh?: {
		readonly mode: "preview" | "confirmed";
		readonly usage?: NonNullable<ReturnType<typeof toMessageDto>["usage"]>;
	};
}

interface UnknownRecord {
	readonly [key: string]: unknown;
}

const THINKING_LEVELS = new Set<PiThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

function record(value: unknown): UnknownRecord | undefined {
	return typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined;
}

function stringValue(value: unknown, maxLength = 8_192): string | undefined {
	return typeof value === "string" ? redactString(value, maxLength) : undefined;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value
				.filter((entry): entry is string => typeof entry === "string")
				.slice(0, 128)
				.map((entry) => redactString(entry, 32 * 1024))
		: [];
}

function safeToolArguments(event: UnknownRecord): PiJsonValue | undefined {
	const args = record(event.args);
	const toolName = stringValue(event.toolName, 256);
	if (!args || !toolName) {
		return undefined;
	}
	const output: Record<string, PiJsonValue> = {};
	const copyString = (key: string, maxLength = 8_192): void => {
		const value = stringValue(args[key], maxLength);
		if (value !== undefined) {
			output[key] = value;
		}
	};
	if (["read", "edit", "write", "grep", "find", "ls"].includes(toolName)) {
		copyString("path");
	}
	if (toolName === "grep") {
		copyString("pattern");
		copyString("glob");
	}
	if (toolName === "find") {
		copyString("pattern");
	}
	if (toolName === "bash" || toolName === "powershell") {
		copyString("command", 32 * 1024);
	}
	return Object.keys(output).length > 0 ? output : undefined;
}

function toolDto(event: UnknownRecord, completed: boolean): PiToolEventDto {
	const args = safeToolArguments(event);
	const isError = typeof event.isError === "boolean" ? event.isError : undefined;
	return {
		toolCallId: stringValue(event.toolCallId, 256) ?? "unknown",
		toolName: stringValue(event.toolName, 256) ?? "unknown",
		...(args === undefined ? {} : { args }),
		...(completed ? { result: { status: isError ? "error" : "completed" } } : {}),
		...(isError === undefined ? {} : { isError }),
	};
}

function streamDelta(
	value: unknown,
): Extract<PiHostEventDraft, { type: "message.update" }>["delta"] {
	const event = record(value) ?? {};
	const type = stringValue(event.type, 64) ?? "update";
	if (type === "text_delta") {
		return { kind: "text", text: stringValue(event.delta, 64 * 1024) ?? "" };
	}
	if (type === "thinking_delta") {
		return { kind: "thinking", text: stringValue(event.delta, 64 * 1024) ?? "" };
	}
	if (type === "text_end" || type === "thinking_end") {
		return { kind: "status", text: type };
	}
	if (type.startsWith("toolcall_")) {
		const toolCall = record(event.toolCall);
		const toolCallId = stringValue(toolCall?.id, 256);
		const toolName = stringValue(toolCall?.name, 256);
		return {
			kind: "tool",
			...(toolCallId === undefined ? {} : { toolCallId }),
			...(toolName === undefined ? {} : { toolName }),
		};
	}
	return { kind: "status", text: type };
}

export function mapPiSessionEvent(value: unknown): PiEventMapResult {
	const event = record(value);
	if (!event || typeof event.type !== "string") {
		return { events: [] };
	}
	switch (event.type) {
		case "agent_start":
			return {
				phase: "running",
				events: [{ type: "lifecycle", name: "agent.start" }],
			};
		case "agent_end":
			return {
				...(event.willRetry === true ? { phase: "retrying" as const } : {}),
				events: [
					{
						type: "lifecycle",
						name: "agent.end",
						detail: { willRetry: event.willRetry === true },
					},
				],
			};
		case "agent_settled":
			return {
				phase: "idle",
				events: [{ type: "lifecycle", name: "agent.settled" }],
				refreshSnapshot: true,
				statsRefresh: { mode: "confirmed" },
			};
		case "turn_start":
			return {
				events: [
					{
						type: "lifecycle",
						name: "turn.start",
						detail: { turnIndex: typeof event.turnIndex === "number" ? event.turnIndex : 0 },
					},
				],
			};
		case "turn_end":
			return {
				events: [
					{
						type: "lifecycle",
						name: "turn.end",
						detail: { turnIndex: typeof event.turnIndex === "number" ? event.turnIndex : 0 },
					},
				],
				statsRefresh: { mode: "confirmed" },
			};
		case "message_start":
			return {
				events: [{ type: "message.start", message: toMessageDto(event.message) }],
			};
		case "message_update": {
			const message = toMessageDto(event.message);
			return {
				phase: "streaming",
				events: [
					{
						type: "message.update",
						message,
						delta: streamDelta(event.assistantMessageEvent),
					},
				],
				...(message.usage
					? { statsRefresh: { mode: "preview" as const, usage: message.usage } }
					: {}),
			};
		}
		case "message_end": {
			const message = toMessageDto(event.message);
			const events: PiHostEventDraft[] = [{ type: "message.end", message }];
			if (message.role === "assistant" && message.stopReason === "error") {
				events.push({
					type: "session.error",
					error: {
						scope: "agent",
						code: "assistant_error",
						message: message.errorMessage ?? "The model request failed.",
						recoverable: true,
					},
				});
			}
			return {
				events,
				statsRefresh: {
					mode: "confirmed",
					...(message.usage ? { usage: message.usage } : {}),
				},
			};
		}
		case "tool_execution_start":
			return {
				phase: "tool",
				events: [{ type: "tool.start", tool: toolDto(event, false) }],
			};
		case "tool_execution_update":
			return {
				phase: "tool",
				events: [{ type: "tool.update", tool: toolDto(event, false) }],
			};
		case "tool_execution_end": {
			const tool = toolDto(event, true);
			const events: PiHostEventDraft[] = [{ type: "tool.end", tool }];
			if (tool.isError) {
				events.push({
					type: "session.error",
					error: {
						scope: "tool",
						code: "tool_error",
						message: `Tool ${tool.toolName} failed.`,
						recoverable: true,
					},
				});
			}
			return { events };
		}
		case "queue_update":
			return {
				events: [
					{
						type: "session.queue",
						steering: stringList(event.steering),
						followUp: stringList(event.followUp),
					},
				],
				refreshSnapshot: true,
			};
		case "session_info_changed":
			return {
				events: [
					{
						type: "session.title",
						...(typeof event.name === "string" ? { title: redactString(event.name, 512) } : {}),
					},
				],
				refreshSnapshot: true,
			};
		case "thinking_level_changed": {
			const level =
				typeof event.level === "string" && THINKING_LEVELS.has(event.level as PiThinkingLevel)
					? (event.level as PiThinkingLevel)
					: "off";
			return {
				events: [{ type: "session.thinking", level }],
				refreshSnapshot: true,
			};
		}
		case "auto_retry_start":
			return {
				phase: "retrying",
				events: [
					{
						type: "lifecycle",
						name: "retry.start",
						detail: {
							attempt: typeof event.attempt === "number" ? event.attempt : 0,
							maxAttempts: typeof event.maxAttempts === "number" ? event.maxAttempts : 0,
							delayMs: typeof event.delayMs === "number" ? event.delayMs : 0,
						},
					},
				],
			};
		case "auto_retry_end": {
			const events: PiHostEventDraft[] = [
				{
					type: "lifecycle",
					name: "retry.end",
					detail: {
						success: event.success === true,
						attempt: typeof event.attempt === "number" ? event.attempt : 0,
					},
				},
			];
			if (event.success === false && typeof event.finalError === "string") {
				events.push({
					type: "session.error",
					error: {
						scope: "agent",
						code: "retry_exhausted",
						message: redactString(event.finalError, 8_192),
						recoverable: true,
					},
				});
			}
			return { events };
		}
		case "compaction_start":
			return {
				phase: "compacting",
				events: [
					{
						type: "lifecycle",
						name: "compaction.start",
						detail: { reason: stringValue(event.reason, 64) ?? "unknown" },
					},
				],
			};
		case "compaction_end": {
			const events: PiHostEventDraft[] = [
				{
					type: "lifecycle",
					name: "compaction.end",
					detail: {
						reason: stringValue(event.reason, 64) ?? "unknown",
						aborted: event.aborted === true,
						willRetry: event.willRetry === true,
					},
				},
			];
			if (typeof event.errorMessage === "string") {
				events.push({
					type: "session.error",
					error: {
						scope: "compaction",
						code: "compaction_failed",
						message: redactString(event.errorMessage, 8_192),
						recoverable: true,
					},
				});
			}
			return { ...(event.willRetry === true ? { phase: "retrying" as const } : {}), events };
		}
		default:
			// entry_appended and bash_execution_update intentionally remain inside the extension host.
			return { events: [] };
	}
}
