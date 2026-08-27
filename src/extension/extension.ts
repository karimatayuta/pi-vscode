import * as vscode from "vscode";
import { MAX_CONTEXT_RESOLUTION_BYTES } from "../shared/prompt-budget.js";
import { ActivationScope } from "./activation-scope.js";
import { fireAndReport } from "./async/fire-and-report.js";
import {
	type ContextResolutionLimits,
	ContextStore,
	DEFAULT_CONTEXT_LIMITS,
} from "./context/context-store.js";
import { ProposedEditStore } from "./edits/proposed-edit-store.js";
import { isPathInside } from "./filesystem/workspace-path.js";
import { ReferenceRegistry } from "./links/reference-registry.js";
import { ToolAuthorizationRouter } from "./permissions/tool-authorization-router.js";
import { capabilityForToolRequest } from "./permissions/tool-capability.js";
import { PiHostService } from "./pi/pi-host-service.js";
import { sanitizeStoredProviderIds } from "./settings/provider-credentials.js";
import { ViewDesignStore } from "./settings/view-design-store.js";
import { ChatViewProvider } from "./views/chat-view-provider.js";
import { ChatWorkspaceModel } from "./views/chat-workspace-model.js";
import {
	WorkspaceTrustReloadCoordinator,
	WorkspaceTrustState,
} from "./workspace-trust-transition.js";

let activeHost: PiHostService | undefined;

function boundedInteger(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(minimum, Math.min(maximum, Math.floor(value ?? fallback)));
}

function readContextLimits(): ContextResolutionLimits {
	const configuration = vscode.workspace.getConfiguration("piAgent.context");
	return {
		maxItems: DEFAULT_CONTEXT_LIMITS.maxItems,
		maxFileBytes: boundedInteger(
			configuration.get<number>("maxFileBytes"),
			DEFAULT_CONTEXT_LIMITS.maxFileBytes,
			1_024,
			10 * 1_024 * 1_024,
		),
		maxFolderFiles: boundedInteger(
			configuration.get<number>("maxFolderFiles"),
			DEFAULT_CONTEXT_LIMITS.maxFolderFiles,
			1,
			2_000,
		),
		maxTotalBytes: boundedInteger(
			configuration.get<number>("maxTotalBytes"),
			DEFAULT_CONTEXT_LIMITS.maxTotalBytes,
			1_024,
			MAX_CONTEXT_RESOLUTION_BYTES,
		),
	};
}

function localWorkspaceRoots(): string[] {
	const roots = (vscode.workspace.workspaceFolders ?? []).flatMap((folder) =>
		folder.uri.scheme === "file" ? [folder.uri.fsPath] : [],
	);
	return roots;
}

async function pickContext(store: ContextStore): Promise<void> {
	const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
	const selected = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: true,
		canSelectMany: true,
		...(defaultUri ? { defaultUri } : {}),
		openLabel: "Add to Pi Agent context",
	});
	if (selected) await store.addUris(selected);
}

