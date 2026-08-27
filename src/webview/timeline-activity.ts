export type TimelinePhase = "idle" | "running" | "waitingApproval" | "error";

export interface ActivityAnnouncementState {
	readonly chatId: string;
	readonly phase: TimelinePhase;
	readonly announcement: string;
}

/** Returns copy only for a terminal transition from an authoritative running phase. */
export function activityTransitionAnnouncement(
	previous: TimelinePhase | null,
	current: TimelinePhase,
	hasTools: boolean,
): string {
	if (previous !== "running" || current === "running") return "";

	switch (current) {
		case "idle":
			return hasTools
				? "Pi の作業が完了しました。Tools から実行内容を確認できます。"
				: "Pi の作業が完了しました。";
		case "waitingApproval":
			return "Pi が操作の確認を待っています。";
		case "error":
			return "Pi の作業中にエラーが発生しました。";
	}
}

/** Advances per-chat announcement state without repeating copy for unrelated snapshot updates. */
export function advanceActivityAnnouncement(
	previous: ActivityAnnouncementState | null,
	chatId: string,
	current: TimelinePhase,
	hasTools: boolean,
): ActivityAnnouncementState {
	if (!previous || previous.chatId !== chatId) {
		return { chatId, phase: current, announcement: "" };
	}

	const transition = activityTransitionAnnouncement(previous.phase, current, hasTools);
	const announcement =
		current === "running"
			? ""
			: transition || (previous.phase === current ? previous.announcement : "");
	return { chatId, phase: current, announcement };
}
