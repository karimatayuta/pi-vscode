import { describe, expect, test } from "bun:test";
import { APPROVAL_MODES } from "../../src/shared/approval.js";
import {
	type AppSnapshot,
	isCurrentEpoch,
	PROTOCOL_VERSION,
	validateAppSnapshot,
	validateHostToWebviewMessage,
	validateWebviewToHostMessage,
} from "../../src/shared/protocol.js";
import { DEFAULT_VIEW_DESIGN } from "../../src/shared/view-design.js";

const envelope = {
	protocolVersion: PROTOCOL_VERSION,
	requestId: "transport-request-1",
} as const;

const snapshot: AppSnapshot = {
	protocolVersion: PROTOCOL_VERSION,
	epoch: "session-epoch-1",
	workspace: "my-app",
	trusted: true,
	tabs: [
		{
			id: "chat-1",
			title: "Refactor auth flow",
			phase: "idle",
			progress: "Ready",
			unread: false,
			manualTitle: false,
		},
	],
	activeChatId: "chat-1",
	messages: {
		"chat-1": [
			{
				id: "message-1",
				role: "assistant",
				text: "Ready",
				timestamp: 1,
				contexts: [{ id: "c1", label: "src/auth.ts", kind: "file" }],
				tools: [{ id: "t1", label: "Read src/auth.ts", phase: "success" }],
				edits: [
					{
						id: "e1",
						path: "src/auth.ts",
						patch: "@@ -1 +1 @@",
						additions: 1,
						deletions: 1,
						status: "applied",
					},
				],
				references: [
					{
						refId: "r1",
						epoch: "session-epoch-1",
						label: "src/auth.ts:4",
						kind: "file",
						ariaLabel: "Open src/auth.ts at line 4",
					},
				],
			},
		],
	},
	context: [{ id: "c1", label: "src/auth.ts", kind: "file" }],
	approvalMode: "ask",
	usage: {
		contextTokens: 54_000,
		contextWindow: 128_000,
		contextPercent: 42.1875,
		input: 50_000,
		output: 4_000,
		cacheRead: 10_000,
		cacheWrite: 0,
		total: 54_000,
		cost: 0.18,
		costKind: "estimated",
	},
	model: {
		provider: "provider",
		id: "model-1",
		name: "Model One",
		thinking: "medium",
		options: [
			{
				provider: "provider",
				id: "model-1",
				name: "Model One",
				contextWindow: 128_000,
				supportsImages: true,
				thinkingLevels: ["off", "medium", "high"],
			},
		],
		loading: false,
	},
	commands: [
		{
			id: "review",
			invocation: "/review",
			kind: "skill",
			description: "Review the attached code",
		},
	],
	fileSuggestions: [{ id: "f1", label: "src/auth.ts", kind: "file" }],
	approvalRequest: {
		id: "permission-1",
		chatId: "chat-1",
		capability: "command.execute",
		title: "Run tests",
		detail: "Run the workspace test suite",
		risk: "sensitive",
		command: "bun test",
		cwd: "/workspace",
		targets: ["test"],
	},
	design: DEFAULT_VIEW_DESIGN,
	designScope: "workspace",
};

describe("Webview -> host protocol", () => {
	const validIntents: readonly Record<string, unknown>[] = [
		{ type: "ready" },
		{ type: "newChat" },
		{ type: "showHistory" },
		{ type: "selectChat", chatId: "chat-1" },
		{ type: "closeChat", chatId: "chat-1" },
		{ type: "renameChat", chatId: "chat-1", title: "New title" },
		{ type: "regenerateTitle", chatId: "chat-1" },
		{
			type: "sendPrompt",
			chatId: "chat-1",
			text: "Refactor this file",
			contextIds: ["c1"],
		},
		{ type: "stop", chatId: "chat-1" },
		{ type: "removeContext", id: "c1" },
		{ type: "pickContext", kind: "folder" },
		{ type: "dropContext", uris: ["file:///workspace/src"] },
		{ type: "addCurrentFile" },
		{ type: "addCurrentSelection" },
		{ type: "searchFiles", query: "auth" },
		{ type: "addSuggestedContext", suggestionId: "f1" },
		{
			type: "invokeCommand",
			chatId: "chat-1",
			invocation: "/review",
			args: "--strict",
		},
		{ type: "setApprovalMode", chatId: "chat-1", mode: "autoEdit" },
		{
			type: "approvalDecision",
			permissionRequestId: "permission-1",
			decision: "allowOnce",
		},
		{ type: "loadModels" },
		{
			type: "setModel",
			chatId: "chat-1",
			provider: "provider",
			modelId: "model-1",
		},
		{ type: "setThinking", chatId: "chat-1", level: "xhigh" },
		{
			type: "applyModelSettings",
			chatId: "chat-1",
			provider: "provider",
			modelId: "model-1",
			thinking: "high",
			saveAsDefault: true,
		},
		{ type: "saveModelDefault", chatId: "chat-1" },
		{ type: "configureProvider", provider: "provider" },
		{ type: "compactContext", chatId: "chat-1" },
		{
			type: "openReference",
			refId: "r1",
			epoch: "session-epoch-1",
			action: "openBeside",
		},
		{ type: "reviewEdit", editId: "e1" },
		{ type: "retryMessage", messageId: "message-1" },
		{
			type: "saveDesign",
			design: DEFAULT_VIEW_DESIGN,
			scope: "workspace",
		},
		{ type: "resetDesign", scope: "global" },
		{ type: "resetPermissions" },
	];

	test("validates every current WebviewIntent variant", () => {
		for (const intent of validIntents) {
			const message = { ...envelope, ...intent };
			expect(validateWebviewToHostMessage(message).ok).toBe(true);
		}
	});

	test.each([...APPROVAL_MODES])("accepts the %s approval mode", (mode) => {
		expect(
			validateWebviewToHostMessage({
				...envelope,
				type: "setApprovalMode",
				chatId: "chat-1",
				mode,
			}).ok,
		).toBe(true);
	});

	test.each([
		["missing protocolVersion", { requestId: "r", type: "ready" }],
		["future protocolVersion", { ...envelope, protocolVersion: 2, type: "ready" }],
		["empty requestId", { ...envelope, requestId: " ", type: "ready" }],
		["unknown type", { ...envelope, type: "shell.execute" }],
		["empty prompt", { ...envelope, type: "sendPrompt", chatId: "c", text: " ", contextIds: [] }],
		["unsafe approval mode", { ...envelope, type: "setApprovalMode", chatId: "c", mode: "sudo" }],
		[
			"malformed model settings",
			{
				...envelope,
				type: "applyModelSettings",
				chatId: "c",
				provider: "provider",
				modelId: "model",
				thinking: "extreme",
				saveAsDefault: "yes",
			},
		],
		["empty drop", { ...envelope, type: "dropContext", uris: [] }],
		["missing resource epoch", { ...envelope, type: "openReference", refId: "r", action: "open" }],
	])("rejects %s", (_label, message) => {
		expect(validateWebviewToHostMessage(message).ok).toBe(false);
	});

	test("rejects unsafe View Design values before they cross the host boundary", () => {
		expect(
			validateWebviewToHostMessage({
				...envelope,
				type: "saveDesign",
				scope: "workspace",
				design: {
					...DEFAULT_VIEW_DESIGN,
					interfaceFont: "url(https://evil.invalid/font.woff2)",
				},
			}).ok,
		).toBe(false);
	});
});

