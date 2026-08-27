import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { persistActiveChat, postIntent, restoredActiveChat } from "./bridge.js";
import { Composer } from "./components/Composer.js";
import { HeaderTabs } from "./components/HeaderTabs.js";
import { Timeline } from "./components/Timeline.js";
import { ViewDesign } from "./components/ViewDesign.js";
import {
	activeMessagesSignal,
	activeTabSignal,
	activeViewSignal,
	designDraftSignal,
	runningCountSignal,
	snapshotSignal,
} from "./store.js";
import type { ViewDesign as ViewDesignValue } from "./types.js";

interface NoticeDetail {
	readonly level: "info" | "warning" | "error";
	readonly message: string;
}

function designStyle(design: ViewDesignValue): JSX.CSSProperties {
	const lineHeight =
		design.lineHeight === "compact" ? "1.35" : design.lineHeight === "spacious" ? "1.75" : "1.55";
	const colors = design.colorMode === "custom" ? design.colors : undefined;
	return {
		"--pi-font-interface": design.interfaceFont,
		"--pi-font-message": design.messageFont,
		"--pi-font-code": design.codeFont,
		"--pi-text-size": `${design.textSize}px`,
		"--pi-code-size": `${design.codeSize}px`,
		"--pi-line-height": lineHeight,
		"--pi-message-spacing": `${design.messageSpacing}px`,
		"--pi-radius": `${design.cornerRadius}px`,
		"--pi-custom-background": colors?.background,
		"--pi-custom-surface": colors?.surface,
		"--pi-custom-text": colors?.text,
		"--pi-custom-muted": colors?.muted,
		"--pi-custom-accent": colors?.accent,
		"--pi-custom-border": colors?.border,
		"--pi-custom-user": colors?.userMessage,
		"--pi-custom-assistant": colors?.assistantMessage,
	} as JSX.CSSProperties;
}

export function App() {
	const [notice, setNotice] = useState<NoticeDetail>();
	const view = activeViewSignal.value;
	const snapshot = snapshotSignal.value;
	const activeTab = activeTabSignal.value;
	const messages = activeMessagesSignal.value;
	const runningCount = runningCountSignal.value;
	const visualDesign = view === "design" ? designDraftSignal.value : snapshot.design;

	useEffect(() => {
		const restored = restoredActiveChat();
		postIntent({ type: "ready" });
		if (restored) postIntent({ type: "selectChat", chatId: restored });
		const handleNotice = (event: Event) => {
			const detail = (event as CustomEvent<NoticeDetail>).detail;
			setNotice(detail);
			window.setTimeout(
				() => setNotice((current) => (current === detail ? undefined : current)),
				5_000,
			);
		};
		window.addEventListener("pi-notice", handleNotice);
		return () => window.removeEventListener("pi-notice", handleNotice);
	}, []);

	useEffect(() => {
		if (snapshot.activeChatId) persistActiveChat(snapshot.activeChatId);
	}, [snapshot.activeChatId]);

	const rootClasses = useMemo(
		() =>
			[
				"pi-app",
				`color-${visualDesign.colorMode}`,
				`density-${visualDesign.density}`,
				activeTab?.phase === "running" ? "is-running" : "",
			]
				.filter(Boolean)
				.join(" "),
		[visualDesign.colorMode, visualDesign.density, activeTab?.phase],
	);

	if (view === "design") {
		return (
			<div class={rootClasses} style={designStyle(visualDesign)}>
				<ViewDesign
					committed={snapshot.design}
					initialScope={snapshot.designScope}
					onClose={() => {
						activeViewSignal.value = "chat";
					}}
				/>
			</div>
		);
	}

	return (
		<section class={rootClasses} style={designStyle(visualDesign)} aria-label="Pi Agent chat">
			<HeaderTabs
				tabs={snapshot.tabs}
				activeChatId={snapshot.activeChatId}
				runningCount={runningCount}
				onOpenDesign={() => {
					designDraftSignal.value = snapshot.design;
					activeViewSignal.value = "design";
				}}
			/>
			<Timeline
				messages={messages}
				agentIcon={snapshot.design.agentIcon}
				{...(snapshot.approvalRequest?.chatId === snapshot.activeChatId
					? { approvalRequest: snapshot.approvalRequest }
					: {})}
				contextPercent={snapshot.usage.contextPercent}
				activeChatId={snapshot.activeChatId}
				phase={activeTab?.phase ?? "idle"}
				progress={activeTab?.progress ?? ""}
			/>
			{activeTab ? (
				<Composer
					chatId={activeTab.id}
					phase={activeTab.phase}
					context={snapshot.context}
					commands={snapshot.commands}
					fileSuggestions={snapshot.fileSuggestions}
					approvalMode={snapshot.approvalMode}
					trusted={snapshot.trusted}
					model={snapshot.model}
					usage={snapshot.usage}
				/>
			) : null}
			{notice ? (
				<div
					class={`notice-toast ${notice.level}`}
					role={notice.level === "error" ? "alert" : "status"}
					aria-live="polite"
				>
					<span aria-hidden="true">
						{notice.level === "error" ? "!" : notice.level === "warning" ? "⚠" : "i"}
					</span>
					<span>{notice.message}</span>
					<button
						class="icon-button"
						type="button"
						aria-label="Dismiss"
						onClick={() => setNotice(undefined)}
					>
						×
					</button>
				</div>
			) : null}
		</section>
	);
}
