import { redactString } from "./sanitize.js";
import type {
	PiMessageContentDto,
	PiMessageDto,
	PiModelDto,
	PiModelRefDto,
	PiSessionStatsDto,
	PiThinkingLevel,
	PiUsageDto,
} from "./types.js";

interface UnknownRecord {
	readonly [key: string]: unknown;
}

const STOP_REASONS = new Set([
	"pending",
	"stop",
	"length",
	"toolUse",
	"error",
	"aborted",
	"deferred",
]);
const ROLES = new Set(["user", "assistant", "toolResult", "custom", "bashExecution"]);

function record(value: unknown): UnknownRecord | undefined {
	return typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined;
}

function boundedNonNegativeInteger(value: unknown, fallback = 0): number {
	const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	if (!Number.isFinite(candidate)) return 0;
	return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(candidate)));
}

function positiveInteger(value: unknown): number | undefined {
	const normalized = boundedNonNegativeInteger(value);
	return normalized > 0 ? normalized : undefined;
}

function nonNegativeFinite(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function percentage(value: unknown): number {
	return Math.min(100, nonNegativeFinite(value));
}

function limitedText(value: unknown, maxLength = 64 * 1024): { text: string; truncated?: true } {
	const source = typeof value === "string" ? value : "";
	const text = redactString(source, maxLength);
	return text.length === source.length ? { text } : { text, truncated: true };
}

function usageDto(value: unknown): PiUsageDto | undefined {
	const usage = record(value);
	if (!usage) {
		return undefined;
	}
	const cost = record(usage.cost);
	const input = boundedNonNegativeInteger(usage.input);
	const output = boundedNonNegativeInteger(usage.output);
	const cacheRead = boundedNonNegativeInteger(usage.cacheRead);
	const cacheWrite = boundedNonNegativeInteger(usage.cacheWrite);
	const componentTotal = boundedNonNegativeInteger(input + output + cacheRead + cacheWrite);
	const explicitTotal = boundedNonNegativeInteger(usage.totalTokens, componentTotal);
	const rawCost = cost?.total;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: explicitTotal > 0 ? explicitTotal : componentTotal,
		cost: nonNegativeFinite(rawCost),
		costKnown: typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0,
	};
}

function contentDto(value: unknown): PiMessageContentDto {
	const part = record(value);
	if (!part || typeof part.type !== "string") {
		return { type: "unknown" };
	}
	if (part.type === "text") {
		return { type: "text", ...limitedText(part.text) };
	}
	if (part.type === "thinking") {
		return { type: "thinking", ...limitedText(part.thinking ?? part.text) };
	}
	if (part.type === "image") {
		return {
			type: "image",
			...(typeof part.mimeType === "string" ? { mimeType: redactString(part.mimeType, 128) } : {}),
			omitted: true,
		};
	}
	if (part.type === "toolCall") {
		return {
			type: "toolCall",
			...(typeof part.id === "string" ? { id: redactString(part.id, 256) } : {}),
			name: typeof part.name === "string" ? redactString(part.name, 256) : "unknown",
		};
	}
	return { type: "unknown" };
}

export function toMessageDto(value: unknown): PiMessageDto {
	const message = record(value) ?? {};
	const role =
		typeof message.role === "string" && ROLES.has(message.role) ? message.role : "unknown";
	let rawContent: readonly unknown[];
	if (role === "toolResult") {
		rawContent = [];
	} else if (Array.isArray(message.content)) {
		rawContent = message.content;
	} else if (typeof message.content === "string") {
		rawContent = [{ type: "text", text: message.content }];
	} else if (role === "bashExecution") {
		rawContent = [
			{ type: "text", text: `$ ${typeof message.command === "string" ? message.command : ""}` },
		];
	} else {
		rawContent = [];
	}
	const stopReason =
		typeof message.stopReason === "string" && STOP_REASONS.has(message.stopReason)
			? (message.stopReason as PiMessageDto["stopReason"])
			: undefined;
	const usage = usageDto(message.usage);
	const timestamp =
		typeof message.timestamp === "number"
			? boundedNonNegativeInteger(message.timestamp)
			: undefined;
	return {
		role: role as PiMessageDto["role"],
		...(timestamp === undefined ? {} : { timestamp }),
		content: rawContent.slice(0, 256).map(contentDto),
		...(stopReason === undefined ? {} : { stopReason }),
		...(usage === undefined ? {} : { usage }),
		...(typeof message.toolCallId === "string"
			? { toolCallId: redactString(message.toolCallId, 256) }
			: {}),
		...(typeof message.toolName === "string"
			? { toolName: redactString(message.toolName, 256) }
			: {}),
		...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
		...(typeof message.errorMessage === "string"
			? { errorMessage: redactString(message.errorMessage, 8_192) }
			: {}),
	};
}