async function focusPiAgent(): Promise<void> {
	await vscode.commands.executeCommand("workbench.view.extension.piAgent");
	await vscode.commands.executeCommand("piAgent.chat.focus");
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const scope = new ActivationScope();
	let cleanupOutput: vscode.LogOutputChannel | undefined;
	let host: PiHostService | undefined;
	try {
		const output = scope.add(vscode.window.createOutputChannel("Pi Agent", { log: true }));
		cleanupOutput = output;
		const report = (message: string, error?: unknown): void => {
			output.appendLine(
				`[${new Date().toISOString()}] ${message}${error instanceof Error ? ` (${error.name})` : ""}`,
			);
		};
		const contextStore = scope.add(new ContextStore(readContextLimits(), report));
		const authorization = scope.add(new ToolAuthorizationRouter());
		const references = new ReferenceRegistry();
		const edits = scope.add(new ProposedEditStore());
		const designs = new ViewDesignStore(context);
		const workspaceTrust = new WorkspaceTrustState(vscode.workspace.isTrusted);
		host = new PiHostService({
			isWorkspaceTrusted: (cwd) =>
				workspaceTrust.trusted && localWorkspaceRoots().some((root) => isPathInside(root, cwd)),
			authorizeToolCall: async (request) =>
				authorization.authorize({
					sessionId: request.sessionId,
					toolCallId: request.toolCallId,
					toolName: request.toolName,
					capability: capabilityForToolRequest(request, localWorkspaceRoots()),
					cwd: request.cwd,
					...(request.target ? { target: request.target } : {}),
					...(request.command ? { command: request.command } : {}),
					risk: request.risk === "safe" ? "normal" : request.risk,
				}),
			log: report,
		});

		await host.start();
		for (const providerId of sanitizeStoredProviderIds(
			context.globalState.get<unknown>("piAgent.secretProviders"),
		)) {
			const secret = await context.secrets.get(`piAgent.provider.${providerId}`);
			if (secret) {
				await host.setRuntimeApiKey(providerId, secret).catch((error) => {
					output.appendLine(
						`[${new Date().toISOString()}] Could not restore credentials for ${providerId}${error instanceof Error ? ` (${error.name})` : ""}`,
					);
				});
			}
		}

		const model = scope.add(
			new ChatWorkspaceModel(
				context,
				host,
				contextStore,
				authorization,
				references,
				edits,
				workspaceTrust,
				output,
			),
		);
		const loadedDesign = designs.load();
		model.setDesign(loadedDesign.design, loadedDesign.scope);
		await model.initialize();

		const provider = scope.add(
			new ChatViewProvider(
				context,
				model,
				contextStore,
				authorization,
				references,
				edits,
				designs,
				report,
			),
		);
		scope.add(
			vscode.window.registerWebviewViewProvider("piAgent.chat", provider, {
				webviewOptions: { retainContextWhenHidden: true },
			}),
		);
		scope.add(vscode.commands.registerCommand("piAgent.openChat", focusPiAgent));
		scope.add(
			vscode.commands.registerCommand("piAgent.newChat", async () => {
				await model.newChat();
				await focusPiAgent();
			}),
		);
		scope.add(vscode.commands.registerCommand("piAgent.showHistory", () => model.showHistory()));
		scope.add(
			vscode.commands.registerCommand("piAgent.focusComposer", async () => {
				await focusPiAgent();
				provider.focusComposer();
			}),
		);
		scope.add(vscode.commands.registerCommand("piAgent.stop", () => model.stop()));
		scope.add(
			vscode.commands.registerCommand("piAgent.addContext", () => pickContext(contextStore)),
		);
		scope.add(
			vscode.commands.registerCommand("piAgent.addCurrentFile", async (resource?: vscode.Uri) => {
				const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
				if (!uri) throw new Error("Open a file before adding it to Pi Agent context.");
				await contextStore.addUris([uri]);
			}),
		);
		scope.add(
			vscode.commands.registerCommand("piAgent.addCurrentSelection", () => {
				const editor = vscode.window.activeTextEditor;
				if (!editor) throw new Error("Open an editor and select text first.");
				contextStore.addSelection(editor);
			}),
		);
		scope.add(
			vscode.commands.registerCommand(
				"piAgent.addExplorerContext",
				async (resource?: vscode.Uri, selected?: readonly vscode.Uri[]) => {
					const uris = selected && selected.length > 0 ? selected : resource ? [resource] : [];
					await contextStore.addUris(uris);
				},
			),
		);
		scope.add(vscode.commands.registerCommand("piAgent.clearContext", () => contextStore.clear()));
		scope.add(
			vscode.commands.registerCommand("piAgent.openSettings", () =>
				vscode.commands.executeCommand(
					"workbench.action.openSettings",
					"@ext:karimatayuta.pi-agent",
				),
			),
		);
		scope.add(
			vscode.commands.registerCommand("piAgent.configureProvider", () =>
				provider.configureProvider(),
			),
		);
		scope.add(
			vscode.commands.registerCommand("piAgent.resetPermissions", () => {
				authorization.reset();
				provider.notice("info", "Pi Agent permissions were reset.");
			}),
		);
		const trustReload = new WorkspaceTrustReloadCoordinator({
			enterReloadRequired: () => {
				model.requireReloadForWorkspaceTrust();
				fireAndReport(
					vscode.commands.executeCommand("setContext", "piAgent.workspaceTrusted", false),
					report,
					"Could not keep the trusted-workspace command context restricted before reload.",
				);
			},
			announceReload: () =>
				vscode.window.showInformationMessage(
					"Workspace Trust changed. Reloading Pi Agent to apply the new permissions…",
				),
			reloadWindow: () => vscode.commands.executeCommand("workbench.action.reloadWindow"),
			reportAnnouncementFailure: (error) =>
				report("Could not show the Workspace Trust reload notice.", error),
			handleReloadFailure: (error) => {
				report("Could not reload after Workspace Trust changed.", error);
				provider.notice(
					"warning",
					"Reload this VS Code window to enable trusted Pi Agent features. Plan mode remains active until reload.",
				);
				provider.scheduleSnapshot(true);
			},
		});
		scope.add(
			vscode.workspace.onDidGrantWorkspaceTrust(() => {
				fireAndReport(
					trustReload.handleGrant(),
					report,
					"Could not handle the Workspace Trust transition safely.",
				);
			}),
		);
		scope.add(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("piAgent.context")) {
					contextStore.updateLimits(readContextLimits());
				}
			}),
		);

		await vscode.commands.executeCommand(
			"setContext",
			"piAgent.workspaceTrusted",
			workspaceTrust.trusted,
		);
		await vscode.commands.executeCommand("setContext", "piAgent.hasContext", false);
		await vscode.commands.executeCommand("setContext", "piAgent.isRunning", false);
		scope.commit(context.subscriptions);
		activeHost = host;
		output.appendLine(`[${new Date().toISOString()}] Pi Agent activated.`);
	} catch (error) {
		activeHost = undefined;
		await scope.dispose((cleanupError) => {
			cleanupOutput?.appendLine(
				`[${new Date().toISOString()}] Activation cleanup failed${cleanupError instanceof Error ? ` (${cleanupError.name})` : ""}`,
			);
		});
		if (host) await host.dispose().catch(() => undefined);
		throw error;
	}
}

export async function deactivate(): Promise<void> {
	const host = activeHost;
	activeHost = undefined;
	if (host) await host.dispose();
}
