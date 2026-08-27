import type { KeyboardEvent as PreactKeyboardEvent } from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";
import { postIntent } from "../bridge.js";
import type { ChatTab } from "../types.js";

interface HeaderTabsProps {
	readonly tabs: readonly ChatTab[];
	readonly activeChatId: string;
	readonly runningCount: number;
	readonly onOpenDesign: () => void;
}

const phaseLabel: Record<ChatTab["phase"], string> = {
	idle: "Ready",
	running: "Running",
	waitingApproval: "Approval needed",
	error: "Failed",
};

type NavIconName = "add" | "close" | "history" | "more" | "refresh" | "rename" | "settings";

function NavIcon({ name }: { readonly name: NavIconName }) {
	return (
		<svg
			class="nav-icon"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			{name === "add" ? (
				<path d="M8 3v10M3 8h10" />
			) : name === "close" ? (
				<path d="m4 4 8 8m0-8-8 8" />
			) : name === "history" ? (
				<>
					<path d="M3.2 5.2H.9V2.9" />
					<path d="M1.2 5.2A6 6 0 1 1 2.4 11" />
					<path d="M8 4.5V8l2.3 1.4" />
				</>
			) : name === "more" ? (
				<>
					<circle cx="3" cy="8" r=".8" fill="currentColor" stroke="none" />
					<circle cx="8" cy="8" r=".8" fill="currentColor" stroke="none" />
					<circle cx="13" cy="8" r=".8" fill="currentColor" stroke="none" />
				</>
			) : name === "refresh" ? (
				<>
					<path d="M12.4 5.1V2.5L10.6 4" />
					<path d="M12.1 4.3A5.2 5.2 0 1 0 13 10" />
				</>
			) : name === "rename" ? (
				<>
					<path d="m3 11.8.5-2.6 6.9-6.9 2.3 2.3-6.9 6.9-2.8.3Z" />
					<path d="m9.3 3.4 2.3 2.3" />
				</>
			) : name === "settings" ? (
				<>
					<path d="M2.5 4h5m3 0h3M2.5 8h2m3 0h6M2.5 12h6m3 0h2" />
					<circle cx="9" cy="4" r="1.5" />
					<circle cx="6" cy="8" r="1.5" />
					<circle cx="10" cy="12" r="1.5" />
				</>
			) : null}
		</svg>
	);
}

