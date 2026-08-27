import { useEffect, useId, useRef, useState } from "preact/hooks";
import { postIntent } from "../bridge.js";
import {
	type ActivityAnnouncementState,
	advanceActivityAnnouncement,
	type TimelinePhase,
} from "../timeline-activity.js";
import type { AgentIcon, ApprovalRequest, ChatMessage, ProposedEdit, ToolItem } from "../types.js";
import { AgentAvatar } from "./AgentAvatar.js";
import { Markdown } from "./Markdown.js";

function formatTime(value: number): string {
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(value);
}

function MessageTime({ timestamp }: { readonly timestamp: number }) {
	return (
		<time dateTime={new Date(timestamp).toISOString()} title={new Date(timestamp).toLocaleString()}>
			{formatTime(timestamp)}
		</time>
	);
}

function ToolPanel({ tools }: { readonly tools: readonly ToolItem[] }) {
	const [open, setOpen] = useState(false);
	const listId = `tool-list-${useId()}`;
	return (
		<section class="tool-panel">
			<button
				class="disclosure-heading"
				type="button"
				aria-expanded={open}
				aria-controls={listId}
				aria-label={`Tools ${tools.length}件${open ? "を閉じる" : "を開く"}`}
				onClick={() => setOpen((current) => !current)}
			>
				<span class="tool-disclosure-label">
					<span class={`disclosure-chevron ${open ? "open" : ""}`} aria-hidden="true">
						›
					</span>
					<span>Tools</span>
					<span class="tool-count">{tools.length}件</span>
				</span>
			</button>
			<ol id={listId} class={`tool-list ${open ? "expanded" : "collapsed"}`} aria-hidden={!open}>
				{tools.map((tool) => (
					<li key={tool.id} class={`tool-row ${tool.phase}`}>
						<span class="tool-state" aria-hidden="true">
							{tool.phase === "success"
								? "✓"
								: tool.phase === "error"
									? "!"
									: tool.phase === "cancelled"
										? "×"
										: tool.phase === "running"
											? "◌"
											: "·"}
						</span>
						<span class="tool-copy">
							<span class="tool-label">{tool.label}</span>
							{tool.detail ? <small title={tool.detail}>{tool.detail}</small> : null}
						</span>
						<span class="sr-only">{tool.phase}</span>
					</li>
				))}
			</ol>
		</section>
	);
}

function ThinkingIndicator({
	progress,
	compact = false,
}: {
	readonly progress: string;
	readonly compact?: boolean;
}) {
	const label = progress.trim() || "ご依頼の内容を確認しています";
	return (
		<section
			class={`thinking-indicator ${compact ? "compact" : ""}`}
			role="status"
			aria-live="polite"
			aria-atomic="true"
			aria-label={`Pi Agent の作業状況: ${label}`}
		>
			<span class="thinking-status-mark" aria-hidden="true">
				<span />
				<span />
				<span />
			</span>
			<span class="thinking-label">{label}</span>
		</section>
	);
}

function DiffCard({ edit }: { readonly edit: ProposedEdit }) {
	const [expanded, setExpanded] = useState(true);
	return (
		<article class={`diff-card ${edit.status}`}>
			<header>
				<button
					class="diff-file"
					type="button"
					aria-expanded={expanded}
					onClick={() => setExpanded(!expanded)}
				>
					<span aria-hidden="true">{expanded ? "⌄" : "›"}</span> <span class="file-type">TS</span>{" "}
					{edit.path}
				</button>
				<span class="diff-stats">
					<ins>+{edit.additions}</ins> <del>−{edit.deletions}</del>
				</span>
			</header>
			{expanded ? (
				<section class="diff-preview-region" aria-label={`Proposed patch for ${edit.path}`}>
					<pre class="diff-preview">
						<code>{edit.patch}</code>
					</pre>
				</section>
			) : null}
			<footer>
				<span class={`edit-status ${edit.status}`}>{edit.status}</span>
				<button type="button" onClick={() => postIntent({ type: "reviewEdit", editId: edit.id })}>
					Review in editor
				</button>
			</footer>
		</article>
	);
}

