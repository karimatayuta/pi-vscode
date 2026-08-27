import * as vscode from "vscode";
import { APPROVAL_MODE_LABELS } from "../../shared/approval.js";
import {
	type HostToWebviewMessage,
	validateAppSnapshot,
	validateHostToWebviewMessage,
	validateWebviewToHostMessage,
	type WebviewToHostMessage,
} from "../../shared/protocol.js";
import { fireAndReport } from "../async/fire-and-report.js";
import type { ContextStore } from "../context/context-store.js";
import type { ProposedEditStore } from "../edits/proposed-edit-store.js";
import { OPAQUE_REFERENCE_REFRESH_INTERVAL_MS } from "../links/opaque-reference-store.js";
import type { ReferenceRegistry } from "../links/reference-registry.js";
import type { ToolAuthorizationRouter } from "../permissions/tool-authorization-router.js";
import { safeErrorMessage } from "../pi/sanitize.js";
import {
	sanitizeStoredProviderIds,
	updateProviderCredential,
} from "../settings/provider-credentials.js";
import type { ViewDesignStore } from "../settings/view-design-store.js";
import type { ChatWorkspaceModel } from "./chat-workspace-model.js";
import { CoalescedTask } from "./coalesced-task.js";
import { snapshotPriorityForIntent } from "./snapshot-priority.js";
import { createWebviewHtml } from "./webview-html.js";

