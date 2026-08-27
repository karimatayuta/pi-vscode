import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import * as vscode from "vscode";
import type { ApprovalMode } from "../../shared/approval.js";
import type {
	ApprovalRequest,
	AppSnapshot,
	ChatMessage,
	ChatPhase,
	ChatTab,
	CommandSuggestion,
	ModelOption,
	ModelState,
	ProposedEdit,
	ToolItem,
	UsageState,
} from "../../shared/protocol.js";
import { createFallbackTitle, renameChatTitle } from "../../shared/title.js";
import {
	DEFAULT_VIEW_DESIGN as DEFAULT_DESIGN,
	type ViewDesign,
} from "../../shared/view-design.js";
import { fireAndReport } from "../async/fire-and-report.js";
import { ChatSessionController } from "../chat/chat-session-controller.js";
import type { ContextStore } from "../context/context-store.js";
import type { ProposedEditStore } from "../edits/proposed-edit-store.js";
import { ToolEditCapture } from "../edits/tool-edit-capture.js";
import {
	MessageReferenceCache,
	refreshHistoryReferences,
	refreshMessageReferences,
} from "../links/message-reference-lifecycle.js";
import type { ReferenceRegistry } from "../links/reference-registry.js";
import type {
	ToolApprovalPrompt,
	ToolAuthorizationRouter,
} from "../permissions/tool-authorization-router.js";
import { safeErrorMessage } from "../pi/sanitize.js";
import type {
	PiHostApi,
	PiHostEvent,
	PiMessageDto,
	PiSessionBootstrapDto,
	PiSessionSnapshotDto,
	PiThinkingLevel,
	PiToolEventDto,
} from "../pi/types.js";
import type { WorkspaceTrustState } from "../workspace-trust-transition.js";
import {
	summarizeSessionActivity,
	summarizeSnapshotActivity,
	summarizeStreamActivity,
	summarizeToolActivity,
	taskFocusFromUserText,
} from "./activity-summary.js";
import { boundChatHistory, boundChatMessage } from "./bounded-chat-history.js";
import {
	createPiPrompt,
	mergeCommandSuggestions,
	modelOptionsFromCatalog,
	modelStateFromSnapshot,
	textFromPiMessage,
	usageFromSnapshot,
} from "./chat-mapping.js";
import { commitChatTitle } from "./chat-title-transaction.js";
import { CoalescedTask } from "./coalesced-task.js";
import { FileSuggestionIndex } from "./file-suggestion-index.js";
import { KeyedOperationCoalescer } from "./keyed-operation-coalescer.js";
import { LatestRequest } from "./latest-request.js";
import {
	type PersistedTab,
	type PersistedWorkspace,
	parsePersistedWorkspace,
} from "./persisted-workspace.js";
import { turnToolTransitionForEvent } from "./turn-tool-lifecycle.js";
import { type TurnToolSettlement, TurnToolTracker } from "./turn-tools.js";

interface ChatRecord {
	readonly id: string;
	readonly controller: ChatSessionController;
	subscription: { dispose(): void };
	title: string;
	manualTitle: boolean;
	phase: ChatPhase;
	progress: string;
	activityFocus: string;
	unread: boolean;
	messages: ChatMessage[];
	commands: CommandSuggestion[];
	approvalMode: ApprovalMode;
	usage: UsageState;
	model: ModelState;
	currentAssistantId: string | undefined;
	readonly toolTracker: TurnToolTracker;
	proposedEdits: ProposedEdit[];
	readonly editCapture: ToolEditCapture;
	sessionFile?: string;
}

const EMPTY_USAGE: UsageState = {
	contextTokens: null,
	contextWindow: null,
	contextPercent: null,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
	cost: null,
	costKind: "unknown",
};
const MAX_OPEN_CHATS = 20;

const HOST_COMMANDS: readonly CommandSuggestion[] = [
	{ id: "host:new", invocation: "/new", kind: "host", description: "Start a new independent chat" },
	{
		id: "host:model",
		invocation: "/model",
		kind: "host",
		description: "Open model and reasoning settings",
	},
	{
		id: "host:compact",
		invocation: "/compact",
		kind: "host",
		description: "Compact the active context",
	},
	{ id: "host:title", invocation: "/title", kind: "host", description: "Rename this chat" },
	{
		id: "host:stop",
		invocation: "/stop",
		kind: "host",
		description: "Stop the current response and tools",
	},
	{ id: "host:help", invocation: "/help", kind: "host", description: "Show available Pi commands" },
];

function defaultMode(): ApprovalMode {
	const configured = vscode.workspace
		.getConfiguration("piAgent.security")
		.get<string>("defaultApprovalMode", "ask");
	if (configured === "auto-edit" || configured === "autoEdit") return "autoEdit";
	// Full Access is deliberately session-only and can only be entered through
	// the UI's explicit confirmation flow.
	if (configured === "full-access" || configured === "fullAccess") return "ask";
	return configured === "plan" ? "plan" : "ask";
}