function ProposedEdits({ edits }: { readonly edits: readonly ProposedEdit[] }) {
	const [open, setOpen] = useState(true);
	return (
		<section class="edits-panel">
			<button
				class="disclosure-heading"
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				<span>{open ? "⌄" : "›"} Proposed edits</span>
				<span class="count-badge">
					{edits.length} {edits.length === 1 ? "file" : "files"}
				</span>
			</button>
			{open ? edits.map((edit) => <DiffCard key={edit.id} edit={edit} />) : null}
		</section>
	);
}

function MessageCard({
	message,
	agentIcon,
	progress = "",
	active = false,
	settled = true,
	showLiveTools = false,
	toolPanelKey,
}: {
	readonly message: ChatMessage;
	readonly agentIcon: AgentIcon;
	readonly progress?: string;
	readonly active?: boolean;
	readonly settled?: boolean;
	readonly showLiveTools?: boolean;
	readonly toolPanelKey?: string;
}) {
	const label =
		message.role === "assistant"
			? "Pi"
			: message.role === "user"
				? "You"
				: message.role === "error"
					? "Error"
					: "Pi Agent";
	const tools = message.tools ?? [];
	const isWorking = message.role === "assistant" && active;
	const isSettled =
		message.role === "assistant" && settled && !active && message.streaming !== true;
	const showToolPanel = tools.length > 0 && (showLiveTools || isSettled);
	const messageBody = (
		<>
			<Markdown
				text={message.text}
				{...(message.references ? { references: message.references } : {})}
				{...(message.streaming === undefined ? {} : { streaming: message.streaming })}
			/>
			{message.contexts && message.contexts.length > 0 ? (
				<div class="message-context">
					<small>Context</small>
					<div class="chip-row">
						{message.contexts.map((chip) => (
							<span class="context-chip readonly" key={chip.id}>
								{chip.kind === "selection" ? "⌗" : chip.kind === "folder" ? "▣" : "▤"} {chip.label}
							</span>
						))}
					</div>
				</div>
			) : null}
			{message.role !== "assistant" && tools.length > 0 ? <ToolPanel tools={tools} /> : null}
			{message.edits && message.edits.length > 0 ? <ProposedEdits edits={message.edits} /> : null}
			{message.retryable ? (
				<button
					class="retry-button"
					type="button"
					onClick={() => postIntent({ type: "retryMessage", messageId: message.id })}
				>
					↻ Retry
				</button>
			) : null}
		</>
	);
	return (
		<article
			class={`message-card ${message.role}`}
			aria-label={`${label} message`}
			aria-busy={isWorking || undefined}
		>
			{message.role === "assistant" ? (
				<div class="assistant-message-layout">
					<AgentAvatar icon={agentIcon} className="assistant-avatar" />
					<div class="assistant-message-main">
						<div class="assistant-activity-line">
							<strong class="sr-only">Pi</strong>
							<div class="assistant-activity-content">
								{showToolPanel ? (
									<ToolPanel key={toolPanelKey} tools={tools} />
								) : isWorking ? (
									<ThinkingIndicator progress={progress} compact={message.text.trim().length > 0} />
								) : (
									<span class="assistant-name">Pi</span>
								)}
							</div>
							{isWorking ? null : <MessageTime timestamp={message.timestamp} />}
						</div>
						{messageBody}
					</div>
				</div>
			) : message.role !== "user" ? (
				<header class="message-header">
					<span class={`avatar ${message.role}`} aria-hidden="true">
						{message.role === "error" ? "!" : "i"}
					</span>
					<strong>{label}</strong>
					<MessageTime timestamp={message.timestamp} />
				</header>
			) : null}
			{message.role === "assistant" ? null : messageBody}
		</article>
	);
}

