import type {
	ChatMessage,
	ContextChip,
	ProposedEdit,
	ReferenceDescriptor,
	ToolItem,
} from "../../shared/protocol.js";

export const MAX_RETAINED_MESSAGES = 256;
export const MAX_RETAINED_HISTORY_BYTES = 4 * 1024 * 1024;
export const MAX_TRACKED_TURN_TOOLS = 128;
export const MAX_THOUGHT_BYTES = 256 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_TOOL_ITEMS = 64;
const MAX_TOOL_DETAIL_BYTES = 2 * 1024;
const MAX_EDIT_ITEMS = 8;
const MAX_PATCH_BYTES = 32 * 1024;
const MAX_REFERENCES = 128;
const MAX_CONTEXTS = 64;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const TRUNCATED = "\n…[truncated]";

function utf8Bytes(value: string): number {
	return encoder.encode(value).byteLength;
}

export function truncateUtf8(value: string, maxBytes: number): string {
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= maxBytes) return value;
	const suffix = encoder.encode(TRUNCATED);
	let end = Math.max(0, maxBytes - suffix.byteLength);
	while (end > 0) {
		try {
			return `${decoder.decode(bytes.subarray(0, end))}${TRUNCATED}`;
		} catch {
			end -= 1;
		}
	}
	return "";
}

function boundedContexts(values: readonly ContextChip[] | undefined): ContextChip[] | undefined {
	if (!values) return undefined;
	return values.slice(-MAX_CONTEXTS).map((value) => ({
		id: truncateUtf8(value.id, 256),
		label: truncateUtf8(value.label, 512),
		kind: value.kind,
	}));
}

export function boundToolItem(item: ToolItem): ToolItem {
	return {
		id: truncateUtf8(item.id, 256),
		label: truncateUtf8(item.label, 512),
		...(item.detail === undefined
			? {}
			: { detail: truncateUtf8(item.detail, MAX_TOOL_DETAIL_BYTES) }),
		phase: item.phase,
	};
}

function boundedTools(values: readonly ToolItem[] | undefined): ToolItem[] | undefined {
	if (!values) return undefined;
	return values.slice(-MAX_TOOL_ITEMS).map(boundToolItem);
}

function boundedEdits(values: readonly ProposedEdit[] | undefined): ProposedEdit[] | undefined {
	if (!values) return undefined;
	return values.slice(-MAX_EDIT_ITEMS).map((value) => ({
		...value,
		id: truncateUtf8(value.id, 256),
		path: truncateUtf8(value.path, 8_192),
		patch: truncateUtf8(value.patch, MAX_PATCH_BYTES),
	}));
}

function boundedReferences(
	values: readonly ReferenceDescriptor[] | undefined,
): ReferenceDescriptor[] | undefined {
	if (!values) return undefined;
	return values.slice(-MAX_REFERENCES).map((value) => ({
		...value,
		refId: truncateUtf8(value.refId, 256),
		epoch: truncateUtf8(value.epoch, 256),
		label: truncateUtf8(value.label, 512),
		ariaLabel: truncateUtf8(value.ariaLabel, 512),
	}));
}

function byteSize(message: ChatMessage): number {
	return utf8Bytes(JSON.stringify(message));
}

function omitEmptyThought(message: ChatMessage, thought: string | undefined): ChatMessage {
	const { thought: _ignored, ...rest } = message;
	return thought && thought.length > 0 ? { ...rest, thought } : rest;
}

export function boundChatMessage(message: ChatMessage): ChatMessage {
	const thought =
		message.thought && message.thought.length > 0
			? truncateUtf8(message.thought, MAX_THOUGHT_BYTES)
			: undefined;
	let bounded = omitEmptyThought(
		{
			...message,
			id: truncateUtf8(message.id, 256),
			text: truncateUtf8(message.text, MAX_TEXT_BYTES),
			...(message.contexts === undefined ? {} : { contexts: boundedContexts(message.contexts) }),
			...(message.tools === undefined ? {} : { tools: boundedTools(message.tools) }),
			...(message.edits === undefined ? {} : { edits: boundedEdits(message.edits) }),
			...(message.references === undefined
				? {}
				: { references: boundedReferences(message.references) }),
		},
		thought,
	);
	let size = byteSize(bounded);
	if (size > MAX_MESSAGE_BYTES && bounded.thought) {
		const overflow = size - MAX_MESSAGE_BYTES;
		const thoughtBudget = Math.max(0, utf8Bytes(bounded.thought) - overflow);
		bounded = omitEmptyThought(
			bounded,
			thoughtBudget > 0 ? truncateUtf8(bounded.thought, thoughtBudget) : "",
		);
		size = byteSize(bounded);
	}
	if (size <= MAX_MESSAGE_BYTES) return bounded;
	const textBudget = Math.max(0, utf8Bytes(bounded.text) - (size - MAX_MESSAGE_BYTES) - 1_024);
	return { ...bounded, text: truncateUtf8(bounded.text, textBudget) };
}

/** Keeps the current user turn plus the newest history within strict count/byte budgets. */
export function boundChatHistory(
	messages: readonly ChatMessage[],
	currentAssistantId?: string,
): ChatMessage[] {
	const bounded = messages.map(boundChatMessage);
	const selected = new Set<number>();
	let retainedBytes = 0;
	const add = (index: number): void => {
		if (index < 0 || selected.has(index) || selected.size >= MAX_RETAINED_MESSAGES) return;
		const message = bounded[index];
		if (!message) return;
		const bytes = byteSize(message);
		if (retainedBytes + bytes > MAX_RETAINED_HISTORY_BYTES) return;
		selected.add(index);
		retainedBytes += bytes;
	};

	let latestUser = -1;
	for (let index = bounded.length - 1; index >= 0; index -= 1) {
		if (bounded[index]?.role === "user") {
			latestUser = index;
			break;
		}
	}
	add(latestUser);
	for (let index = bounded.length - 1; index >= 0; index -= 1) {
		const message = bounded[index];
		if (
			message &&
			(message.id === currentAssistantId ||
				message.streaming === true ||
				message.tools?.some((tool) => tool.phase === "running"))
		) {
			add(index);
		}
	}
	for (let index = bounded.length - 1; index >= 0; index -= 1) add(index);
	return [...selected]
		.sort((left, right) => left - right)
		.map((index) => bounded[index])
		.filter((message): message is ChatMessage => message !== undefined);
}