describe("host -> Webview protocol", () => {
	test("validates snapshot, focus, and notice variants", () => {
		const messages: readonly Record<string, unknown>[] = [
			{ type: "snapshot", snapshot },
			{ type: "focusComposer" },
			{ type: "notice", level: "warning", message: "Context is getting full" },
		];
		for (const message of messages) {
			expect(validateHostToWebviewMessage({ ...envelope, ...message }).ok).toBe(true);
		}
	});

	test("validates AppSnapshot deeply", () => {
		expect(validateAppSnapshot(snapshot).ok).toBe(true);
		expect(
			validateAppSnapshot({
				...snapshot,
				tabs: [{ ...snapshot.tabs[0], phase: "sleeping" }],
			}).ok,
		).toBe(false);
		expect(
			validateAppSnapshot({
				...snapshot,
				usage: { ...snapshot.usage, contextPercent: 101 },
			}).ok,
		).toBe(false);
		expect(validateAppSnapshot({ ...snapshot, activeChatId: "missing-chat" }).ok).toBe(false);
		expect(validateAppSnapshot({ ...snapshot, tabs: [] }).ok).toBe(false);
		expect(
			validateAppSnapshot({
				...snapshot,
				messages: {
					"chat-1": [{ ...snapshot.messages["chat-1"]?.[0], timestamp: -1 }],
				},
			}).ok,
		).toBe(false);
	});

	test("accepts bounded assistant thought and rejects oversized thought", () => {
		const withThought = {
			...snapshot,
			messages: {
				"chat-1": [{ ...snapshot.messages["chat-1"]?.[0], thought: "Plan the auth change" }],
			},
		};
		expect(validateAppSnapshot(withThought).ok).toBe(true);
		expect(
			validateAppSnapshot({
				...snapshot,
				messages: {
					"chat-1": [{ ...snapshot.messages["chat-1"]?.[0], thought: "x".repeat(512_001) }],
				},
			}).ok,
		).toBe(false);
	});

	test("carries only the selected chat history in each snapshot", () => {
		const secondTab = {
			...snapshot.tabs[0],
			id: "chat-2",
			title: "Second chat",
		};
		const secondMessages = [
			{ id: "message-2", role: "assistant" as const, text: "Second", timestamp: 2 },
		];
		const selectedSecond = {
			...snapshot,
			tabs: [...snapshot.tabs, secondTab],
			activeChatId: "chat-2",
			messages: { "chat-2": secondMessages },
		};
		expect(validateAppSnapshot(selectedSecond).ok).toBe(true);
		expect(
			validateAppSnapshot({
				...selectedSecond,
				messages: { ...selectedSecond.messages, "chat-1": snapshot.messages["chat-1"] },
			}).ok,
		).toBe(false);
		expect(validateAppSnapshot({ ...selectedSecond, messages: {} }).ok).toBe(false);
	});

	test("rejects shallow lookalikes and malformed notices", () => {
		expect(
			validateHostToWebviewMessage({
				...envelope,
				type: "snapshot",
				snapshot: { protocolVersion: 1 },
			}).ok,
		).toBe(false);
		expect(
			validateHostToWebviewMessage({
				...envelope,
				type: "notice",
				level: "fatal",
				message: "boom",
			}).ok,
		).toBe(false);
		expect(
			validateHostToWebviewMessage({
				protocolVersion: 1,
				type: "focusComposer",
			}).ok,
		).toBe(false);
	});

	test("compares reference epochs without coercion", () => {
		expect(isCurrentEpoch({ epoch: "3" }, "3")).toBe(true);
		expect(isCurrentEpoch({ epoch: "3" }, "4")).toBe(false);
		expect(isCurrentEpoch({ epoch: "3" }, 3)).toBe(false);
	});
});