export function toMessageHistory(
	values: readonly unknown[],
	maxMessages = 256,
	maxJsonCharacters = 2_000_000,
): PiMessageDto[] {
	const selected = values.slice(-maxMessages);
	const output: PiMessageDto[] = [];
	let remaining = maxJsonCharacters;
	for (let index = selected.length - 1; index >= 0; index -= 1) {
		const message = toMessageDto(selected[index]);
		const size = JSON.stringify(message).length;
		if (size > remaining) {
			break;
		}
		output.push(message);
		remaining -= size;
	}
	return output.reverse();
}

export function modelCostIsKnown(model: unknown): boolean {
	const cost = record(record(model)?.cost);
	return [cost?.input, cost?.output, cost?.cacheRead, cost?.cacheWrite].some(
		(value) => typeof value === "number" && Number.isFinite(value) && value > 0,
	);
}

export function costKindForModel(
	model: unknown,
	usesSubscription: boolean,
): PiSessionStatsDto["costKind"] {
	if (!modelCostIsKnown(model)) return "unknown";
	return usesSubscription ? "subscription" : "estimated";
}

export function toModelRefDto(model: unknown): PiModelRefDto | undefined {
	const value = record(model);
	if (!value || typeof value.provider !== "string" || typeof value.id !== "string") {
		return undefined;
	}
	return {
		provider: redactString(value.provider, 256),
		id: redactString(value.id, 512),
		name:
			typeof value.name === "string" ? redactString(value.name, 512) : redactString(value.id, 512),
	};
}

export function toModelDto(
	model: unknown,
	thinkingLevels: readonly PiThinkingLevel[] = [],
): PiModelDto | undefined {
	const value = record(model);
	const ref = toModelRefDto(model);
	if (!value || !ref) {
		return undefined;
	}
	const cost = record(value.cost);
	const contextWindow = positiveInteger(value.contextWindow);
	const maxTokens = positiveInteger(value.maxTokens);
	const input = Array.isArray(value.input)
		? value.input
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => redactString(entry, 64))
		: [];
	return {
		...ref,
		reasoning: value.reasoning === true,
		input,
		...(contextWindow === undefined ? {} : { contextWindow }),
		...(maxTokens === undefined ? {} : { maxTokens }),
		thinkingLevels: [...thinkingLevels],
		cost: {
			input: nonNegativeFinite(cost?.input),
			output: nonNegativeFinite(cost?.output),
			cacheRead: nonNegativeFinite(cost?.cacheRead),
			cacheWrite: nonNegativeFinite(cost?.cacheWrite),
			known: modelCostIsKnown(model),
		},
	};
}

export function toStatsDto(
	value: unknown,
	costKind: PiSessionStatsDto["costKind"],
): PiSessionStatsDto {
	const stats = record(value) ?? {};
	const tokens = record(stats.tokens) ?? {};
	const context = record(stats.contextUsage);
	const contextWindow = positiveInteger(context?.contextWindow);
	return {
		userMessages: boundedNonNegativeInteger(stats.userMessages),
		assistantMessages: boundedNonNegativeInteger(stats.assistantMessages),
		toolCalls: boundedNonNegativeInteger(stats.toolCalls),
		toolResults: boundedNonNegativeInteger(stats.toolResults),
		totalMessages: boundedNonNegativeInteger(stats.totalMessages),
		tokens: {
			input: boundedNonNegativeInteger(tokens.input),
			output: boundedNonNegativeInteger(tokens.output),
			cacheRead: boundedNonNegativeInteger(tokens.cacheRead),
			cacheWrite: boundedNonNegativeInteger(tokens.cacheWrite),
			total: boundedNonNegativeInteger(tokens.total),
		},
		cost: nonNegativeFinite(stats.cost),
		costKind,
		...(contextWindow
			? {
					context: {
						tokens: context?.tokens === null ? null : boundedNonNegativeInteger(context?.tokens),
						contextWindow,
						percent: context?.percent === null ? null : percentage(context?.percent),
					},
				}
			: {}),
	};
}
