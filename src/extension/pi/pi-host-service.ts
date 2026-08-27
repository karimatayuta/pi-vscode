import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionCommandContextActions,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as vscode from "vscode";
import { MAX_PI_PROMPT_CHARACTERS } from "../../shared/prompt-budget.js";
import { isPathInside } from "../filesystem/workspace-path.js";
import { CloseAwareOperationQueue } from "./close-aware-operation-queue.js";
import { buildCommandCatalog, buildCommandPrompt } from "./command-catalog.js";
import {
	costKindForModel,
	toMessageHistory,
	toModelDto,
	toModelRefDto,
	toStatsDto,
} from "./dto.js";
import { PiHostError } from "./errors.js";
import { mapPiSessionEvent, type PiHostEventDraft } from "./event-mapper.js";
import { LiveStatsThrottle, withLiveMessageUsage } from "./live-session-stats.js";
import { PendingOperations } from "./pending-operations.js";
import { resolvePiPackageReadResources } from "./pi-package-resources.js";
import { redactString, safeErrorMessage } from "./sanitize.js";
import { SessionRegistry } from "./session-registry.js";
import {
	createToolAuthorizationExtension,
	moveAuthorizationGateLast,
	type PackageReadResources,
} from "./tool-authorization.js";
import type {
	PiCommandDto,
	PiErrorDto,
	PiHostApi,
	PiHostEvent,
	PiHostEventListener,
	PiHostSessionId,
	PiImageInput,
	PiMessageDto,
	PiModelCatalogDto,
	PiPromptDelivery,
	PiPromptInput,
	PiSessionBootstrapDto,
	PiSessionHistoryDto,
	PiSessionOpenTarget,
	PiSessionPhase,
	PiSessionReplaceTarget,
	PiSessionSnapshotDto,
	PiSessionStatsDto,
	PiThinkingLevel,
	PiToolAuthorizationDecision,
	PiToolAuthorizationRequest,
} from "./types.js";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_TITLE_CHARACTERS = 200;
const MAX_COMPACTION_INSTRUCTIONS = 64 * 1024;
const MAX_PROVIDER_ID_CHARACTERS = 256;
const MAX_API_KEY_CHARACTERS = 64 * 1024;
const DEFAULT_MODEL_TIMEOUT_MS = 15_000;
const MAX_MODEL_CATALOG = 4_096;

export interface PiHostServiceOptions {
	readonly agentDir?: string;
	readonly modelTimeoutMs?: number;
	readonly idFactory?: () => string;
	readonly isWorkspaceTrusted?: (cwd: string) => boolean;
	readonly authorizeToolCall?: (
		request: PiToolAuthorizationRequest,
	) => Promise<PiToolAuthorizationDecision>;
	readonly log?: (message: string, error?: unknown) => void;
}

interface ControllerHooks {
	readonly registry: SessionRegistry<PiSessionController>;
	readonly canonicalizeSessionFile: (path: string) => Promise<string>;
	readonly emit: (event: PiHostEvent) => void;
	readonly requestClose: (id: PiHostSessionId) => void;
}

function defaultWorkspaceTrust(cwd: string): boolean {
	if (!vscode.workspace.isTrusted) {
		return false;
	}
	return (vscode.workspace.workspaceFolders ?? []).some((folder) =>
		isPathInside(folder.uri.fsPath, cwd),
	);
}

function currentLocalWorkspaceRoots(): string[] {
	return (vscode.workspace.workspaceFolders ?? []).flatMap((folder) =>
		folder.uri.scheme === "file" ? [folder.uri.fsPath] : [],
	);
}

function operationSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function validatePrompt(input: PiPromptInput): { text: string; images?: PiImageInput[] } {
	const text = input.text;
	if (typeof text !== "string" || text.length > MAX_PI_PROMPT_CHARACTERS) {
		throw new PiHostError("invalid_prompt", "The Pi prompt is too large.");
	}
	const images = input.images ? [...input.images] : undefined;
	if ((!text.trim() && !images?.length) || (images && images.length > MAX_IMAGES)) {
		throw new PiHostError("invalid_prompt", "Enter a message or attach an image before sending.");
	}
	for (const image of images ?? []) {
		if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(image.data)) {
			throw new PiHostError("invalid_image", "An attached image is not valid base64 data.");
		}
		if (Math.ceil((image.data.length * 3) / 4) > MAX_IMAGE_BYTES) {
			throw new PiHostError("image_too_large", "An attached image is too large.");
		}
	}
	return { text, ...(images === undefined ? {} : { images }) };
}