function ApprovalCard({ request }: { readonly request: ApprovalRequest }) {
	const denyButtonRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		const frame = window.requestAnimationFrame(() => denyButtonRef.current?.focus());
		return () => window.cancelAnimationFrame(frame);
	}, [request.id]);

	return (
		<section
			class={`approval-card ${request.risk}`}
			role="alertdialog"
			aria-labelledby="approval-title"
			aria-describedby="approval-detail"
		>
			<div class="approval-icon" aria-hidden="true">
				{request.risk === "dangerous" ? "⚠" : "◆"}
			</div>
			<div class="approval-copy">
				<h3 id="approval-title">{request.title}</h3>
				<p id="approval-detail">{request.detail}</p>
				{request.command ? (
					<pre>
						<code>{request.command}</code>
					</pre>
				) : null}
				{request.cwd ? (
					<dl>
						<dt>Working directory</dt>
						<dd>{request.cwd}</dd>
					</dl>
				) : null}
				{request.targets?.map((target) => (
					<div class="approval-target" key={target}>
						{target}
					</div>
				))}
			</div>
			<div class="approval-actions">
				<button
					ref={denyButtonRef}
					type="button"
					onClick={() =>
						postIntent({
							type: "approvalDecision",
							permissionRequestId: request.id,
							decision: "deny",
						})
					}
				>
					Deny
				</button>
				<button
					class="primary-button"
					type="button"
					onClick={() =>
						postIntent({
							type: "approvalDecision",
							permissionRequestId: request.id,
							decision: "allowOnce",
						})
					}
				>
					{request.risk === "dangerous" ? "Run once" : "Allow once"}
				</button>
				{request.risk === "normal" ? (
					<button
						type="button"
						onClick={() =>
							postIntent({
								type: "approvalDecision",
								permissionRequestId: request.id,
								decision: "allowSession",
							})
						}
					>
						Allow for session
					</button>
				) : null}
			</div>
		</section>
	);
}

interface TimelineProps {
	readonly messages: readonly ChatMessage[];
	readonly agentIcon: AgentIcon;
	readonly approvalRequest?: ApprovalRequest;
	readonly contextPercent: number | null;
	readonly activeChatId: string;
	readonly phase: TimelinePhase;
	readonly progress: string;
}

