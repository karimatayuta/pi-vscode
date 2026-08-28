import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	activityTransitionAnnouncement,
	advanceActivityAnnouncement,
} from "../../src/webview/timeline-activity.js";

const projectRoot = resolve(import.meta.dir, "../..");
const timelineSource = readFileSync(
	resolve(projectRoot, "src/webview/components/Timeline.tsx"),
	"utf8",
);
const appSource = readFileSync(resolve(projectRoot, "src/webview/App.tsx"), "utf8");
const styleSource = readFileSync(resolve(projectRoot, "src/webview/styles.css"), "utf8");

describe("Pi assistant activity layout", () => {
	test("keeps the avatar, activity, tools, and answer in one two-column assistant row", () => {
		expect(timelineSource).toContain('class="assistant-message-layout"');
		expect(timelineSource).toContain(
			'<AgentAvatar icon={agentIcon} className="assistant-avatar" />',
		);
		expect(timelineSource).toContain('class="assistant-message-main"');
		expect(timelineSource).toContain("const showThinking = isWorking || thought.length > 0;");
		expect(timelineSource).toMatch(
			/\{showThinking \? \([\s\S]*?<ThinkingIndicator[\s\S]*?\{showToolPanel \? <ToolPanel key=\{toolPanelKey\} tools=\{tools\} \/> : null\}/u,
		);
		expect(styleSource).toMatch(
			/\.assistant-message-layout \{[\s\S]*?grid-template-columns: 18px minmax\(0, 1fr\)/u,
		);
		expect(styleSource).toMatch(/\.assistant-message-main,[\s\S]*?min-width: 0/u);
	});

	test("shows activity for the active latest assistant even between stream deltas", () => {
		expect(timelineSource).toContain('const isWorking = message.role === "assistant" && active;');
		expect(timelineSource).not.toContain("active || message.streaming");
		expect(timelineSource).toContain(
			'const latestTurnActive = phase === "running" || phase === "waitingApproval";',
		);
		expect(timelineSource).toContain("active={isActivityTarget && latestTurnActive}");
		expect(timelineSource).toContain(
			"{isWorking ? null : <MessageTime timestamp={message.timestamp} />}",
		);
		expect(timelineSource).toContain("latestTurnActive && !hasAssistantActivityTarget");
		expect(timelineSource).toContain('class="message-card assistant pending-assistant"');
		expect(timelineSource).toContain(
			"}, [lastMessage?.id, lastMessage?.text.length, lastMessage?.thought?.length, phase]);",
		);
	});

	test("keeps completed tools collapsed and accessible", () => {
		expect(timelineSource).toContain("const [open, setOpen] = useState(false);");
		expect(timelineSource).toMatch(
			/const isSettled =[\s\S]*?message\.role === "assistant" && settled && !active && message\.streaming !== true;/u,
		);
		expect(timelineSource).toMatch(
			/const showToolPanel = tools\.length > 0 && \(showLiveTools \|\| isSettled\);/u,
		);
		expect(timelineSource).toContain(
			'const latestTurnSettled = phase === "idle" || phase === "error";',
		);
		expect(timelineSource).toContain(
			"const settled = !inLatestTurn || (isActivityTarget && latestTurnSettled);",
		);
		expect(timelineSource).toMatch(
			/`\$\{activeChatId\}:\$\{message\.id\}:\$\{showLiveTools \? "live" : "settled"\}`/u,
		);
		expect(timelineSource).toContain('<span class="tool-count">{tools.length}件</span>');
		expect(timelineSource).toContain("aria-controls={listId}");
		expect(timelineSource).toMatch(
			/aria-label=\{`Tools \$\{tools\.length\}件\$\{open \? "を閉じる" : "を開く"\}`\}/u,
		);
		expect(timelineSource).toMatch(/class=\{`tool-list \$\{open \? "expanded" : "collapsed"\}`\}/u);
		expect(timelineSource).toContain("aria-hidden={!open}");
		expect(timelineSource).not.toContain('class="tool-list" hidden={!open}');
		expect(styleSource).toMatch(/\.tool-list\.collapsed \{[\s\S]*?display: none/u);
		expect(styleSource).toMatch(/\.tool-list\.expanded \{[\s\S]*?display: block/u);
		expect(styleSource).toMatch(
			/\.tool-disclosure-label \{[\s\S]*?display: inline-flex[\s\S]*?align-items: center/u,
		);
		expect(timelineSource).toContain('<span class="tool-label">{tool.label}</span>');
		expect(timelineSource).toContain("<small title={tool.detail}>{tool.detail}</small>");
		expect(timelineSource).toContain('<span class="sr-only">{tool.phase}</span>');
	});

	test("shows every live assistant tool round and resets the consolidated panel on settlement", () => {
		expect(timelineSource).toContain(
			'const showLiveTools =\n\t\t\t\t\t\tmessage.role === "assistant" && inLatestTurn && latestTurnActive && hasTools;',
		);
		expect(timelineSource).toContain("showLiveTools={showLiveTools}");
		expect(timelineSource).toContain(
			"const showToolPanel = tools.length > 0 && (showLiveTools || isSettled);",
		);
		expect(timelineSource).toContain("const showThinking = isWorking || thought.length > 0;");
		expect(timelineSource).toMatch(
			/\{showThinking \? \([\s\S]*?<ThinkingIndicator[\s\S]*?\{showToolPanel \? <ToolPanel key=\{toolPanelKey\} tools=\{tools\} \/> : null\}/u,
		);
		expect(timelineSource).toContain('showLiveTools ? "live" : "settled"');
		expect(timelineSource).toContain("const [open, setOpen] = useState(false);");
	});

	test("uses native button activation and synchronized accordion ARIA", () => {
		const panelSource = timelineSource.slice(
			timelineSource.indexOf("function ToolPanel"),
			timelineSource.indexOf("function ThinkingIndicator"),
		);
		expect(panelSource).toContain('type="button"');
		expect(panelSource).toContain("onClick={() => setOpen((current) => !current)}");
		expect(panelSource).toContain("aria-expanded={open}");
		expect(panelSource).toContain("aria-controls={listId}");
		expect(panelSource).toContain("id={listId}");
		expect(panelSource).not.toContain("onKeyDown");
	});

	test("keeps complete tool paths visible on a dedicated wrapping line", () => {
		expect(timelineSource).toContain('class="tool-copy"');
		expect(timelineSource).toContain("<small title={tool.detail}>{tool.detail}</small>");
		expect(styleSource).toMatch(
			/\.tool-row \{[\s\S]*?grid-template-columns: 17px minmax\(0, 1fr\)[\s\S]*?align-items: start/u,
		);
		expect(styleSource).toMatch(/\.tool-copy \{[\s\S]*?min-width: 0[\s\S]*?gap: 1px/u);

		const detailStyles = styleSource.slice(
			styleSource.indexOf(".tool-row small {"),
			styleSource.indexOf(".tool-state {"),
		);
		expect(detailStyles).toContain("overflow-wrap: anywhere;");
		expect(detailStyles).toContain("white-space: normal;");
		expect(detailStyles).not.toContain("text-overflow: ellipsis;");
		expect(detailStyles).not.toContain("max-width:");
	});

	test("announces only the bounded activity summary and honors reduced motion and narrow views", () => {
		const indicatorSource = timelineSource.slice(
			timelineSource.indexOf("function ThinkingIndicator"),
			timelineSource.indexOf("function DiffCard"),
		);
		expect(indicatorSource).toContain('role="status"');
		expect(indicatorSource).toContain('aria-live="polite"');
		expect(indicatorSource).toContain("{label}");
		expect(indicatorSource).not.toContain("message.text");
		expect(indicatorSource).not.toMatch(/thinking-transcript[\s\S]*?aria-live/u);
		expect(indicatorSource).toContain('type="button"');
		expect(indicatorSource).toContain("onClick={() => setOpen((current) => !current)}");
		expect(indicatorSource).toContain("aria-expanded={open}");
		expect(indicatorSource).toContain("aria-controls={transcriptId}");
		expect(indicatorSource).toMatch(
			/class=\{`thinking-transcript \$\{open \? "expanded" : "collapsed"\}`\}/u,
		);
		expect(indicatorSource).toContain("aria-hidden={!open}");
		expect(indicatorSource).toContain("<code>{thought}</code>");
		expect(appSource).not.toMatch(/activeTab\.title\}: \$\{activeTab\.progress/u);
		expect(timelineSource).toContain(
			'class="sr-only" role="status" aria-live="polite" aria-atomic="true"',
		);
		expect(styleSource).toMatch(
			/\.thinking-label \{[\s\S]*?flex: 1 1 auto[\s\S]*?overflow: visible[\s\S]*?overflow-wrap: anywhere[\s\S]*?white-space: normal/u,
		);
		expect(styleSource).toMatch(
			/\.tool-label \{[\s\S]*?min-width: 0[\s\S]*?overflow-wrap: anywhere/u,
		);
		expect(styleSource).toMatch(/\.thinking-transcript\.collapsed \{[\s\S]*?display: none/u);
		expect(styleSource).toMatch(/\.thinking-transcript\.expanded \{[\s\S]*?display: block/u);
		expect(styleSource).toMatch(
			/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.thinking-status-mark > span[\s\S]*?animation: none/u,
		);
		expect(styleSource).toMatch(
			/@media \(max-width: 300px\)[\s\S]*?\.assistant-activity-line time \{[\s\S]*?display: none/u,
		);
	});
});

describe("user prompt visibility", () => {
	test("renders user prompts in the timeline instead of hiding them", () => {
		expect(timelineSource).toContain("messages.map((message, index) => {");
		expect(timelineSource).toContain('{message.role === "assistant" ? null : messageBody}');
		expect(timelineSource).not.toMatch(
			/messages\.filter\(\s*\(?message\)?\s*=>\s*message\.role\s*!==\s*"user"/u,
		);
		expect(timelineSource).toMatch(/aria-label=\{`\$\{label\} message`\}/u);
		expect(timelineSource).toContain('message.role === "user"');
		expect(timelineSource).toContain('? "You"');
	});

	test("keeps user bubbles paintable when they use fit-content width", () => {
		const userCardStyles = styleSource.slice(
			styleSource.indexOf(".message-card.user {"),
			styleSource.indexOf(".message-card.error {"),
		);
		expect(userCardStyles).toContain("width: fit-content;");
		expect(userCardStyles).toContain("align-self: flex-end;");
		expect(userCardStyles).toContain("content-visibility: visible;");
		expect(userCardStyles).not.toMatch(/content-visibility:\s*auto/u);
	});
});

describe("Pi activity transition announcements", () => {
	test("announces only authoritative transitions out of running", () => {
		expect(activityTransitionAnnouncement(null, "idle", false)).toBe("");
		expect(activityTransitionAnnouncement("idle", "error", false)).toBe("");
		expect(activityTransitionAnnouncement("waitingApproval", "idle", true)).toBe("");
		expect(activityTransitionAnnouncement("running", "running", true)).toBe("");
		expect(activityTransitionAnnouncement("running", "waitingApproval", false)).toBe(
			"Pi が操作の確認を待っています。",
		);
		expect(activityTransitionAnnouncement("running", "error", false)).toBe(
			"Pi の作業中にエラーが発生しました。",
		);
	});

	test("uses completion copy that reflects whether Tools are available", () => {
		expect(activityTransitionAnnouncement("running", "idle", false)).toBe(
			"Pi の作業が完了しました。",
		);
		expect(activityTransitionAnnouncement("running", "idle", true)).toBe(
			"Pi の作業が完了しました。Tools から実行内容を確認できます。",
		);
	});

	test("suppresses initial idle, repeated snapshots, and chat-switch announcements", () => {
		const initial = advanceActivityAnnouncement(null, "chat-a", "idle", false);
		expect(initial.announcement).toBe("");

		const running = advanceActivityAnnouncement(initial, "chat-a", "running", false);
		const completed = advanceActivityAnnouncement(running, "chat-a", "idle", true);
		expect(completed.announcement).toContain("Tools");

		const repeated = advanceActivityAnnouncement(completed, "chat-a", "idle", true);
		expect(repeated.announcement).toBe(completed.announcement);

		const switched = advanceActivityAnnouncement(repeated, "chat-b", "idle", true);
		expect(switched.announcement).toBe("");
	});
});
