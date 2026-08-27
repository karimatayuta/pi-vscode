import type { ChatMessage, ToolItem } from "../../shared/protocol.js";
import { boundToolItem, MAX_TRACKED_TURN_TOOLS } from "./bounded-chat-history.js";

function latestUserIndex(messages: readonly ChatMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") return index;
	}
	return -1;
}

function withoutTools(message: ChatMessage): ChatMessage {
	if (message.tools === undefined) return message;
	const { tools: _tools, ...messageWithoutTools } = message;
	return messageWithoutTools;
}

function hasVisibleContent(message: ChatMessage): boolean {
	return (
		message.text.trim().length > 0 ||
		(message.contexts?.length ?? 0) > 0 ||
		(message.edits?.length ?? 0) > 0 ||
		(message.references?.length ?? 0) > 0 ||
		message.retryable === true
	);
}

export interface LiveToolAttachment {
	readonly messages: ChatMessage[];
	readonly ownerId?: string;
}

export type TurnToolSettlement = "recoverable" | "final";

/** Adds or updates one tool on its current assistant/tool round. */
export function attachLiveTurnTool(
	messages: ChatMessage[],
	item: ToolItem,
	preferredOwner?: string,
): LiveToolAttachment {
	const userIndex = latestUserIndex(messages);
	if (userIndex < 0) return { messages };
	let ownerIndex = preferredOwner
		? messages.findIndex(
				(message, index) =>
					index > userIndex && message.role === "assistant" && message.id === preferredOwner,
			)
		: -1;
	if (ownerIndex < 0) {
		for (let index = messages.length - 1; index > userIndex; index -= 1) {
			if (messages[index]?.role === "assistant") {
				ownerIndex = index;
				break;
			}
		}
	}
	const owner = messages[ownerIndex];
	if (owner?.role !== "assistant") return { messages };
	const tools = new Map((owner.tools ?? []).map((tool) => [tool.id, tool]));
	tools.set(item.id, item);
	return {
		messages: messages.map((message, index) =>
			index === ownerIndex ? { ...owner, tools: [...tools.values()] } : message,
		),
		ownerId: owner.id,
	};
}

/** Removes transient tool panels from the latest user turn while work resumes. */
export function hideLatestTurnTools(messages: ChatMessage[]): ChatMessage[] {
	const userIndex = latestUserIndex(messages);
	if (userIndex < 0) return messages;
	const hasTransientTools = messages.some(
		(message, index) =>
			index > userIndex && message.role === "assistant" && message.tools !== undefined,
	);
	if (!hasTransientTools) return messages;
	return messages.map((message, index) =>
		index > userIndex && message.role === "assistant" ? withoutTools(message) : message,
	);
}

/** Restores in-progress tools to the assistant message that initiated each tool round. */
export function restoreLatestTurnTools(
	messages: ChatMessage[],
	pendingTools: readonly ToolItem[],
	owners: ReadonlyMap<string, string>,
): ChatMessage[] {
	const userIndex = latestUserIndex(messages);
	if (userIndex < 0 || pendingTools.length === 0) return messages;
	const assistantIds = new Set<string>();
	let fallbackOwner: string | undefined;
	for (let index = userIndex + 1; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		assistantIds.add(message.id);
		fallbackOwner = message.id;
	}
	if (!fallbackOwner) return messages;

	const toolsByOwner = new Map<string, ToolItem[]>();
	for (const tool of pendingTools) {
		const requestedOwner = owners.get(tool.id);
		const owner =
			requestedOwner && assistantIds.has(requestedOwner) ? requestedOwner : fallbackOwner;
		const ownerTools = toolsByOwner.get(owner) ?? [];
		ownerTools.push(tool);
		toolsByOwner.set(owner, ownerTools);
	}
	const withoutSettledPanel = hideLatestTurnTools(messages);
	return withoutSettledPanel.map((message, index) => {
		if (index <= userIndex || message.role !== "assistant") return message;
		const tools = toolsByOwner.get(message.id);
		return tools ? { ...message, tools } : message;
	});
}

/**
 * Consolidates one user turn's tools onto its final assistant response.
 * Existing items are included for compatibility with in-memory pre-upgrade turns;
 * the latest value for an id wins without changing first-seen order.
 */
export function settleLatestTurnTools(
	messages: readonly ChatMessage[],
	pendingTools: readonly ToolItem[],
	pruneToolOnlyMessages = true,
): ChatMessage[] {
	const userIndex = latestUserIndex(messages);
	if (userIndex < 0) return [...messages];

	const assistantIndexes: number[] = [];
	const toolsById = new Map<string, ToolItem>();
	for (let index = userIndex + 1; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		assistantIndexes.push(index);
		for (const tool of message.tools ?? []) toolsById.set(tool.id, tool);
	}
	for (const tool of pendingTools) toolsById.set(tool.id, tool);
	const targetIndex = assistantIndexes.at(-1);
	if (targetIndex === undefined) return [...messages];

	const settledTools = [...toolsById.values()].map((tool) =>
		tool.phase === "running" ? { ...tool, phase: "cancelled" as const } : tool,
	);
	const settledMessages: ChatMessage[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (!message) continue;
		if (index <= userIndex || message.role !== "assistant") {
			settledMessages.push(message);
			continue;
		}
		const withoutTransientTools = withoutTools(message);
		if (index !== targetIndex) {
			// Tool-only assistant rounds are useful while work is running, but become empty
			// chrome after their tools are consolidated onto the final response.
			if (!pruneToolOnlyMessages || hasVisibleContent(withoutTransientTools)) {
				settledMessages.push(withoutTransientTools);
			}
			continue;
		}
		const { streaming: _streaming, ...settledMessage } = withoutTransientTools;
		settledMessages.push(
			settledTools.length > 0 ? { ...settledMessage, tools: settledTools } : settledMessage,
		);
	}
	return settledMessages;
}

/**
 * Owns the transient tool state for one chat record.
 *
 * Keeping item and owner maps together prevents callers from clearing one without
 * the other, while the explicit settlement kind documents whether a turn may resume.
 */
export class TurnToolTracker {
	readonly #items = new Map<string, ToolItem>();
	readonly #owners = new Map<string, string>();

	public get(id: string): ToolItem | undefined {
		return this.#items.get(id);
	}

	public reset(): void {
		this.#items.clear();
		this.#owners.clear();
	}

	public attach(messages: ChatMessage[], item: ToolItem): ChatMessage[] {
		const bounded = boundToolItem(item);
		if (!this.#items.has(bounded.id) && this.#items.size >= MAX_TRACKED_TURN_TOOLS) {
			const oldest = this.#items.keys().next().value;
			if (oldest) {
				this.#items.delete(oldest);
				this.#owners.delete(oldest);
			}
		}
		this.#items.set(bounded.id, bounded);
		const attachment = attachLiveTurnTool(messages, bounded, this.#owners.get(bounded.id));
		if (attachment.ownerId) this.#owners.set(bounded.id, attachment.ownerId);
		return attachment.messages;
	}

	public restore(messages: ChatMessage[]): ChatMessage[] {
		return restoreLatestTurnTools(messages, [...this.#items.values()], this.#owners);
	}

	public settle(messages: readonly ChatMessage[], kind: TurnToolSettlement): ChatMessage[] {
		const isFinal = kind === "final";
		const settled = settleLatestTurnTools(messages, [...this.#items.values()], isFinal);
		if (isFinal) this.reset();
		return settled;
	}
}