const MAX_REPLAY_IDS = 4_096;
type HostIntent = HostToWebviewMessage extends infer Message
	? Message extends unknown
		? Omit<Message, "protocolVersion" | "requestId">
		: never
	: never;

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	readonly #subscriptions: vscode.Disposable[] = [];
	readonly #requestIds = new Set<string>();
	readonly #snapshotTask: CoalescedTask;
	#viewSubscriptions: vscode.Disposable[] = [];
	#view: vscode.WebviewView | undefined;
	#postSequence = 0;
	#snapshotTimer: ReturnType<typeof setTimeout> | undefined;
	#referenceRefreshTimer: ReturnType<typeof setTimeout> | undefined;

	public constructor(
		private readonly extensionContext: vscode.ExtensionContext,
		private readonly model: ChatWorkspaceModel,
		private readonly contextStore: ContextStore,
		private readonly authorization: ToolAuthorizationRouter,
		private readonly references: ReferenceRegistry,
		private readonly edits: ProposedEditStore,
		private readonly designs: ViewDesignStore,
		private readonly log: (message: string, error?: unknown) => void = () => undefined,
	) {
		this.#snapshotTask = new CoalescedTask(
			() => this.#postSnapshot(),
			(error) => this.log("Could not update the Pi Agent webview snapshot.", error),
		);
		this.#subscriptions.push(model.onDidChange(() => this.scheduleSnapshot()));
	}

	public resolveWebviewView(view: vscode.WebviewView): void {
		this.#disposeViewSubscriptions();
		if (this.#referenceRefreshTimer) clearTimeout(this.#referenceRefreshTimer);
		this.#view = view;
		this.#requestIds.clear();
		this.references.invalidate();
		view.webview.options = {
			enableScripts: true,
			enableCommandUris: false,
			enableForms: false,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionContext.extensionUri, "dist", "webview"),
			],
		};
		view.webview.html = createWebviewHtml(view.webview, this.extensionContext.extensionUri);
		const viewSubscriptions: vscode.Disposable[] = [];
		const messageSubscription = view.webview.onDidReceiveMessage((input: unknown) => {
			fireAndReport(
				this.#receive(input),
				this.log,
				"Could not process a Pi Agent webview message.",
			);
		});
		const visibilitySubscription = view.onDidChangeVisibility(() => {
			if (view.visible) this.scheduleSnapshot(true);
		});
		const disposeSubscription = view.onDidDispose(() => {
			if (this.#viewSubscriptions === viewSubscriptions) this.#disposeViewSubscriptions();
			if (this.#view !== view) return;
			if (this.#referenceRefreshTimer) clearTimeout(this.#referenceRefreshTimer);
			this.#referenceRefreshTimer = undefined;
			this.#view = undefined;
			this.#requestIds.clear();
			this.references.invalidate();
		});
		viewSubscriptions.push(messageSubscription, visibilitySubscription, disposeSubscription);
		this.#viewSubscriptions = viewSubscriptions;
	}

	public focusComposer(): void {
		fireAndReport(
			this.#post({ type: "focusComposer" }),
			this.log,
			"Could not focus the Pi Agent prompt.",
		);
	}

	public scheduleSnapshot(immediate = false): void {
		if (immediate) {
			if (this.#snapshotTimer) clearTimeout(this.#snapshotTimer);
			this.#snapshotTimer = undefined;
			void this.#snapshotTask.request();
			return;
		}
		// A fixed window keeps continuous model events live instead of postponing the
		// Webview indefinitely as a reset-on-every-event debounce would.
		if (this.#snapshotTimer) return;
		this.#snapshotTimer = setTimeout(() => {
			this.#snapshotTimer = undefined;
			void this.#snapshotTask.request();
		}, 33);
	}

	public notice(level: "info" | "warning" | "error", message: string): void {
		fireAndReport(
			this.#post({ type: "notice", level, message: message.slice(0, 8_192) }),
			this.log,
			"Could not show a Pi Agent notice.",
		);
	}

	public async configureProvider(provider?: string): Promise<void> {
		await this.#configureProvider(provider);
	}

	async #postSnapshot(): Promise<void> {
		const view = this.#view;
		if (!view) return;
		const snapshot = this.model.snapshot();
		const validation = validateAppSnapshot(snapshot);
		if (!validation.ok) {
			this.notice("error", "Pi Agent could not render an invalid session snapshot.");
			return;
		}
		await this.#post({ type: "snapshot", snapshot: validation.message }, view);
		if (this.#view !== view) return;
		this.#scheduleReferenceRefresh();
		const runningCount = snapshot.tabs.filter(
			(tab) => tab.phase === "running" || tab.phase === "waitingApproval",
		).length;
		view.badge =
			runningCount > 0
				? {
						value: runningCount,
						tooltip: `${runningCount} Pi Agent chat${runningCount === 1 ? "" : "s"} active`,
					}
				: undefined;
		const running = runningCount > 0;
		await vscode.commands.executeCommand("setContext", "piAgent.isRunning", running);
		await vscode.commands.executeCommand(
			"setContext",
			"piAgent.hasContext",
			snapshot.context.length > 0,
		);
	}

	#scheduleReferenceRefresh(): void {
		if (this.#referenceRefreshTimer) clearTimeout(this.#referenceRefreshTimer);
		this.#referenceRefreshTimer = undefined;
		if (!this.#view?.visible) return;
		this.#referenceRefreshTimer = setTimeout(() => {
			this.#referenceRefreshTimer = undefined;
			void this.#snapshotTask.request();
		}, OPAQUE_REFERENCE_REFRESH_INTERVAL_MS);
	}

	async #post(message: HostIntent, targetView = this.#view): Promise<void> {
		const view = targetView;
		if (!view || this.#view !== view) return;
		this.#postSequence += 1;
		const envelope = {
			protocolVersion: 1 as const,
			requestId: `host-${Date.now().toString(36)}-${this.#postSequence.toString(36)}`,
			...message,
		};
		const validation = validateHostToWebviewMessage(envelope);
		if (!validation.ok) return;
		await view.webview.postMessage(validation.message);
	}

	async #receive(input: unknown): Promise<void> {
		const validation = validateWebviewToHostMessage(input);
		if (!validation.ok) {
			this.notice("warning", "Pi Agent ignored an invalid webview message.");
			return;
		}
		const message = validation.message;
		if (this.#requestIds.has(message.requestId)) {
			this.notice("warning", "Pi Agent ignored a repeated webview request.");
			return;
		}
		this.#requestIds.add(message.requestId);
		if (this.#requestIds.size > MAX_REPLAY_IDS) {
			const first = this.#requestIds.values().next().value;
			if (first) this.#requestIds.delete(first);
		}
		try {
			await this.#dispatch(message);
		} catch (error) {
			this.notice("error", safeErrorMessage(error, "Pi Agent could not complete that action."));
		}
	}

	async #dispatch(message: WebviewToHostMessage): Promise<void> {
		switch (message.type) {
			case "ready":
				this.scheduleSnapshot(true);
				return;
			case "newChat":
				await this.model.newChat();
				break;
			case "showHistory":
				await this.model.showHistory();
				break;
			case "selectChat":
				this.model.selectChat(message.chatId);
				break;
			case "closeChat":
				await this.model.closeChat(message.chatId);
				break;
			case "renameChat":
				await this.model.renameChat(message.chatId, message.title);
				break;
			case "regenerateTitle":
				await this.model.regenerateTitle(message.chatId);
				break;
			case "sendPrompt":
				await this.model.send(message.chatId, message.text, message.contextIds);
				break;
			case "stop":
				await this.model.stop(message.chatId);
				break;
			case "removeContext":
				this.contextStore.remove(message.id);
				break;
			case "pickContext":
				await this.#pickContext(message.kind);
				break;
			case "dropContext":
				await this.#addDroppedUris(message.uris);
				break;
			case "addCurrentFile":
				await this.#addCurrentFile();
				break;
			case "addCurrentSelection":
				this.#addCurrentSelection();
				break;
			case "searchFiles":
				await this.model.searchFiles(message.query);
				break;
			case "addSuggestedContext":
				await this.model.addSuggestedContext(message.suggestionId);
				break;
			case "invokeCommand": {
				const result = await this.model.invokeCommand(
					message.chatId,
					message.invocation,
					message.args,
				);
				if (result === "model") await this.model.chooseModel(message.chatId);
				break;
			}
			case "setApprovalMode":
				this.model.setApprovalMode(message.chatId, message.mode);
				this.notice("info", `操作モードを ${APPROVAL_MODE_LABELS[message.mode]} に変更しました。`);
				break;
			case "approvalDecision":
				if (!this.model.resolveApproval(message.permissionRequestId, message.decision)) {
					throw new Error("This approval request has expired.");
				}
				break;
			case "loadModels":
				await this.model.loadModels();
				break;
			case "setModel":
				await this.model.setModel(message.chatId, message.provider, message.modelId);
				break;
			case "setThinking":
				await this.model.setThinking(message.chatId, message.level);
				break;
			case "saveModelDefault":
				await this.model.saveModelDefault(message.chatId);
				this.notice("info", "Model saved as the default for new Pi chats.");
				break;
			case "configureProvider":
				await this.#configureProvider(message.provider);
				break;
			case "compactContext":
				await this.model.compact(message.chatId);
				break;
			case "openReference":
				await this.references.open(message.refId, message.epoch, message.action);
				break;
			case "reviewEdit":
				await this.edits.review(message.editId);
				break;
			case "retryMessage":
				await this.model.retryMessage(message.messageId);
				break;
			case "saveDesign": {
				const saved = await this.designs.save(message.design, message.scope);
				this.model.setDesign(saved.design, message.scope);
				break;
			}
			case "resetDesign": {
				const design = await this.designs.reset(message.scope);
				this.model.setDesign(design, this.designs.load().scope);
				break;
			}
			case "resetPermissions":
				this.authorization.reset();
				this.notice("info", "Saved session permissions and pending approvals were cleared.");
				break;
		}
		this.scheduleSnapshot(snapshotPriorityForIntent(message.type) === "immediate");
	}

	async #pickContext(kind: "any" | "file" | "folder"): Promise<void> {
		const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
		const selected = await vscode.window.showOpenDialog({
			canSelectMany: true,
			canSelectFiles: kind !== "folder",
			canSelectFolders: kind !== "file",
			openLabel: "Add to Pi Agent context",
			...(defaultUri ? { defaultUri } : {}),
		});
		if (selected) await this.contextStore.addUris(selected);
	}

	async #addDroppedUris(values: readonly string[]): Promise<void> {
		const uris: vscode.Uri[] = [];
		for (const value of values) {
			let uri: vscode.Uri;
			try {
				uri = vscode.Uri.parse(value, true).with({ fragment: "" });
			} catch {
				continue;
			}
			if (!vscode.workspace.getWorkspaceFolder(uri)) {
				continue;
			}
			uris.push(uri);
		}
		if (uris.length === 0) {
			throw new Error(
				"Drop files or folders from the current workspace, or click to choose context.",
			);
		}
		await this.contextStore.addUris(uris);
	}

	async #addCurrentFile(): Promise<void> {
		const uri = vscode.window.activeTextEditor?.document.uri;
		if (!uri) throw new Error("Open a file before adding the current file.");
		await this.contextStore.addUris([uri]);
	}

	#addCurrentSelection(): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) throw new Error("Open an editor and select text first.");
		this.contextStore.addSelection(editor);
	}

	async #configureProvider(provider?: string): Promise<void> {
		const providerId =
			provider ??
			(await vscode.window.showInputBox({
				title: "Configure Pi provider",
				prompt: "Provider ID (for example anthropic or openai)",
				ignoreFocusOut: true,
				validateInput: (value) =>
					/^[A-Za-z0-9._-]{1,128}$/u.test(value) ? undefined : "Enter a valid provider ID.",
			}));
		if (!providerId) return;
		const apiKey = await vscode.window.showInputBox({
			title: `Connect ${providerId}`,
			prompt: "API key (stored in VS Code SecretStorage; never sent to the webview)",
			password: true,
			ignoreFocusOut: true,
			validateInput: (value) => (value.length > 0 ? undefined : "Enter an API key."),
		});
		if (!apiKey) return;
		const secretKey = (candidate: string) => `piAgent.provider.${candidate}`;
		await updateProviderCredential(
			providerId,
			apiKey,
			{
				set: (candidate, value) => this.model.configureProvider(candidate, value),
				remove: (candidate) => this.model.removeProviderCredential(candidate),
			},
			{
				getSecret: (candidate) => this.extensionContext.secrets.get(secretKey(candidate)),
				storeSecret: (candidate, value) =>
					this.extensionContext.secrets.store(secretKey(candidate), value),
				deleteSecret: (candidate) => this.extensionContext.secrets.delete(secretKey(candidate)),
				getProviders: () =>
					sanitizeStoredProviderIds(
						this.extensionContext.globalState.get<unknown>("piAgent.secretProviders"),
					),
				setProviders: (providers) =>
					this.extensionContext.globalState.update("piAgent.secretProviders", providers),
			},
		);
		this.notice("info", `${providerId} is connected for this VS Code profile.`);
	}

	public dispose(): void {
		if (this.#snapshotTimer) clearTimeout(this.#snapshotTimer);
		if (this.#referenceRefreshTimer) clearTimeout(this.#referenceRefreshTimer);
		this.#snapshotTask.dispose();
		this.#disposeViewSubscriptions();
		this.#view = undefined;
		for (const subscription of this.#subscriptions) subscription.dispose();
		this.#subscriptions.length = 0;
		this.#requestIds.clear();
	}

	#disposeViewSubscriptions(): void {
		const subscriptions = this.#viewSubscriptions;
		this.#viewSubscriptions = [];
		for (const subscription of subscriptions) subscription.dispose();
	}
}