function phaseForSession(session: AgentSession): PiSessionPhase {
	if (session.isCompacting) {
		return "compacting";
	}
	if (session.isStreaming) {
		return "running";
	}
	return "idle";
}

function modelThinkingLevels(model: unknown): PiThinkingLevel[] {
	if (!model || typeof model !== "object" || !("reasoning" in model) || model.reasoning !== true) {
		return ["off"];
	}
	const all: PiThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	const map =
		"thinkingLevelMap" in model &&
		typeof model.thinkingLevelMap === "object" &&
		model.thinkingLevelMap
			? (model.thinkingLevelMap as Record<string, unknown>)
			: undefined;
	return all.filter((level) => map?.[level] !== null);
}

function managerFor(cwd: string, target: PiSessionOpenTarget): SessionManager {
	switch (target.kind) {
		case "new":
			return SessionManager.create(cwd);
		case "continue":
			return SessionManager.continueRecent(cwd);
		case "memory":
			return SessionManager.inMemory(cwd);
		case "file":
			// A VS Code tab is workspace-scoped. Override stale/moved transcript cwd values with this workspace cwd.
			return SessionManager.open(target.path, undefined, cwd);
	}
}

function errorDto(
	scope: PiErrorDto["scope"],
	code: string,
	error: unknown,
	recoverable = true,
): PiErrorDto {
	return { scope, code, message: safeErrorMessage(error), recoverable };
}

function validateProviderId(provider: string): string {
	const normalized = provider.trim();
	const containsControlCharacter = [...normalized].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
	if (!normalized || normalized.length > MAX_PROVIDER_ID_CHARACTERS || containsControlCharacter) {
		throw new PiHostError("invalid_provider", "The Pi provider identifier is invalid.");
	}
	return normalized;
}

/**
 * Adapts one SDK runtime to the extension protocol. Session rebinding, ordered
 * mutations, event generations, and close/abort ownership stay together here
 * because they share one lifecycle boundary.
 */
