import { computed, signal } from "@preact/signals";
import type { AppSnapshot, ChatMessage, ViewDesign } from "./types.js";
import { EMPTY_SNAPSHOT } from "./types.js";

export const snapshotSignal = signal<AppSnapshot>(EMPTY_SNAPSHOT);
export const activeViewSignal = signal<"chat" | "design">("chat");
export const promptSignal = signal("");
export const composerFocusedSignal = signal(false);
export const designDraftSignal = signal<ViewDesign>(EMPTY_SNAPSHOT.design);
const optimisticUserMessagesSignal = signal<
	Readonly<Record<string, readonly (ChatMessage & { readonly role: "user" })[]>>
>({});
let acceptNextDesignUpdate = false;

export const activeTabSignal = computed(() => {
	const snapshot = snapshotSignal.value;
	return snapshot.tabs.find((tab) => tab.id === snapshot.activeChatId) ?? snapshot.tabs[0];
});

export function projectOptimisticUserMessages(
	hostMessages: readonly ChatMessage[],
	optimisticMessages: readonly (ChatMessage & { readonly role: "user" })[],
): readonly ChatMessage[] {
	if (optimisticMessages.length === 0) return hostMessages;
	const hostIds = new Set(hostMessages.map((message) => message.id));
	const pending = optimisticMessages.filter((message) => !hostIds.has(message.id));
	return pending.length === 0 ? hostMessages : [...hostMessages, ...pending];
}

export const activeMessagesSignal = computed<readonly ChatMessage[]>(() => {
	const snapshot = snapshotSignal.value;
	return projectOptimisticUserMessages(
		snapshot.messages[snapshot.activeChatId] ?? [],
		optimisticUserMessagesSignal.value[snapshot.activeChatId] ?? [],
	);
});

export function stageOptimisticUserMessage(
	chatId: string,
	message: ChatMessage & { readonly role: "user" },
): void {
	const current = optimisticUserMessagesSignal.value;
	const pending = current[chatId] ?? [];
	if (pending.some((candidate) => candidate.id === message.id)) return;
	optimisticUserMessagesSignal.value = { ...current, [chatId]: [...pending, message] };
}

export function clearOptimisticUserMessages(chatId?: string): void {
	if (chatId === undefined) {
		optimisticUserMessagesSignal.value = {};
		return;
	}
	const { [chatId]: _removed, ...remaining } = optimisticUserMessagesSignal.value;
	optimisticUserMessagesSignal.value = remaining;
}

function reconcileOptimisticUserMessages(snapshot: AppSnapshot): void {
	const current = optimisticUserMessagesSignal.value;
	if (Object.keys(current).length === 0) return;
	const openChats = new Set(snapshot.tabs.map((tab) => tab.id));
	const hostIds = new Set(
		(snapshot.messages[snapshot.activeChatId] ?? []).map((message) => message.id),
	);
	const remaining: Record<string, readonly (ChatMessage & { readonly role: "user" })[]> = {};
	for (const [chatId, messages] of Object.entries(current)) {
		if (!openChats.has(chatId)) continue;
		const pending =
			chatId === snapshot.activeChatId
				? messages.filter((message) => !hostIds.has(message.id))
				: messages;
		if (pending.length > 0) remaining[chatId] = pending;
	}
	optimisticUserMessagesSignal.value = remaining;
}

export const runningCountSignal = computed(
	() =>
		snapshotSignal.value.tabs.filter(
			(tab) => tab.phase === "running" || tab.phase === "waitingApproval",
		).length,
);

export function mergeSnapshot(next: AppSnapshot): void {
	const previous = snapshotSignal.value;
	const draftIsDirty = JSON.stringify(designDraftSignal.value) !== JSON.stringify(previous.design);
	snapshotSignal.value = next;
	reconcileOptimisticUserMessages(next);
	if (activeViewSignal.value !== "design" || !draftIsDirty || acceptNextDesignUpdate) {
		designDraftSignal.value = next.design;
	}
	acceptNextDesignUpdate = false;
}

/** Lets an explicit save/reset response replace a locally edited live preview. */
export function expectDesignUpdate(): void {
	acceptNextDesignUpdate = true;
}
