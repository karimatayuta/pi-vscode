export interface MutableChatTitle {
	title: string;
	manualTitle: boolean;
}

/** Commits local title state only after the owning Pi session accepts it. */
export async function commitChatTitle(
	state: MutableChatTitle,
	next: Readonly<MutableChatTitle>,
	setSessionTitle: (title: string) => Promise<unknown>,
): Promise<void> {
	await setSessionTitle(next.title);
	state.title = next.title;
	state.manualTitle = next.manualTitle;
}