class PiSessionController {
	#generation = 0;
	#phase: PiSessionPhase;
	#unsubscribe: (() => void) | undefined;
	readonly #mutations = new CloseAwareOperationQueue(
		() => new PiHostError("session_closed", "This Pi chat session is closing."),
	);
	#abortPromise: Promise<void> | undefined;
	#closePromise: Promise<void> | undefined;
	#closed = false;
	readonly #statsThrottle = new LiveStatsThrottle();

	public constructor(
		public readonly id: PiHostSessionId,
		public readonly runtime: AgentSessionRuntime,
		private readonly hooks: ControllerHooks,
	) {
		this.#phase = phaseForSession(runtime.session);
		runtime.setRebindSession(async (session) => {
			await this.#bindSession(session, true);
		});
	}

	public get session(): AgentSession {
		return this.runtime.session;
	}

	public get generation(): number {
		return this.#generation;
	}

	public async bindInitialSession(): Promise<void> {
		await this.#bindSession(this.session, false);
	}

	public snapshot(): PiSessionSnapshotDto {
		const session = this.session;
		const model = session.model;
		const modelRef = toModelRefDto(model);
		const title = session.sessionName;
		const sessionFile = session.sessionFile;
		return {
			id: this.id,
			generation: this.#generation,
			cwd: basename(this.runtime.cwd) || "workspace",
			piSessionId: session.sessionId,
			persistent: session.sessionManager.isPersisted(),
			...(sessionFile === undefined ? {} : { sessionFile: resolve(sessionFile) }),
			...(title === undefined ? {} : { title }),
			phase: this.#phase,
			busy: this.#phase !== "idle",
			...(modelRef === undefined ? {} : { model: modelRef }),
			thinkingLevel: session.thinkingLevel as PiThinkingLevel,
			availableThinkingLevels: session.getAvailableThinkingLevels() as PiThinkingLevel[],
			pendingMessages: session.pendingMessageCount,
			activeTools: session.getActiveToolNames(),
			stats: this.stats(),
		};
	}

	public stats(): PiSessionStatsDto {
		const model = this.session.model;
		const subscription = model
			? model.provider === "kimi-coding" ||
				this.session.modelRuntime.isUsingSubscription(model.provider)
			: false;
		return toStatsDto(this.session.getSessionStats(), costKindForModel(model, subscription));
	}

	public history(): PiMessageDto[] {
		return toMessageHistory(this.session.messages);
	}

	public commands(): PiCommandDto[] {
		return buildCommandCatalog({
			extensions: this.session.extensionRunner.getRegisteredCommands(),
			prompts: this.session.promptTemplates,
			skills: this.session.resourceLoader.getSkills().skills,
		});
	}

	public bootstrap(): PiSessionBootstrapDto {
		return { snapshot: this.snapshot(), history: this.history(), commands: this.commands() };
	}

	public async send(input: PiPromptInput): Promise<void> {
		this.#assertOpen();
		const normalized = validatePrompt(input);
		try {
			await this.session.prompt(normalized.text, {
				...(normalized.images
					? {
							images: normalized.images.map((image) => ({
								type: "image" as const,
								data: image.data,
								mimeType: image.mimeType,
							})),
						}
					: {}),
				expandPromptTemplates: true,
				source: "rpc",
				...(this.session.isStreaming ? { streamingBehavior: input.delivery ?? "followUp" } : {}),
			});
		} catch (error) {
			this.#emitDraft({
				type: "session.error",
				error: errorDto("prompt", "prompt_failed", error),
			});
			throw error;
		}
	}

	public async invokeCommand(
		invocation: string,
		args?: string,
		delivery?: PiPromptDelivery,
	): Promise<void> {
		const prompt = buildCommandPrompt(this.commands(), invocation, args);
		await this.send({ text: prompt, ...(delivery === undefined ? {} : { delivery }) });
	}

	public async replace(target: PiSessionReplaceTarget): Promise<PiSessionBootstrapDto> {
		this.#assertOpen();
		return this.#mutate(async () => {
			if (target.kind === "file") {
				const fileKey = await this.hooks.canonicalizeSessionFile(target.path);
				this.hooks.registry.reserveTransition(this.id, fileKey);
				try {
					const result = await this.runtime.switchSession(target.path, {
						cwdOverride: this.runtime.cwd,
					});
					if (result.cancelled) {
						this.hooks.registry.cancelTransition(this.id);
					} else {
						await this.#commitCurrentFile();
					}
				} catch (error) {
					this.hooks.registry.cancelTransition(this.id);
					throw error;
				}
			} else if (target.kind === "fork") {
				const result = await this.runtime.fork(target.entryId, {
					...(target.position === undefined ? {} : { position: target.position }),
				});
				if (!result.cancelled) {
					await this.#commitCurrentFile();
				}
			} else {
				const result = await this.runtime.newSession();
				if (!result.cancelled) {
					await this.#commitCurrentFile();
				}
			}
			return this.bootstrap();
		});
	}

	public async reload(): Promise<PiSessionBootstrapDto> {
		this.#assertOpen();
		return this.#mutate(async () => {
			await this.session.reload();
			const bootstrap = this.bootstrap();
			this.#emitDraft({ type: "session.bootstrap", bootstrap });
			return bootstrap;
		});
	}

	public async compact(customInstructions?: string): Promise<PiSessionSnapshotDto> {
		this.#assertOpen();
		return this.#mutate(async () => {
			if (!this.session.isIdle || this.session.isCompacting) {
				throw new PiHostError(
					"session_busy",
					"Wait for the current Pi operation to finish before compacting.",
				);
			}
			const instructions = customInstructions?.trim();
			if (instructions && instructions.length > MAX_COMPACTION_INSTRUCTIONS) {
				throw new PiHostError(
					"compaction_instructions_too_large",
					"The compaction instructions are too large.",
				);
			}
			try {
				if (instructions) {
					await this.session.compact(instructions);
				} else {
					await this.session.compact();
				}
				return this.emitSnapshot();
			} catch (error) {
				const normalized =
					error instanceof PiHostError
						? error
						: new PiHostError(
								"compaction_failed",
								safeErrorMessage(error, "Pi compaction failed."),
								true,
								{
									cause: error,
								},
							);
				this.#emitDraft({
					type: "session.error",
					error: errorDto("compaction", normalized.code, normalized),
				});
				throw normalized;
			} finally {
				if (this.session.isIdle) {
					this.setPhase("idle");
				}
			}
		});
	}

	public setPhase(phase: PiSessionPhase): void {
		if (this.#phase === phase || this.#closed) {
			return;
		}
		this.#phase = phase;
		this.#emitDraft({ type: "session.state", phase, busy: phase !== "idle" });
	}

	public emitSnapshot(): PiSessionSnapshotDto {
		const snapshot = this.snapshot();
		this.#emitDraft({ type: "session.snapshot", snapshot });
		return snapshot;
	}

	public async abort(): Promise<void> {
		if (this.#closed) {
			return;
		}
		if (this.#abortPromise) {
			return this.#abortPromise;
		}
		const session = this.session;
		this.#abortPromise = (async () => {
			session.clearQueue();
			session.abortCompaction();
			session.abortBranchSummary();
			session.abortBash();
			await session.abort();
		})().finally(() => {
			this.#abortPromise = undefined;
		});
		return this.#abortPromise;
	}

	public async close(): Promise<void> {
		if (this.#closePromise) {
			return this.#closePromise;
		}
		if (this.#closed) return;
		const mutations = this.#mutations.beginClose();
		// Defer execution by one microtask so reentrant event listeners observe the
		// assigned close promise as well as the synchronous closing gate.
		this.#closePromise = Promise.resolve().then(() => this.#finishClose(mutations));
		return this.#closePromise;
	}

	async #bindSession(session: AgentSession, announce: boolean): Promise<void> {
		this.#assertOpen();
		this.#unsubscribe?.();
		this.#statsThrottle.confirmed();
		const generation = ++this.#generation;
		this.#phase = phaseForSession(session);
		this.#unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (generation !== this.#generation || this.#closed) {
				return;
			}
			this.#handleSessionEvent(event);
		});
		await session.bindExtensions({
			mode: "rpc",
			commandContextActions: this.#commandContextActions(),
			abortHandler: () => {
				void this.abort().catch((error) => {
					this.#emitDraft({
						type: "session.error",
						error: errorDto("host", "abort_failed", error),
					});
				});
			},
			shutdownHandler: () => {
				this.hooks.requestClose(this.id);
			},
			onError: (error) => {
				this.#emitDraft({
					type: "session.error",
					error: {
						scope: "extension",
						code: "extension_error",
						message: safeErrorMessage(error.error, "A Pi extension failed."),
						recoverable: true,
					},
				});
			},
		});
		this.#assertOpen();
		if (announce) {
			this.#emitDraft({ type: "session.bootstrap", bootstrap: this.bootstrap() });
		}
	}

	#commandContextActions(): ExtensionCommandContextActions {
		return {
			waitForIdle: () => this.session.waitForIdle(),
			newSession: (options) =>
				this.#mutate(async () => {
					const result = await this.runtime.newSession(options);
					if (!result.cancelled) {
						await this.#commitCurrentFile();
					}
					return result;
				}),
			fork: (entryId, options) =>
				this.#mutate(async () => {
					const result = await this.runtime.fork(entryId, options);
					if (!result.cancelled) {
						await this.#commitCurrentFile();
					}
					return result;
				}),
			navigateTree: (targetId, options) =>
				this.#mutate(() => this.session.navigateTree(targetId, options)),
			switchSession: (sessionPath, options) =>
				this.#mutate(async () => {
					const fileKey = await this.hooks.canonicalizeSessionFile(sessionPath);
					this.hooks.registry.reserveTransition(this.id, fileKey);
					try {
						const result = await this.runtime.switchSession(sessionPath, {
							cwdOverride: this.runtime.cwd,
							...(options?.withSession === undefined ? {} : { withSession: options.withSession }),
						});
						if (result.cancelled) {
							this.hooks.registry.cancelTransition(this.id);
						} else {
							await this.#commitCurrentFile();
						}
						return result;
					} catch (error) {
						this.hooks.registry.cancelTransition(this.id);
						throw error;
					}
				}),
			reload: async () => {
				await this.reload();
			},
		};
	}

	#handleSessionEvent(event: AgentSessionEvent): void {
		const mapped = mapPiSessionEvent(event);
		if (mapped.phase) {
			this.setPhase(mapped.phase);
		}
		for (const output of mapped.events) {
			this.#emitDraft(output);
		}
		if (mapped.statsRefresh) {
			const confirmed = mapped.statsRefresh.mode === "confirmed";
			if (confirmed || this.#statsThrottle.shouldPublishPreview()) {
				if (confirmed) this.#statsThrottle.confirmed();
				const stats = mapped.statsRefresh.usage
					? withLiveMessageUsage(this.stats(), mapped.statsRefresh.usage)
					: this.stats();
				this.#emitDraft({ type: "session.stats", stats });
			}
		}
		if (mapped.refreshSnapshot) {
			this.emitSnapshot();
		}
	}

	async #commitCurrentFile(): Promise<void> {
		const file = this.session.sessionFile;
		const key = file ? await this.hooks.canonicalizeSessionFile(file) : undefined;
		this.hooks.registry.commitTransition(this.id, key);
	}

	#emitDraft(draft: PiHostEventDraft): void {
		this.hooks.emit({ ...draft, sessionId: this.id, generation: this.#generation } as PiHostEvent);
	}

	#assertOpen(): void {
		if (this.#closed || this.#mutations.closing || this.#phase === "closing") {
			throw new PiHostError("session_closed", "This Pi chat session is closing.");
		}
	}

	#mutate<T>(operation: () => Promise<T>): Promise<T> {
		return this.#mutations.run(operation);
	}

	async #finishClose(mutations: Promise<void>): Promise<void> {
		this.setPhase("closing");
		let failed = false;
		let firstError: unknown;
		const attempt = async (operation: () => Promise<unknown>): Promise<void> => {
			try {
				await operation();
			} catch (error) {
				if (!failed) firstError = error;
				failed = true;
			}
		};
		try {
			await attempt(() => this.abort());
			await attempt(() => mutations);
			await attempt(() => this.session.settingsManager.flush());
			try {
				for (const settingsError of this.session.settingsManager.drainErrors()) {
					this.#emitDraft({
						type: "session.error",
						error: errorDto("host", "settings_write_failed", settingsError.error),
					});
				}
			} catch (error) {
				if (!failed) firstError = error;
				failed = true;
			}
			await attempt(() => this.runtime.dispose());
		} finally {
			this.#closed = true;
			this.#unsubscribe?.();
			this.#unsubscribe = undefined;
		}
		if (failed) throw firstError;
	}
}