export function Timeline({
	messages,
	agentIcon,
	approvalRequest,
	contextPercent,
	activeChatId,
	phase,
	progress,
}: TimelineProps) {
	const timelineRef = useRef<HTMLElement>(null);
	const endRef = useRef<HTMLDivElement>(null);
	const followLatestRef = useRef(true);
	const activityAnnouncementRef = useRef<ActivityAnnouncementState | null>(null);
	const [atLatest, setAtLatest] = useState(true);
	const [transitionAnnouncement, setTransitionAnnouncement] = useState("");
	const lastMessage = messages.at(-1);
	let latestUserIndex = -1;
	let assistantActivityIndex = -1;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role === "user") {
			latestUserIndex = index;
			assistantActivityIndex = -1;
		} else if (message?.role === "assistant") {
			assistantActivityIndex = index;
		}
	}
	const assistantActivityTarget = messages[assistantActivityIndex];
	const hasAssistantActivityTarget = assistantActivityTarget?.role === "assistant";
	const hasCompletedTools = (assistantActivityTarget?.tools?.length ?? 0) > 0;
	const latestTurnSettled = phase === "idle" || phase === "error";
	const latestTurnActive = phase === "running" || phase === "waitingApproval";

	useEffect(() => {
		const previous = activityAnnouncementRef.current;
		const next = advanceActivityAnnouncement(previous, activeChatId, phase, hasCompletedTools);
		activityAnnouncementRef.current = next;
		if (next.announcement !== (previous?.announcement ?? "")) {
			setTransitionAnnouncement(next.announcement);
		}
	}, [activeChatId, hasCompletedTools, phase]);

	useEffect(() => {
		followLatestRef.current = true;
		setAtLatest(true);
		window.requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: "end" }));
	}, [activeChatId]);

	useEffect(() => {
		if (phase === "running" && followLatestRef.current) {
			endRef.current?.scrollIntoView({ block: "end" });
		}
	}, [lastMessage?.id, lastMessage?.text.length, phase]);

	const updateFollowState = () => {
		const element = timelineRef.current;
		if (!element) return;
		const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
		const isNearLatest = distanceFromBottom <= 48;
		followLatestRef.current = isNearLatest;
		setAtLatest(isNearLatest);
	};

	const jumpToLatest = () => {
		followLatestRef.current = true;
		setAtLatest(true);
		endRef.current?.scrollIntoView({ block: "end" });
	};

	return (
		<main
			ref={timelineRef}
			class="timeline"
			id="chat-panel"
			role="tabpanel"
			aria-labelledby={`chat-tab-${activeChatId}`}
			aria-busy={phase === "running"}
			onScroll={updateFollowState}
		>
			{!atLatest ? (
				<button class="jump-to-latest" type="button" onClick={jumpToLatest}>
					<span aria-hidden="true">↓</span> Jump to latest
				</button>
			) : null}
			{contextPercent !== null && contextPercent >= 90 ? (
				<div class="context-warning critical" role="status" aria-live="polite">
					<span aria-hidden="true">⚠</span>
					<span>Context nearly full. Compact it or start a new chat.</span>
					<span class="context-warning-actions">
						<button
							type="button"
							onClick={() => postIntent({ type: "compactContext", chatId: activeChatId })}
						>
							Compact
						</button>
						<button type="button" onClick={() => postIntent({ type: "newChat" })}>
							New chat
						</button>
					</span>
				</div>
			) : contextPercent !== null && contextPercent >= 70 ? (
				<div class="context-warning warning" role="status">
					<span aria-hidden="true">◒</span> Context is getting full.
				</div>
			) : null}
			{messages.length === 0 ? (
				<section class="empty-chat">
					<AgentAvatar icon={agentIcon} className="agent-avatar-hero" />
					<h2>What should Pi work on?</h2>
					<p>
						Add project context, choose an approval mode, and ask a question. Type <kbd>/</kbd> for
						every command and agent skill available in this session.
					</p>
					<div class="starter-actions">
						<button type="button" onClick={() => postIntent({ type: "addCurrentFile" })}>
							Add current file
						</button>
						<button type="button" onClick={() => postIntent({ type: "addCurrentSelection" })}>
							Add selection
						</button>
					</div>
				</section>
			) : (
				messages.map((message, index) => {
					const inLatestTurn = latestUserIndex >= 0 && index > latestUserIndex;
					const isActivityTarget = index === assistantActivityIndex;
					const settled = !inLatestTurn || (isActivityTarget && latestTurnSettled);
					const hasTools = (message.tools?.length ?? 0) > 0;
					const showLiveTools =
						message.role === "assistant" && inLatestTurn && latestTurnActive && hasTools;
					const toolPanelKey = hasTools
						? `${activeChatId}:${message.id}:${showLiveTools ? "live" : "settled"}`
						: undefined;
					return (
						<MessageCard
							key={message.id}
							message={message}
							agentIcon={agentIcon}
							progress={isActivityTarget ? progress : ""}
							active={isActivityTarget && latestTurnActive}
							settled={settled}
							showLiveTools={showLiveTools}
							{...(toolPanelKey ? { toolPanelKey } : {})}
						/>
					);
				})
			)}
			{latestTurnActive && !hasAssistantActivityTarget ? (
				<article
					class="message-card assistant pending-assistant"
					aria-label="Pi message"
					aria-busy="true"
				>
					<div class="assistant-message-layout">
						<AgentAvatar icon={agentIcon} className="assistant-avatar" />
						<div class="assistant-message-main">
							<div class="assistant-activity-line">
								<strong class="sr-only">Pi</strong>
								<div class="assistant-activity-content">
									<ThinkingIndicator progress={progress} />
								</div>
							</div>
						</div>
					</div>
				</article>
			) : null}
			{approvalRequest ? <ApprovalCard request={approvalRequest} /> : null}
			<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
				{transitionAnnouncement}
			</div>
			<div ref={endRef} />
		</main>
	);
}
