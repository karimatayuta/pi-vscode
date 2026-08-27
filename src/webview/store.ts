import { computed, signal } from "@preact/signals";
import type { AppSnapshot, ChatMessage, ViewDesign } from "./types.js";
import { EMPTY_SNAPSHOT } from "./types.js";

export const snapshotSignal = signal<AppSnapshot>(EMPTY_SNAPSHOT);
export const activeViewSignal = signal<"chat" | "design">("chat");
export const promptSignal = signal("");
export const composerFocusedSignal = signal(false);
export const designDraftSignal = signal<ViewDesign>(EMPTY_SNAPSHOT.design);
let acceptNextDesignUpdate = false;

export const activeTabSignal = computed(() => {
	const snapshot = snapshotSignal.value;
	return snapshot.tabs.find((tab) => tab.id === snapshot.activeChatId) ?? snapshot.tabs[0];
});

export const activeMessagesSignal = computed<readonly ChatMessage[]>(() => {
	const snapshot = snapshotSignal.value;
	return snapshot.messages[snapshot.activeChatId] ?? [];
});

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
	if (activeViewSignal.value !== "design" || !draftIsDirty || acceptNextDesignUpdate) {
		designDraftSignal.value = next.design;
	}
	acceptNextDesignUpdate = false;
}

/** Lets an explicit save/reset response replace a locally edited live preview. */
export function expectDesignUpdate(): void {
	acceptNextDesignUpdate = true;
}