function stringToolArgument(args: PiToolEventDto["args"], key: string): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const value = (args as { readonly [key: string]: PiToolEventDto["args"] })[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * Workspace-scoped orchestrator for chat aggregates and their Pi sessions.
 * Pure mapping, history bounds, tool transitions, restored-state parsing, and
 * async request scheduling live in focused modules; ordered record mutations
 * remain here so one event has a single, auditable commit point.
 */
export class ChatWorkspaceModel implements vscode.Disposable {
	readonly #records = new Map<string, ChatRecord>();
	readonly #onDidChange = new vscode.EventEmitter<void>();
	readonly #subscriptions: vscode.Disposable[] = [];
	readonly #referenceCache = new MessageReferenceCache();
	readonly #fileSearch = new LatestRequest();
	readonly #modelLoad = new LatestRequest();
	readonly #fileSuggestionIndex = new FileSuggestionIndex<vscode.Uri>();
	readonly #chatCloses = new KeyedOperationCoalescer<string, void>();
	readonly #persistTask: CoalescedTask;
	#pendingPersistedState: PersistedWorkspace | undefined;
	#activeChatId = "";
	readonly #approvalRequests = new Map<string, ApprovalRequest>();
	readonly #approvalOrderByChat = new Map<string, string[]>();
	#design: ViewDesign = DEFAULT_DESIGN;
	#designScope: "global" | "workspace" = "global";
	#modelOptions: ModelOption[] = [];
	#fileSuggestions: AppSnapshot["fileSuggestions"] = [];
	#disposed = false;

	public readonly onDidChange = this.#onDidChange.event;

	public constructor(
		private readonly extensionContext: vscode.ExtensionContext,
		private readonly host: PiHostApi,
		private readonly contextStore: ContextStore,
		private readonly authorization: ToolAuthorizationRouter,
		private readonly references: ReferenceRegistry,
		private readonly edits: ProposedEditStore,
		private readonly workspaceTrust: WorkspaceTrustState,
		private readonly output: vscode.OutputChannel,
	) {
		this.#persistTask = new CoalescedTask(
			() => this.#writePersistedState(),
			(error) => this.#log("Could not save Pi Agent workspace state.", error),
		);
		this.#subscriptions.push(
			contextStore.onDidChange(() => this.#emit()),
			authorization.onDidRequest((prompt) => this.#handleApproval(prompt)),
			authorization.onDidResolve(({ id }) => {
				this.#removeApproval(id);
				this.#emit();
			}),
			authorization.onDidReset(() => {
				this.#approvalRequests.clear();
				this.#approvalOrderByChat.clear();
				for (const record of this.#records.values()) {
					if (record.phase === "waitingApproval") {
						this.#settleTurnTools(record, "final");
						record.phase = "idle";
						record.progress = "権限の確認状態をリセットしました";
					}
				}
				this.#emit();
				void this.#persist();
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.#fileSearch.invalidate();
				this.#fileSuggestionIndex.clear();
				this.#fileSuggestions = [];
				this.references.invalidate();
				this.#emit();
			}),
			edits.onDidRemove((id) => this.#removeEditReference(id)),
		);
	}

	public get activeChatId(): string {
		return this.#activeChatId;
	}

	public async initialize(): Promise<void> {
		await this.host.start();
		const persisted = parsePersistedWorkspace(
			this.extensionContext.workspaceState.get<unknown>("piAgent.workspace"),
			this.workspaceTrust.trusted,
		);
		if (persisted && persisted.tabs.length > 0) {
			for (const tab of persisted.tabs.slice(0, 20)) {
				await this.#createRecord(
					tab,
					tab.sessionFile ? { kind: "file", path: tab.sessionFile } : { kind: "new" },
				);
			}
			this.#activeChatId = this.#records.has(persisted.activeChatId ?? "")
				? (persisted.activeChatId ?? "")
				: (this.#records.keys().next().value ?? "");
		}
		if (this.#records.size === 0) {
			await this.newChat();
		}
		this.#markViewed(this.#activeChatId);
		this.#emit();
	}

	public snapshot(): AppSnapshot {
		const active = this.#records.get(this.#activeChatId) ?? this.#records.values().next().value;
		const messages: Record<string, ChatMessage[]> = {};
		if (active) {
			active.messages = refreshHistoryReferences(
				active.messages,
				this.references,
				this.#referenceCache,
			);
			messages[active.id] = active.messages;
		}
		return {
			protocolVersion: 1,
			epoch: this.references.epoch,
			workspace:
				vscode.workspace.name ?? vscode.workspace.workspaceFolders?.[0]?.name ?? "No workspace",
			trusted: this.workspaceTrust.trusted,
			tabs: [...this.#records.values()].map((record) => this.#tab(record)),
			activeChatId: active?.id ?? "",
			messages,
			context: this.contextStore.items.map((item) => ({
				id: item.id,
				label: item.label,
				kind: item.kind,
			})),
			approvalMode: active?.approvalMode ?? "plan",
			usage: active?.usage ?? EMPTY_USAGE,
			model: active?.model ?? {
				name: "Choose model",
				thinking: "off",
				options: [...this.#modelOptions],
				loading: false,
			},
			commands: active?.commands ?? [...HOST_COMMANDS],
			fileSuggestions: this.#fileSuggestions,
			...(active ? this.#activeApproval(active.id) : {}),
			design: this.#design,
			designScope: this.#designScope,
		};
	}

	public async newChat(): Promise<string> {
		this.#assertCanOpenChat();
		const record = await this.#createRecord(
			{ id: randomUUID(), title: "New chat", manualTitle: false, approvalMode: defaultMode() },
			{ kind: "new" },
		);
		this.selectChat(record.id);
		await this.#persist();
		return record.id;
	}

	/** Keeps this Extension Host restricted until VS Code reloads it after a trust grant. */
	public requireReloadForWorkspaceTrust(): void {
		if (!this.workspaceTrust.requireReload()) return;
		this.#approvalRequests.clear();
		this.#approvalOrderByChat.clear();
		for (const record of this.#records.values()) {
			record.approvalMode = "plan";
			const sessionId = record.controller.sessionId;
			if (!sessionId) continue;
			this.authorization.cancelPendingForSession(
				sessionId,
				"Reload VS Code before enabling trusted Pi Agent features.",
			);
			this.authorization.setMode(sessionId, "plan");
			if (record.phase === "waitingApproval") {
				this.#settleTurnTools(record, "final");
				record.phase = "idle";
				record.progress = "再読み込み後に信頼済み機能を利用できます";
			}
		}
		this.#emit();
		void this.#persist();
	}

	public selectChat(chatId: string): boolean {
		if (!this.#records.has(chatId)) return false;
		this.#activeChatId = chatId;
		this.#markViewed(chatId);
		this.#emit();
		void this.#persist();
		return true;
	}

	public closeChat(chatId: string): Promise<void> {
		return this.#chatCloses.run(chatId, () => this.#closeChatOnce(chatId));
	}

	async #closeChatOnce(chatId: string): Promise<void> {
		const record = this.#records.get(chatId);
		if (!record) return;
		if (record.phase === "running" || record.phase === "waitingApproval") {
			const choice = await vscode.window.showWarningMessage(
				`“${record.title}” is still running.`,
				{ modal: true },
				"Keep running in background",
				"Stop and close",
			);
			if (choice === "Keep running in background" || !choice) {
				record.unread = true;
				if (this.#activeChatId === chatId) {
					const other = [...this.#records.keys()].find((id) => id !== chatId);
					if (other) this.selectChat(other);
				}
				return;
			}
			const runningSessionId = record.controller.sessionId;
			if (runningSessionId) {
				this.authorization.cancelPendingForSession(
					runningSessionId,
					"The chat was closed before this tool request was approved.",
				);
			}
		}
		const sessionId = record.controller.sessionId;
		let closeFailure: string | undefined;
		record.subscription.dispose();
		try {
			await record.controller.close();
		} catch (error) {
			closeFailure = safeErrorMessage(
				error,
				"Pi Agent could not close the underlying session cleanly.",
			);
			this.#log("Could not close a Pi Agent session cleanly; removing its local tab.", error);
		} finally {
			record.controller.dispose();
			if (sessionId) this.authorization.unregister(sessionId);
			for (const approvalId of this.#approvalOrderByChat.get(chatId) ?? []) {
				this.#approvalRequests.delete(approvalId);
			}
			this.#approvalOrderByChat.delete(chatId);
			this.#records.delete(chatId);
			if (this.#activeChatId === chatId) {
				this.#activeChatId = this.#records.keys().next().value ?? "";
			}
		}
		if (!this.#disposed && !this.workspaceTrust.reloadRequired && this.#records.size === 0) {
			await this.newChat();
		}
		this.#emit();
		await this.#persist();
		if (closeFailure) throw new Error(closeFailure);
	}

	public async send(chatId: string, text: string, contextIds: readonly string[]): Promise<void> {
		const record = this.#requireRecord(chatId);
		const normalized = text.trim();
		if (!normalized) return;
		record.toolTracker.reset();
		record.activityFocus = taskFocusFromUserText(normalized);
		const attached = await this.contextStore.resolveForPrompt(contextIds);
		const visibleContexts = this.contextStore.items.filter((item) => contextIds.includes(item.id));
		record.messages.push({
			id: randomUUID(),
			role: "user",
			text: normalized,
			timestamp: Date.now(),
			contexts: visibleContexts.map((item) => ({
				id: item.id,
				label: item.label,
				kind: item.kind,
			})),
		});
		this.#boundMessages(record);
		const autoTitles = vscode.workspace
			.getConfiguration("piAgent.appearance")
			.get<boolean>("autoGenerateTitles", true);
		if (autoTitles && !record.manualTitle && record.title === "New chat") {
			record.title = createFallbackTitle(normalized);
			void record.controller
				.setTitle(record.title)
				.catch((error) => this.#log("Could not save the generated chat title.", error));
		}
		record.phase = "running";
		record.progress = summarizeSessionActivity("running", record.activityFocus);
		this.#emit();
		const prompt = createPiPrompt(normalized, attached);
		try {
			await record.controller.send({ text: prompt });
		} catch (error) {
			record.phase = "error";
			record.progress = "依頼を開始できませんでした";
			record.messages.push({
				id: randomUUID(),
				role: "error",
				text: safeErrorMessage(error, "Pi could not start this request."),
				timestamp: Date.now(),
				retryable: true,
			});
			this.#boundMessages(record);
			this.#emit();
		}
		await this.#persist();
	}

	public async stop(chatId = this.#activeChatId): Promise<void> {
		const record = this.#requireRecord(chatId);
		const sessionId = record.controller.sessionId;
		if (sessionId) {
			this.authorization.cancelPendingForSession(
				sessionId,
				"The user stopped the chat before approving this tool request.",
			);
		}
		await record.controller.abort();
		this.#settleTurnTools(record, "final");
		this.#boundMessages(record);
		record.phase = "idle";
		record.progress = "ユーザーが作業を停止しました";
		this.#emit();
	}

	public async invokeCommand(
		chatId: string,
		invocation: string,
		args: string,
	): Promise<"model" | "done"> {
		const record = this.#requireRecord(chatId);
		const normalized = invocation.startsWith("/") ? invocation.slice(1) : invocation;
		if (normalized === "new") {
			await this.newChat();
		} else if (normalized === "model") {
			return "model";
		} else if (normalized === "stop") {
			await this.stop(chatId);
		} else if (normalized === "title") {
			await this.renameChat(chatId, args || record.title);
		} else if (normalized === "compact") {
			this.#assertIdle(record, "compact context");
			await record.controller.compact(args || undefined);
		} else if (normalized === "help") {
			record.messages.push({
				id: randomUUID(),
				role: "system",
				text: record.commands
					.map((command) => `- **${command.invocation}** — ${command.description}`)
					.join("\n"),
				timestamp: Date.now(),
			});
			this.#boundMessages(record);
		} else {
			await record.controller.invokeCommand(normalized, args || undefined);
		}
		this.#emit();
		return "done";
	}

	public async renameChat(chatId: string, title: string): Promise<boolean> {
		const record = this.#requireRecord(chatId);
		const renamed = renameChatTitle(
			{
				value: record.title,
				source: record.manualTitle ? "manual" : "generated",
				renameLocked: record.manualTitle,
			},
			title,
		);
		if (!renamed.ok) {
			fireAndReport(
				vscode.window.showWarningMessage(renamed.message),
				(message, error) => this.#log(message, error),
				"Could not show the invalid-title warning.",
			);
			return false;
		}
		await commitChatTitle(record, { title: renamed.state.value, manualTitle: true }, (title) =>
			record.controller.setTitle(title),
		);
		this.#emit();
		await this.#persist();
		return true;
	}

	public async regenerateTitle(chatId: string): Promise<void> {
		const record = this.#requireRecord(chatId);
		const firstPrompt =
			record.messages.find((message) => message.role === "user")?.text ?? "New chat";
		await commitChatTitle(
			record,
			{ title: createFallbackTitle(firstPrompt), manualTitle: false },
			(title) => record.controller.setTitle(title),
		);
		this.#emit();
		await this.#persist();
	}

	public setApprovalMode(chatId: string, mode: ApprovalMode): void {
		const record = this.#requireRecord(chatId);
		this.#assertIdle(record, "change approval mode");
		if (!this.workspaceTrust.trusted && mode !== "plan") {
			throw new Error("Trust this workspace before enabling a mode that can change or run code.");
		}
		record.approvalMode = mode;
		const sessionId = record.controller.sessionId;
		if (sessionId) this.authorization.setMode(sessionId, record.approvalMode);
		this.#emit();
		void this.#persist();
	}

	public resolveApproval(id: string, decision: "deny" | "allowOnce" | "allowSession"): boolean {
		const request = this.#approvalRequests.get(id);
		if (!request) return false;
		const resolved = this.authorization.resolve(id, request.chatId, decision);
		if (resolved) {
			this.#removeApproval(id);
			const record = this.#records.get(request.chatId);
			if (record) {
				const hasMore = this.#approvalOrderByChat.get(request.chatId)?.length;
				record.phase = hasMore ? "waitingApproval" : decision === "deny" ? "idle" : "running";
				if (!hasMore && decision === "deny") this.#settleTurnTools(record, "final");
				if (!hasMore && decision !== "deny") this.#restoreTurnTools(record);
				record.progress = hasMore
					? "操作の確認を待っています"
					: decision === "deny"
						? "操作は許可されませんでした"
						: summarizeSessionActivity("running", record.activityFocus);
			}
		}
		this.#emit();
		return resolved;
	}

	public async loadModels(): Promise<void> {
		const generation = this.#modelLoad.begin();
		const active = this.#records.get(this.#activeChatId);
		if (active) active.model = { ...active.model, loading: true };
		this.#emit();
		try {
			const catalog = await (active?.controller.models() ?? this.host.listModels());
			if (!this.#modelLoad.isCurrent(generation)) return;
			this.#modelOptions = modelOptionsFromCatalog(catalog);
			for (const record of this.#records.values()) {
				record.model = { ...record.model, options: [...this.#modelOptions], loading: false };
			}
		} catch (error) {
			if (!this.#modelLoad.isCurrent(generation)) return;
			for (const record of this.#records.values()) {
				record.model = { ...record.model, loading: false };
			}
			if (active)
				active.model = {
					...active.model,
					loading: false,
					authError: safeErrorMessage(error, "Models unavailable"),
				};
		}
		this.#emit();
	}

	public async configureProvider(provider: string, apiKey: string): Promise<void> {
		await this.host.setRuntimeApiKey(provider, apiKey);
		await this.loadModels();
	}

	public async removeProviderCredential(provider: string): Promise<void> {
		await this.host.removeRuntimeApiKey(provider);
		await this.loadModels();
	}

	public async setModel(chatId: string, provider: string, modelId: string): Promise<void> {
		const record = this.#requireRecord(chatId);
		this.#assertIdle(record, "change model");
		const snapshot = await record.controller.setModel({ provider, id: modelId });
		record.model = modelStateFromSnapshot(snapshot, this.#modelOptions);
		record.usage = usageFromSnapshot(snapshot);
		record.messages.push({
			id: randomUUID(),
			role: "system",
			text: `Model changed to ${snapshot.model?.name ?? modelId} · ${snapshot.thinkingLevel} reasoning`,
			timestamp: Date.now(),
		});
		this.#boundMessages(record);
		this.#emit();
		await this.#persist();
	}

	public async setThinking(chatId: string, level: PiThinkingLevel): Promise<void> {
		const record = this.#requireRecord(chatId);
		this.#assertIdle(record, "change reasoning level");
		const snapshot = await record.controller.setThinking(level);
		record.model = modelStateFromSnapshot(snapshot, this.#modelOptions);
		this.#emit();
		await this.#persist();
	}

	public async saveModelDefault(chatId: string): Promise<void> {
		const record = this.#requireRecord(chatId);
		this.#assertIdle(record, "save model defaults");
		if (!record.model.provider || !record.model.id) {
			throw new Error("Choose a model before saving a default.");
		}
		const snapshot = await record.controller.setModel(
			{ provider: record.model.provider, id: record.model.id },
			true,
		);
		await record.controller.setThinking(snapshot.thinkingLevel, true);
		record.model = modelStateFromSnapshot(snapshot, this.#modelOptions);
		this.#emit();
		await this.#persist();
	}

	public async chooseModel(chatId: string): Promise<void> {
		await this.loadModels();
		const selected = await vscode.window.showQuickPick(
			this.#modelOptions.map((model) => ({
				label: model.name,
				description: `${model.provider} · ${model.id}`,
				...(model.contextWindow
					? { detail: `${model.contextWindow.toLocaleString()} token context` }
					: {}),
				model,
			})),
			{ placeHolder: "Choose a model for this Pi Agent chat", matchOnDescription: true },
		);
		if (selected) await this.setModel(chatId, selected.model.provider, selected.model.id);
	}

	public async retryMessage(messageId: string): Promise<void> {
		const record = this.#requireRecord(this.#activeChatId);
		const failedIndex = record.messages.findIndex((message) => message.id === messageId);
		const before = failedIndex >= 0 ? record.messages.slice(0, failedIndex) : record.messages;
		const prior = [...before].reverse().find((message) => message.role === "user");
		if (!prior) throw new Error("There is no user prompt to retry.");
		await this.send(record.id, prior.text, prior.contexts?.map((context) => context.id) ?? []);
	}

	public async compact(chatId: string): Promise<void> {
		const record = this.#requireRecord(chatId);
		this.#assertIdle(record, "compact context");
		record.progress = summarizeSessionActivity("compacting", record.activityFocus);
		this.#emit();
		await record.controller.compact();
	}

	public async searchFiles(query: string): Promise<void> {
		const generation = this.#fileSearch.begin();
		this.#fileSuggestions = [];
		this.#fileSuggestionIndex.clear();
		this.#emit();
		const normalized = query.trim();
		const pattern = normalized ? `**/*${normalized.replace(/[[\]{}*?]/gu, "")}*` : "**/*";
		const uris = await vscode.workspace.findFiles(pattern, "**/{.git,node_modules,dist}/**", 40);
		if (!this.#fileSearch.isCurrent(generation)) return;
		this.#fileSuggestions = this.#fileSuggestionIndex.replace(
			uris.map((uri) => {
				const folder = vscode.workspace.getWorkspaceFolder(uri);
				const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
				return {
					suggestion: {
						id: randomUUID(),
						// VS Code prepends the root name only when the workspace is multi-root.
						label: vscode.workspace.asRelativePath(uri).slice(0, 512),
						...(folder && multiRoot
							? { description: `Workspace: ${folder.name}`.slice(0, 2_048) }
							: {}),
						kind: "file" as const,
					},
					target: uri,
				};
			}),
		);
		this.#emit();
	}

	public async addSuggestedContext(id: string): Promise<void> {
		const target = this.#fileSuggestionIndex.resolve(id);
		if (!target) return;
		await vscode.workspace.fs.stat(target);
		await this.contextStore.addUris([target]);
	}

	public async showHistory(): Promise<void> {
		const openChoices = [...this.#records.values()].map((record) => ({
			label: record.title,
			description: `${record.phase === "idle" ? "Ready" : record.progress}`,
			detail: record.sessionFile ? "Open tab · persisted Pi session" : "Open tab",
			target: { kind: "open" as const, chatId: record.id },
		}));
		let closedChoices: Array<{
			label: string;
			description: string;
			detail: string;
			target: { readonly kind: "file"; readonly path: string; readonly title: string };
		}> = [];
		try {
			const sessions = await this.host.listSessions(this.#workspaceCwd());
			const openFiles = new Set(
				[...this.#records.values()].flatMap((record) =>
					record.sessionFile ? [resolve(record.sessionFile)] : [],
				),
			);
			closedChoices = sessions
				.filter((session) => !openFiles.has(resolve(session.path)))
				.slice(0, 200)
				.map((session) => {
					const title =
						session.title || createFallbackTitle(session.firstMessage || "Restored chat");
					return {
						label: title,
						description: new Date(session.modifiedAt).toLocaleString(),
						detail: `${session.messageCount} messages · persisted Pi session`,
						target: { kind: "file" as const, path: session.path, title },
					};
				});
		} catch (error) {
			this.#log("Could not load persisted Pi chat history.", error);
		}
		const selected = await vscode.window.showQuickPick([...openChoices, ...closedChoices], {
			placeHolder: "Choose an open or persisted Pi Agent chat",
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!selected) return;
		if (selected.target.kind === "open") {
			this.selectChat(selected.target.chatId);
			return;
		}
		const record = await this.#createRecord(
			{
				id: randomUUID(),
				title: selected.target.title,
				manualTitle: false,
				approvalMode: defaultMode(),
				sessionFile: selected.target.path,
			},
			{ kind: "file", path: selected.target.path },
		);
		this.selectChat(record.id);
		await this.#persist();
	}

	public setDesign(design: ViewDesign, scope: "global" | "workspace"): void {
		this.#design = design;
		this.#designScope = scope;
		this.#emit();
	}

	async #createRecord(
		tab: PersistedTab,
		target: { readonly kind: "new" } | { readonly kind: "file"; readonly path: string },
	): Promise<ChatRecord> {
		if (this.#records.has(tab.id)) throw new Error("This Pi Agent chat is already open.");
		this.#assertCanOpenChat();
		const controller = new ChatSessionController(this.host, (message, error) =>
			this.#log(message, error),
		);
		const record: ChatRecord = {
			id: tab.id,
			controller,
			subscription: { dispose() {} },
			title: tab.title,
			manualTitle: tab.manualTitle,
			phase: "running",
			progress: "Pi Agent を準備しています",
			activityFocus: "ご依頼",
			unread: false,
			messages: [],
			commands: [...HOST_COMMANDS],
			approvalMode: this.workspaceTrust.trusted ? tab.approvalMode : "plan",
			usage: EMPTY_USAGE,
			model: {
				name: "Loading model…",
				thinking: "off",
				options: [...this.#modelOptions],
				loading: true,
			},
			currentAssistantId: undefined,
			toolTracker: new TurnToolTracker(),
			proposedEdits: [],
			editCapture: new ToolEditCapture(this.edits),
			...(tab.sessionFile ? { sessionFile: tab.sessionFile } : {}),
		};
		const subscription = controller.onEvent((event) => this.#handlePiEvent(record, event));
		record.subscription = subscription;
		this.#records.set(record.id, record);
		try {
			const bootstrap = await controller.open({ cwd: this.#workspaceCwd(), target });
			this.#applyBootstrap(record, bootstrap);
			if (controller.sessionId)
				this.authorization.register(controller.sessionId, record.id, record.approvalMode);
			if (
				tab.model &&
				(bootstrap.snapshot.model?.provider !== tab.model.provider ||
					bootstrap.snapshot.model?.id !== tab.model.id)
			) {
				try {
					this.#applySessionSnapshot(record, await controller.setModel(tab.model));
				} catch (error) {
					this.#log("Could not restore this chat's model selection.", error);
				}
			}
			if (tab.thinking && record.model.thinking !== tab.thinking) {
				try {
					this.#applySessionSnapshot(record, await controller.setThinking(tab.thinking));
				} catch (error) {
					this.#log("Could not restore this chat's reasoning level.", error);
				}
			}
		} catch (error) {
			record.phase = "error";
			record.progress = "Pi Agent を開始できませんでした";
			record.messages.push({
				id: randomUUID(),
				role: "error",
				text: safeErrorMessage(error, "Pi Agent could not restore this chat."),
				timestamp: Date.now(),
				retryable: false,
			});
			this.#boundMessages(record);
		}
		return record;
	}

	#applyBootstrap(record: ChatRecord, bootstrap: PiSessionBootstrapDto): void {
		this.#applySessionSnapshot(record, bootstrap.snapshot);
		record.toolTracker.reset();
		record.messages = bootstrap.history.map((message, index) =>
			this.#chatMessage(record, message, `history-${index}`),
		);
		this.#boundMessages(record);
		const latestUserMessage = [...record.messages]
			.reverse()
			.find((message) => message.role === "user");
		record.activityFocus = taskFocusFromUserText(latestUserMessage?.text ?? "");
		record.commands = mergeCommandSuggestions(HOST_COMMANDS, bootstrap.commands);
		record.phase = bootstrap.snapshot.busy ? "running" : "idle";
		record.progress = summarizeSnapshotActivity(bootstrap.snapshot, record.activityFocus);
	}

	#applySessionSnapshot(record: ChatRecord, snapshot: PiSessionSnapshotDto): void {
		record.usage = usageFromSnapshot(snapshot);
		record.model = modelStateFromSnapshot(snapshot, this.#modelOptions);
		record.phase = snapshot.busy ? "running" : "idle";
		record.progress = summarizeSnapshotActivity(snapshot, record.activityFocus);
		if (snapshot.title && !record.manualTitle) record.title = snapshot.title;
		if (snapshot.sessionFile) record.sessionFile = snapshot.sessionFile;
	}

	#handlePiEvent(record: ChatRecord, event: PiHostEvent): void {
		let messagesChanged = false;
		const toolTransition = turnToolTransitionForEvent(event, record.phase);
		if (toolTransition.restore) this.#restoreTurnTools(record);
		if (event.type === "session.bootstrap") {
			this.#applyBootstrap(record, event.bootstrap);
		} else if (event.type === "session.snapshot") {
			this.#applySessionSnapshot(record, event.snapshot);
		} else if (event.type === "session.state") {
			record.phase = event.busy ? "running" : "idle";
			record.progress = summarizeSessionActivity(event.phase, record.activityFocus);
		} else if (event.type === "session.stats") {
			const current = record.controller.snapshot;
			if (current) record.usage = usageFromSnapshot({ ...current, stats: event.stats });
		} else if (event.type === "session.title" && event.title && !record.manualTitle) {
			record.title = event.title;
		} else if (event.type === "session.commands") {
			record.commands = mergeCommandSuggestions(HOST_COMMANDS, event.commands);
		} else if (event.type === "session.error") {
			record.phase = "error";
			record.progress = "作業中に問題が発生しました";
			record.messages.push({
				id: randomUUID(),
				role: "error",
				text: safeErrorMessage(event.error.message, "Pi Agent encountered an error."),
				timestamp: Date.now(),
				retryable: event.error.recoverable,
			});
			messagesChanged = true;
		} else if (event.type === "session.closed") {
			record.phase = "error";
			record.progress = "セッションが終了しました";
			record.messages.push({
				id: randomUUID(),
				role: "system",
				text: "This Pi session closed. Start a new chat or reopen it from history to continue.",
				timestamp: Date.now(),
			});
			messagesChanged = true;
			for (const approvalId of this.#approvalOrderByChat.get(record.id) ?? []) {
				this.#approvalRequests.delete(approvalId);
			}
			this.#approvalOrderByChat.delete(record.id);
		} else if (event.type === "message.start") {
			if (event.message.role === "assistant") {
				record.proposedEdits = [];
				record.editCapture.clear();
				record.currentAssistantId = randomUUID();
				record.messages.push(
					this.#chatMessage(record, event.message, record.currentAssistantId, true),
				);
				messagesChanged = true;
				record.phase = "running";
			}
		} else if (event.type === "message.update") {
			const id = record.currentAssistantId ?? randomUUID();
			record.currentAssistantId = id;
			let message = record.messages.find((item) => item.id === id);
			if (!message) {
				message = this.#chatMessage(record, event.message, id, true);
				record.messages.push(message);
				messagesChanged = true;
			}
			if (event.delta.kind === "text" && event.delta.text) {
				const index = record.messages.findIndex((item) => item.id === id);
				record.messages[index] = boundChatMessage({
					...message,
					text: message.text + event.delta.text,
					streaming: true,
				});
			}
			record.phase = "running";
			record.progress = summarizeStreamActivity(event.delta, record.activityFocus);
		} else if (event.type === "message.end" && event.message.role === "assistant") {
			const id = record.currentAssistantId;
			const existingIndex = id ? record.messages.findIndex((message) => message.id === id) : -1;
			const existing = existingIndex >= 0 ? record.messages[existingIndex] : undefined;
			const finalMessage = this.#chatMessage(record, event.message, id ?? randomUUID(), false);
			const final = existing?.tools ? { ...finalMessage, tools: existing.tools } : finalMessage;
			if (existingIndex >= 0) record.messages[existingIndex] = final;
			else record.messages.push(final);
			record.currentAssistantId = undefined;
			messagesChanged = true;
		} else if (
			event.type === "tool.start" ||
			event.type === "tool.update" ||
			event.type === "tool.end"
		) {
			const phase: ToolItem["phase"] =
				event.type === "tool.end" ? (event.tool.isError ? "error" : "success") : "running";
			const priorTool = record.toolTracker.get(event.tool.toolCallId);
			const detail =
				stringToolArgument(event.tool.args, "path") ??
				stringToolArgument(event.tool.args, "command") ??
				priorTool?.detail;
			const item: ToolItem = {
				id: event.tool.toolCallId,
				label: event.tool.toolName,
				...(detail ? { detail } : {}),
				phase,
			};
			this.#attachLiveTool(record, item);
			if (
				event.type === "tool.start" &&
				(event.tool.toolName === "edit" || event.tool.toolName === "write")
			) {
				record.editCapture.begin(event.tool, this.#workspaceCwd());
			}
			if (event.type === "tool.end") {
				this.#captureEditEnd(record, event.tool);
				messagesChanged = true;
			}
			record.progress = summarizeToolActivity(
				event.tool,
				record.activityFocus,
				event.type === "tool.start" ? "start" : event.type === "tool.update" ? "update" : "end",
			);
		} else if (event.type === "lifecycle") {
			if (event.name === "agent.settled") {
				record.phase = "idle";
				record.progress = "待機中";
				record.editCapture.clear();
				if (record.id !== this.#activeChatId) record.unread = true;
				void this.#persist();
			} else if (event.name === "compaction.start") {
				record.phase = "running";
				record.progress = summarizeSessionActivity("compacting", record.activityFocus);
			} else if (event.name === "retry.start") {
				record.phase = "running";
				record.progress = summarizeSessionActivity("retrying", record.activityFocus);
			}
		}
		if (toolTransition.settle) {
			this.#settleTurnTools(record, toolTransition.settle);
			messagesChanged = true;
		}
		if (messagesChanged) this.#boundMessages(record);
		this.#emit();
	}

	#chatMessage(
		record: ChatRecord,
		message: PiMessageDto,
		id: string,
		streaming = false,
	): ChatMessage {
		const text = textFromPiMessage(message) || message.errorMessage || "";
		const role: ChatMessage["role"] =
			message.role === "user"
				? "user"
				: message.role === "assistant"
					? "assistant"
					: message.isError
						? "error"
						: "system";
		return refreshMessageReferences(
			{
				id,
				role,
				text,
				timestamp: message.timestamp ?? Date.now(),
				...(streaming ? { streaming: true } : {}),
				...(role === "assistant" && record.proposedEdits.length > 0
					? { edits: record.proposedEdits }
					: {}),
				...(role === "error" ? { retryable: true } : {}),
			},
			this.references,
			this.#referenceCache,
		);
	}

	#handleApproval(prompt: ToolApprovalPrompt): void {
		const record = this.#records.get(prompt.chatId);
		if (!record) return;
		this.#restoreTurnTools(record);
		record.phase = "waitingApproval";
		record.progress = "操作の確認を待っています";
		record.unread = record.id !== this.#activeChatId;
		const request: ApprovalRequest = {
			id: prompt.id,
			chatId: prompt.chatId,
			capability: prompt.capability,
			title: prompt.title,
			detail: prompt.detail,
			risk: prompt.risk,
			...(prompt.command ? { command: prompt.command } : {}),
			cwd: prompt.cwd,
			...(prompt.targets ? { targets: [...prompt.targets] } : {}),
		};
		this.#approvalRequests.set(prompt.id, request);
		const order = this.#approvalOrderByChat.get(prompt.chatId) ?? [];
		if (!order.includes(prompt.id)) order.push(prompt.id);
		this.#approvalOrderByChat.set(prompt.chatId, order);
		this.#emit();
	}

	#activeApproval(
		chatId: string,
	): { readonly approvalRequest: ApprovalRequest } | Record<string, never> {
		const id = this.#approvalOrderByChat.get(chatId)?.[0];
		const approvalRequest = id ? this.#approvalRequests.get(id) : undefined;
		return approvalRequest ? { approvalRequest } : {};
	}

	#removeApproval(id: string): void {
		const request = this.#approvalRequests.get(id);
		if (!request) return;
		this.#approvalRequests.delete(id);
		const order =
			this.#approvalOrderByChat.get(request.chatId)?.filter((candidate) => candidate !== id) ?? [];
		if (order.length > 0) {
			this.#approvalOrderByChat.set(request.chatId, order);
		} else {
			this.#approvalOrderByChat.delete(request.chatId);
		}
		const record = this.#records.get(request.chatId);
		if (record?.phase === "waitingApproval" && order.length === 0) {
			record.phase = record.controller.snapshot?.busy ? "running" : "idle";
			record.progress =
				record.phase === "running"
					? summarizeSessionActivity("running", record.activityFocus)
					: "待機中";
		}
	}

	#restoreTurnTools(record: ChatRecord): void {
		record.messages = record.toolTracker.restore(record.messages);
	}

	#attachLiveTool(record: ChatRecord, item: ToolItem): void {
		record.messages = record.toolTracker.attach(record.messages, item);
	}

	#settleTurnTools(record: ChatRecord, kind: TurnToolSettlement): void {
		record.messages = record.toolTracker.settle(record.messages, kind);
	}

	#captureEditEnd(record: ChatRecord, tool: PiToolEventDto): void {
		const edit = record.editCapture.finish(tool);
		if (!edit) return;
		record.proposedEdits.push(edit);
		const assistantId = record.currentAssistantId;
		const index = assistantId
			? record.messages.findIndex((message) => message.id === assistantId)
			: -1;
		if (index >= 0) {
			const message = record.messages[index];
			if (message) record.messages[index] = { ...message, edits: [...record.proposedEdits] };
		}
	}

	#removeEditReference(id: string): void {
		let changed = false;
		for (const record of this.#records.values()) {
			const retained = record.proposedEdits.filter((edit) => edit.id !== id);
			if (retained.length !== record.proposedEdits.length) {
				record.proposedEdits = retained;
				changed = true;
			}
			record.messages = record.messages.map((message) => {
				if (!message.edits?.some((edit) => edit.id === id)) return message;
				changed = true;
				const edits = message.edits.filter((edit) => edit.id !== id);
				const { edits: _removed, ...withoutEdits } = message;
				return edits.length > 0 ? { ...withoutEdits, edits } : withoutEdits;
			});
		}
		if (changed) this.#emit();
	}

	#boundMessages(record: ChatRecord): void {
		record.messages = boundChatHistory(record.messages, record.currentAssistantId);
	}

	#tab(record: ChatRecord): ChatTab {
		return {
			id: record.id,
			title: record.title,
			phase: record.phase,
			progress: record.progress,
			unread: record.unread,
			manualTitle: record.manualTitle,
		};
	}

	#markViewed(chatId: string): void {
		const record = this.#records.get(chatId);
		if (record) record.unread = false;
	}

	#workspaceCwd(): string {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (folder?.uri.scheme !== "file") {
			throw new Error("Pi Agent requires a local filesystem workspace.");
		}
		return folder.uri.fsPath;
	}

	#assertIdle(record: ChatRecord, action: string): void {
		if (
			record.phase === "running" ||
			record.phase === "waitingApproval" ||
			record.controller.snapshot?.busy
		) {
			throw new Error(`Stop or wait for this chat before you ${action}.`);
		}
	}

	#assertCanOpenChat(): void {
		if (this.workspaceTrust.reloadRequired) {
			throw new Error(
				"Reload this VS Code window before opening another Pi Agent chat after changing Workspace Trust.",
			);
		}
		if (this.#records.size >= MAX_OPEN_CHATS) {
			throw new Error(`Close a chat before opening more than ${MAX_OPEN_CHATS} Pi Agent chats.`);
		}
	}

	#requireRecord(chatId: string): ChatRecord {
		const record = this.#records.get(chatId);
		if (!record) throw new Error("This chat is no longer available.");
		return record;
	}

	#emit(): void {
		if (!this.#disposed) this.#onDidChange.fire();
	}

	#log(message: string, error?: unknown): void {
		this.output.appendLine(
			`[${new Date().toISOString()}] ${message}${error instanceof Error ? ` (${error.name})` : ""}`,
		);
	}

	#persist(): Promise<void> {
		this.#pendingPersistedState = this.#capturePersistedState();
		return this.#persistTask.request();
	}

	async #writePersistedState(): Promise<void> {
		const value = this.#pendingPersistedState;
		if (!value) return;
		await this.extensionContext.workspaceState.update("piAgent.workspace", value);
	}

	#capturePersistedState(): PersistedWorkspace {
		return {
			version: 1,
			...(this.#activeChatId ? { activeChatId: this.#activeChatId } : {}),
			tabs: [...this.#records.values()].map((record) => ({
				id: record.id,
				title: record.title,
				manualTitle: record.manualTitle,
				...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
				approvalMode: record.approvalMode === "fullAccess" ? "ask" : record.approvalMode,
				...(record.model.provider && record.model.id
					? { model: { provider: record.model.provider, id: record.model.id } }
					: {}),
				thinking: record.model.thinking,
			})),
		};
	}

	public dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#fileSearch.invalidate();
		this.#fileSuggestionIndex.clear();
		this.#modelLoad.invalidate();
		// Preserve the latest in-memory state on shutdown. CoalescedTask owns and
		// reports storage failures, so this best-effort flush cannot become an
		// unhandled rejection after VS Code releases the synchronous Disposable.
		void this.#persist();
		for (const record of this.#records.values()) {
			record.subscription.dispose();
			record.controller.dispose();
		}
		this.#records.clear();
		for (const subscription of this.#subscriptions) subscription.dispose();
		this.#onDidChange.dispose();
	}
}