/**
 * Process-wide Pi host. It owns the shared model runtime and session registry;
 * per-chat SDK state and event ordering are delegated to PiSessionController.
 */
export class PiHostService implements PiHostApi {
	readonly #listeners = new Set<PiHostEventListener>();
	readonly #registry = new SessionRegistry<PiSessionController>();
	readonly #closing = new Map<PiHostSessionId, Promise<void>>();
	readonly #pendingOpens = new PendingOperations();
	readonly #agentDir: string;
	readonly #modelTimeoutMs: number;
	readonly #idFactory: () => string;
	readonly #isWorkspaceTrusted: (cwd: string) => boolean;
	readonly #workspaceRoots: () => readonly string[];
	readonly #authorizeToolCall:
		| ((request: PiToolAuthorizationRequest) => Promise<PiToolAuthorizationDecision>)
		| undefined;
	readonly #log: (message: string, error?: unknown) => void;
	#modelRuntime: ModelRuntime | undefined;
	#packageReadResourcesPromise: Promise<PackageReadResources> | undefined;
	#startPromise: Promise<void> | undefined;
	#disposePromise: Promise<void> | undefined;
	#disposed = false;

	public constructor(options: PiHostServiceOptions = {}) {
		this.#agentDir = resolve(options.agentDir ?? getAgentDir());
		this.#modelTimeoutMs = options.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
		this.#idFactory = options.idFactory ?? randomUUID;
		this.#isWorkspaceTrusted = options.isWorkspaceTrusted ?? defaultWorkspaceTrust;
		this.#workspaceRoots = currentLocalWorkspaceRoots;
		this.#authorizeToolCall = options.authorizeToolCall;
		this.#log = options.log ?? (() => undefined);
	}