export function HeaderTabs({ tabs, activeChatId, runningCount, onOpenDesign }: HeaderTabsProps) {
	const [allOpen, setAllOpen] = useState(false);
	const [editingId, setEditingId] = useState<string>();
	const [draftTitle, setDraftTitle] = useState("");
	const editRef = useRef<HTMLInputElement>(null);
	const allButtonRef = useRef<HTMLButtonElement>(null);
	const allMenuRef = useRef<HTMLDivElement>(null);
	const ignoreNextBlurRef = useRef(false);

	useEffect(() => editRef.current?.focus(), [editingId]);
	useEffect(() => {
		if (!allOpen) return undefined;
		allMenuRef.current?.querySelector<HTMLButtonElement>("[data-chat-select]")?.focus();
		const closeFromPointer = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!allMenuRef.current?.contains(target) && !allButtonRef.current?.contains(target)) {
				setAllOpen(false);
			}
		};
		const closeFromKeyboard = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setAllOpen(false);
			allButtonRef.current?.focus();
		};
		window.addEventListener("pointerdown", closeFromPointer);
		window.addEventListener("keydown", closeFromKeyboard);
		return () => {
			window.removeEventListener("pointerdown", closeFromPointer);
			window.removeEventListener("keydown", closeFromKeyboard);
		};
	}, [allOpen]);

	const startRename = (tab: ChatTab) => {
		ignoreNextBlurRef.current = false;
		setEditingId(tab.id);
		setDraftTitle(tab.title);
		setAllOpen(false);
	};

	const commitRename = () => {
		if (ignoreNextBlurRef.current) {
			ignoreNextBlurRef.current = false;
			return;
		}
		if (editingId && draftTitle.trim()) {
			postIntent({ type: "renameChat", chatId: editingId, title: draftTitle.trim().slice(0, 80) });
		}
		setEditingId(undefined);
	};

	const cancelRename = () => {
		ignoreNextBlurRef.current = true;
		setEditingId(undefined);
	};

	const moveFocus = (event: KeyboardEvent, index: number) => {
		if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
			return;
		}
		event.preventDefault();
		let next = index;
		if (event.key === "ArrowLeft") next = index <= 0 ? tabs.length - 1 : index - 1;
		if (event.key === "ArrowRight") next = index >= tabs.length - 1 ? 0 : index + 1;
		if (event.key === "Home") next = 0;
		if (event.key === "End") next = tabs.length - 1;
		const nextTab = tabs[next];
		if (!nextTab) return;
		postIntent({ type: "selectChat", chatId: nextTab.id });
		document.querySelector<HTMLButtonElement>(`[data-chat-tab="${nextTab.id}"]`)?.focus();
	};

	const moveMenuFocus = (event: PreactKeyboardEvent<HTMLDivElement>) => {
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		const items = [
			...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-chat-select]"),
		];
		if (items.length === 0) return;
		event.preventDefault();
		const current = items.indexOf(document.activeElement as HTMLButtonElement);
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? items.length - 1
					: event.key === "ArrowDown"
						? (current + 1) % items.length
						: (current - 1 + items.length) % items.length;
		items[next]?.focus();
	};

	return (
		<nav class="chat-navigation" aria-label="Pi Agent chats">
			<div class="tabs-shell">
				<div class="chat-tabs" role="tablist" aria-label="Pi Agent chats">
					{tabs.map((tab, index) => (
						<div class={`chat-tab-wrap ${tab.id === activeChatId ? "active" : ""}`} key={tab.id}>
							{editingId === tab.id ? (
								<input
									ref={editRef}
									class="tab-title-input"
									value={draftTitle}
									maxLength={80}
									aria-label={`Rename ${tab.title}`}
									onInput={(event) => setDraftTitle(event.currentTarget.value)}
									onBlur={commitRename}
									onKeyDown={(event) => {
										if (event.key === "Enter") commitRename();
										if (event.key === "Escape") cancelRename();
									}}
								/>
							) : (
								<button
									class="chat-tab"
									type="button"
									role="tab"
									id={`chat-tab-${tab.id}`}
									data-chat-tab={tab.id}
									aria-controls="chat-panel"
									aria-selected={tab.id === activeChatId}
									tabIndex={tab.id === activeChatId ? 0 : -1}
									title={`${tab.title} — ${tab.progress || phaseLabel[tab.phase]}`}
									aria-label={`${tab.title}, ${phaseLabel[tab.phase]}, ${tab.progress}`}
									onClick={() => postIntent({ type: "selectChat", chatId: tab.id })}
									onDblClick={() => startRename(tab)}
									onKeyDown={(event) => {
										moveFocus(event as unknown as KeyboardEvent, index);
										if (event.key === "F2") startRename(tab);
									}}
								>
									<span class={`status-icon ${tab.phase}`} aria-hidden="true">
										{tab.phase === "error" ? "!" : tab.phase === "waitingApproval" ? "?" : ""}
									</span>
									<span class="tab-title">{tab.title}</span>
									{tab.unread ? (
										<>
											<span class="unread-badge" aria-hidden="true">
												•
											</span>
											<span class="sr-only">Unread activity</span>
										</>
									) : null}
								</button>
							)}
							<button
								class="tab-close"
								type="button"
								title={`Close ${tab.title}`}
								aria-label={`Close chat ${tab.title}`}
								onClick={() => postIntent({ type: "closeChat", chatId: tab.id })}
							>
								<NavIcon name="close" />
							</button>
						</div>
					))}
				</div>
			</div>
			<div class="header-actions">
				{runningCount > 0 ? (
					<button
						class="activity-summary"
						type="button"
						onClick={() => setAllOpen(true)}
						aria-label={`${runningCount} chats running. Show all chats`}
						title={`${runningCount} chats running`}
					>
						<span class="status-dot running" aria-hidden="true" />
						<span>{runningCount}</span>
					</button>
				) : null}
				<button
					class="icon-button"
					type="button"
					title="New chat"
					aria-label="New chat"
					onClick={() => postIntent({ type: "newChat" })}
				>
					<NavIcon name="add" />
				</button>
				<button
					ref={allButtonRef}
					class="icon-button all-chats-button"
					type="button"
					aria-haspopup="dialog"
					aria-expanded={allOpen}
					title="All chats and settings"
					aria-label="All chats and settings"
					onClick={() => setAllOpen(!allOpen)}
				>
					<NavIcon name="more" />
				</button>
			</div>
			{allOpen ? (
				<div
					ref={allMenuRef}
					class="popover all-chats-popover"
					role="dialog"
					aria-label="All chats"
					onKeyDown={moveMenuFocus}
				>
					<div class="popover-heading all-chat-menu-heading">
						<strong>All chats</strong>
						<div class="all-chat-menu-toolbar">
							<button
								type="button"
								class="icon-button"
								title="Chat history"
								aria-label="Chat history"
								onClick={() => {
									postIntent({ type: "showHistory" });
									setAllOpen(false);
								}}
							>
								<NavIcon name="history" />
							</button>
							<button
								type="button"
								class="icon-button"
								title="Settings and View Design"
								aria-label="Settings and View Design"
								onClick={() => {
									onOpenDesign();
									setAllOpen(false);
								}}
							>
								<NavIcon name="settings" />
							</button>
							<button
								type="button"
								class="icon-button"
								aria-label="Close"
								onClick={() => setAllOpen(false)}
							>
								<NavIcon name="close" />
							</button>
						</div>
					</div>
					<div class="all-chat-list">
						{tabs.map((tab) => (
							<div class="all-chat-row" key={tab.id}>
								<button
									class="all-chat-select"
									type="button"
									data-chat-select
									onClick={() => {
										postIntent({ type: "selectChat", chatId: tab.id });
										setAllOpen(false);
									}}
								>
									<span class={`status-icon ${tab.phase}`} aria-hidden="true">
										{tab.phase === "error" ? "!" : tab.phase === "waitingApproval" ? "?" : ""}
									</span>
									<span>
										<strong>{tab.title}</strong>
										<small>
											{phaseLabel[tab.phase]} · {tab.progress}
										</small>
									</span>
								</button>
								<div class="all-chat-actions">
									<button
										type="button"
										title={`Rename ${tab.title}`}
										aria-label={`Rename ${tab.title}`}
										onClick={() => startRename(tab)}
									>
										<NavIcon name="rename" />
									</button>
									<button
										type="button"
										title={`Regenerate title for ${tab.title}`}
										aria-label={`Regenerate title for ${tab.title}`}
										onClick={() => {
											postIntent({ type: "regenerateTitle", chatId: tab.id });
											setAllOpen(false);
										}}
									>
										<NavIcon name="refresh" />
									</button>
								</div>
							</div>
						))}
					</div>
				</div>
			) : null}
		</nav>
	);
}