	public async start(signal?: AbortSignal): Promise<void> {
		this.#assertUsable();
		if (this.#modelRuntime) {
			return;
		}
		if (!this.#startPromise) {
			this.#startPromise = ModelRuntime.create({
				authPath: join(this.#agentDir, "auth.json"),
				modelsPath: join(this.#agentDir, "models.json"),
				signal: operationSignal(signal, this.#modelTimeoutMs),
			})
				.then((runtime) => {
					if (this.#disposed) {
						throw new PiHostError(
							"host_disposed",
							"Pi Agent was disposed while its model runtime was starting.",
						);
					}
					this.#modelRuntime = runtime;
				})
				.finally(() => {
					this.#startPromise = undefined;
				});
		}
		await this.#startPromise;
	}

	public open(input: {
		readonly cwd: string;
		readonly target: PiSessionOpenTarget;
	}): Promise<PiSessionBootstrapDto> {
		return this.#pendingOpens.track(this.#open(input));
	}

	async #open(input: {
		readonly cwd: string;
		readonly target: PiSessionOpenTarget;
	}): Promise<PiSessionBootstrapDto> {
		await this.start();
		this.#assertUsable();
		const cwd = resolve(input.cwd);
		const sessionManager = managerFor(cwd, input.target);
		const initialFile = sessionManager.getSessionFile();
		const initialFileKey = initialFile
			? await this.#canonicalizeSessionFile(initialFile)
			: undefined;
		this.#assertUsable();
		const id = this.#idFactory();
		this.#registry.begin(id, initialFileKey);
		let runtime: AgentSessionRuntime | undefined;
		let controller: PiSessionController | undefined;
		try {
			const createRuntime = this.#runtimeFactory(id);
			runtime = await createAgentSessionRuntime(createRuntime, {
				cwd,
				agentDir: this.#agentDir,
				sessionManager,
			});
			this.#assertUsable();
			controller = new PiSessionController(id, runtime, {
				registry: this.#registry,
				canonicalizeSessionFile: (path) => this.#canonicalizeSessionFile(path),
				emit: (event) => this.#emit(event),
				requestClose: (sessionId) => {
					void this.close(sessionId).catch((error) => {
						this.#log("A Pi extension could not close its session cleanly.", error);
					});
				},
			});
			this.#registry.attach(id, controller);
			this.#assertUsable();
			await controller.bindInitialSession();
			this.#assertUsable();
			const actualFile = runtime.session.sessionFile;
			const actualFileKey = actualFile
				? await this.#canonicalizeSessionFile(actualFile)
				: undefined;
			this.#assertUsable();
			this.#registry.commitTransition(id, actualFileKey);
			this.#assertUsable();
			return controller.bootstrap();
		} catch (error) {
			this.#registry.remove(id);
			if (controller) {
				await controller
					.close()
					.catch((closeError) =>
						this.#log("Failed to close a partially opened Pi session.", closeError),
					);
			} else if (runtime) {
				await runtime
					.dispose()
					.catch((closeError) =>
						this.#log("Failed to dispose a partially opened Pi runtime.", closeError),
					);
			}
			throw error;
		}
	}

	public async replace(
		id: PiHostSessionId,
		target: PiSessionReplaceTarget,
	): Promise<PiSessionBootstrapDto> {
		return this.#controller(id).replace(target);
	}

	public async send(id: PiHostSessionId, input: PiPromptInput): Promise<void> {
		await this.#controller(id).send(input);
	}

	public async listCommands(id: PiHostSessionId): Promise<readonly PiCommandDto[]> {
		return this.#controller(id).commands();
	}

	public async listSessions(cwd: string): Promise<readonly PiSessionHistoryDto[]> {
		this.#assertUsable();
		const resolvedCwd = resolve(cwd);
		const sessions = await SessionManager.list(resolvedCwd);
		return sessions.map((session) => ({
			path: resolve(session.path),
			id: session.id,
			...(session.name ? { title: session.name } : {}),
			firstMessage: redactString(session.firstMessage, 1_024),
			messageCount: Math.max(0, session.messageCount),
			createdAt: session.created.getTime(),
			modifiedAt: session.modified.getTime(),
		}));
	}

	public async invokeCommand(
		id: PiHostSessionId,
		invocation: string,
		args?: string,
		delivery?: PiPromptDelivery,
	): Promise<void> {
		await this.#controller(id).invokeCommand(invocation, args, delivery);
	}

	public async listModels(signal?: AbortSignal): Promise<PiModelCatalogDto> {
		await this.start(signal);
		const runtime = this.#requireModelRuntime();
		let models: readonly unknown[];
		let stale = false;
		try {
			models = await runtime.getAvailable(undefined, {
				signal: operationSignal(signal, this.#modelTimeoutMs),
			});
		} catch (error) {
			this.#log("Pi model availability refresh failed; using the last snapshot.", error);
			models = runtime.getAvailableSnapshot();
			stale = true;
		}
		return {
			stale,
			models: models
				.slice(0, MAX_MODEL_CATALOG)
				.map((model) => toModelDto(model, modelThinkingLevels(model)))
				.filter((model): model is NonNullable<typeof model> => model !== undefined)
				.sort((left, right) =>
					`${left.provider}/${left.name}`.localeCompare(`${right.provider}/${right.name}`),
				),
		};
	}

	public async setRuntimeApiKey(provider: string, apiKey: string): Promise<void> {
		await this.start();
		const providerId = validateProviderId(provider);
		if (!apiKey || apiKey.length > MAX_API_KEY_CHARACTERS) {
			throw new PiHostError("invalid_api_key", "The API key is empty or too large.");
		}
		try {
			await this.#requireModelRuntime().setRuntimeApiKey(providerId, apiKey);
		} catch {
			// Never propagate an SDK error that could include credential material.
			throw new PiHostError(
				"credential_update_failed",
				"Pi could not update this provider credential.",
			);
		}
	}

	public async removeRuntimeApiKey(provider: string): Promise<void> {
		await this.start();
		try {
			await this.#requireModelRuntime().removeRuntimeApiKey(validateProviderId(provider));
		} catch {
			throw new PiHostError(
				"credential_remove_failed",
				"Pi could not remove this provider credential.",
			);
		}
	}

	public async setModel(
		id: PiHostSessionId,
		ref: { readonly provider: string; readonly id: string },
		persist = false,
	): Promise<PiSessionSnapshotDto> {
		const controller = this.#controller(id);
		const model = this.#requireModelRuntime().getModel(ref.provider, ref.id);
		if (!model) {
			throw new PiHostError("unknown_model", "The selected Pi model is not available.");
		}
		try {
			await controller.session.setModel(model, { persist });
		} catch (error) {
			this.#emitControllerError(controller, errorDto("model", "model_change_failed", error));
			throw error;
		}
		return controller.emitSnapshot();
	}

	public async setThinking(
		id: PiHostSessionId,
		level: PiThinkingLevel,
		persist = false,
	): Promise<PiSessionSnapshotDto> {
		const controller = this.#controller(id);
		controller.session.setThinkingLevel(level, { persist });
		return controller.emitSnapshot();
	}

	public async setTitle(id: PiHostSessionId, title: string): Promise<PiSessionSnapshotDto> {
		const controller = this.#controller(id);
		const normalized = title.trim().slice(0, MAX_TITLE_CHARACTERS);
		controller.session.setSessionName(normalized);
		return controller.emitSnapshot();
	}

	public async compact(
		id: PiHostSessionId,
		customInstructions?: string,
	): Promise<PiSessionSnapshotDto> {
		return this.#controller(id).compact(customInstructions);
	}

	public async abort(id: PiHostSessionId): Promise<void> {
		await this.#controller(id).abort();
	}

	public close(id: PiHostSessionId): Promise<void> {
		const existing = this.#closing.get(id);
		if (existing) {
			return existing;
		}
		const controller = this.#registry.get(id);
		if (!controller) {
			return Promise.resolve();
		}
		const generation = controller.generation;
		const operation = controller.close().finally(() => {
			this.#registry.remove(id);
			this.#emit({ type: "session.closed", sessionId: id, generation });
		});
		const tracked = operation.finally(() => {
			if (this.#closing.get(id) === tracked) {
				this.#closing.delete(id);
			}
		});
		this.#closing.set(id, tracked);
		return tracked;
	}

	public onEvent(listener: PiHostEventListener): { dispose(): void } {
		this.#listeners.add(listener);
		return { dispose: () => this.#listeners.delete(listener) };
	}

	public async dispose(): Promise<void> {
		if (this.#disposePromise) {
			return this.#disposePromise;
		}
		this.#disposed = true;
		this.#disposePromise = (async () => {
			const startup = this.#startPromise;
			if (startup) await Promise.allSettled([startup]);
			await this.#pendingOpens.settle();
			const ids = this.#registry.ids();
			await Promise.allSettled(ids.map((id) => this.close(id)));
			this.#registry.clear();
			this.#closing.clear();
			this.#listeners.clear();
			this.#modelRuntime = undefined;
		})();
		return this.#disposePromise;
	}

	#runtimeFactory(sessionId: PiHostSessionId): CreateAgentSessionRuntimeFactory {
		return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
			const trusted = this.#isWorkspaceTrusted(cwd);
			const settingsManager = SettingsManager.create(cwd, agentDir, {
				projectTrusted: trusted,
			});
			// SDK attribution/install telemetry is opt-out. The extension never sends
			// analytics or product-attribution metadata without a future explicit opt-in.
			settingsManager.applyOverrides({
				enableAnalytics: false,
				enableInstallTelemetry: false,
			});
			const packageReadResources = await this.#packageReadResources();
			const authorizationGate = createToolAuthorizationExtension({
				sessionId,
				cwd,
				workspaceRoots: this.#workspaceRoots,
				packageReadResources,
				...(this.#authorizeToolCall === undefined ? {} : { authorize: this.#authorizeToolCall }),
			});
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				settingsManager,
				modelRuntime: this.#requireModelRuntime(),
				resourceLoaderOptions: {
					extensionFactories: [authorizationGate],
					extensionsOverride: (base) => ({
						...base,
						extensions: moveAuthorizationGateLast(base.extensions),
					}),
				},
				resourceLoaderReloadOptions: {
					resolveProjectTrust: async () => trusted,
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
				...(trusted ? {} : { tools: [...READ_ONLY_TOOLS] }),
			});
			return { ...created, services, diagnostics: services.diagnostics };
		};
	}

	#packageReadResources(): Promise<PackageReadResources> {
		if (!this.#packageReadResourcesPromise) {
			this.#packageReadResourcesPromise = resolvePiPackageReadResources();
		}
		return this.#packageReadResourcesPromise;
	}

	#controller(id: PiHostSessionId): PiSessionController {
		this.#assertUsable();
		return this.#registry.require(id);
	}

	#requireModelRuntime(): ModelRuntime {
		if (!this.#modelRuntime) {
			throw new PiHostError("host_not_started", "The Pi host has not finished starting.", false);
		}
		return this.#modelRuntime;
	}

	async #canonicalizeSessionFile(path: string): Promise<string> {
		const absolute = resolve(path);
		try {
			return await realpath(absolute);
		} catch {
			return absolute;
		}
	}

	#emitControllerError(controller: PiSessionController, error: PiErrorDto): void {
		const snapshot = controller.snapshot();
		this.#emit({
			type: "session.error",
			sessionId: controller.id,
			generation: snapshot.generation,
			error,
		});
	}

	#emit(event: PiHostEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (error) {
				this.#log("A Pi host event listener failed.", error);
			}
		}
	}

	#assertUsable(): void {
		if (this.#disposed) {
			throw new PiHostError("host_disposed", "The Pi host has already been disposed.", false);
		}
	}
}
