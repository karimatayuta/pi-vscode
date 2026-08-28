import { PiHostError } from "../pi/errors.js";
import type {
	PiCommandDto,
	PiDisposable,
	PiHostApi,
	PiHostEvent,
	PiHostSessionId,
	PiModelCatalogDto,
	PiPromptDelivery,
	PiPromptInput,
	PiSessionBootstrapDto,
	PiSessionOpenTarget,
	PiSessionReplaceTarget,
	PiSessionSnapshotDto,
	PiThinkingLevel,
} from "../pi/types.js";

export type ChatSessionEventListener = (event: PiHostEvent) => void;
export type ChatSessionBackgroundErrorReporter = (message: string, error: unknown) => void;

/**
 * Owns one Pi session for one chat tab. The extension activation owns the shared
 * PiHostService; a ChatViewProvider creates one controller per visible tab.
 */
export class ChatSessionController implements PiDisposable {
	readonly #listeners = new Set<ChatSessionEventListener>();
	readonly #hostSubscription: PiDisposable;
	#sessionId: PiHostSessionId | undefined;
	#snapshot: PiSessionSnapshotDto | undefined;
	#openPromise: Promise<PiSessionBootstrapDto> | undefined;
	#closePromise: Promise<void> | undefined;
	#disposed = false;

	public constructor(
		private readonly host: PiHostApi,
		private readonly reportBackgroundError: ChatSessionBackgroundErrorReporter = () => undefined,
	) {
		this.#hostSubscription = host.onEvent((event) => this.#handleHostEvent(event));
	}

	public get sessionId(): PiHostSessionId | undefined {
		return this.#sessionId;
	}

	public get snapshot(): PiSessionSnapshotDto | undefined {
		return this.#snapshot;
	}

	public async open(input: {
		readonly cwd: string;
		readonly target: PiSessionOpenTarget;
	}): Promise<PiSessionBootstrapDto> {
		this.#assertUsable();
		if (this.#sessionId) {
			throw new PiHostError("session_already_open", "This chat tab already has a Pi session.");
		}
		if (this.#openPromise) {
			return this.#openPromise;
		}
		this.#openPromise = this.host.open(input).then((bootstrap) => {
			if (this.#disposed) {
				this.#closeInBackground(bootstrap.snapshot.id);
				throw new PiHostError(
					"controller_disposed",
					"This chat tab was closed while Pi was starting.",
					false,
				);
			}
			this.#acceptBootstrap(bootstrap);
			return bootstrap;
		});
		try {
			return await this.#openPromise;
		} finally {
			this.#openPromise = undefined;
		}
	}

	public async replace(target: PiSessionReplaceTarget): Promise<PiSessionBootstrapDto> {
		const bootstrap = await this.host.replace(this.#requireId(), target);
		this.#acceptBootstrap(bootstrap);
		return bootstrap;
	}

	public async send(input: PiPromptInput): Promise<void> {
		await this.host.send(this.#requireId(), input);
	}

	public async commands(): Promise<readonly PiCommandDto[]> {
		return this.host.listCommands(this.#requireId());
	}

	public async invokeCommand(
		invocation: string,
		args?: string,
		delivery?: PiPromptDelivery,
	): Promise<void> {
		await this.host.invokeCommand(this.#requireId(), invocation, args, delivery);
	}

	public async models(signal?: AbortSignal): Promise<PiModelCatalogDto> {
		this.#assertUsable();
		return this.host.listModels(signal);
	}

	public async setModel(
		ref: { readonly provider: string; readonly id: string },
		persist = false,
	): Promise<PiSessionSnapshotDto> {
		return this.#acceptSnapshot(await this.host.setModel(this.#requireId(), ref, persist));
	}

	public async setThinking(level: PiThinkingLevel, persist = false): Promise<PiSessionSnapshotDto> {
		return this.#acceptSnapshot(await this.host.setThinking(this.#requireId(), level, persist));
	}

	public async applyModelSettings(
		ref: { readonly provider: string; readonly id: string },
		thinking: PiThinkingLevel,
		persist = false,
	): Promise<PiSessionSnapshotDto> {
		const current = this.#snapshot;
		const modelChanged = current?.model?.provider !== ref.provider || current.model.id !== ref.id;
		let applied = current;
		if (modelChanged || persist) applied = await this.setModel(ref, persist);
		if (!applied || persist || applied.thinkingLevel !== thinking) {
			applied = await this.setThinking(thinking, persist);
		}
		return applied;
	}

	public async setTitle(title: string): Promise<PiSessionSnapshotDto> {
		return this.#acceptSnapshot(await this.host.setTitle(this.#requireId(), title));
	}

	public async compact(customInstructions?: string): Promise<PiSessionSnapshotDto> {
		return this.#acceptSnapshot(await this.host.compact(this.#requireId(), customInstructions));
	}

	public async abort(): Promise<void> {
		await this.host.abort(this.#requireId());
	}

	public async close(): Promise<void> {
		if (this.#closePromise) {
			return this.#closePromise;
		}
		const id = this.#sessionId;
		if (!id) {
			return;
		}
		this.#closePromise = this.host.close(id).finally(() => {
			if (this.#sessionId === id) {
				this.#sessionId = undefined;
				this.#snapshot = undefined;
			}
			this.#closePromise = undefined;
		});
		return this.#closePromise;
	}

	public onEvent(listener: ChatSessionEventListener): PiDisposable {
		this.#assertUsable();
		this.#listeners.add(listener);
		return { dispose: () => this.#listeners.delete(listener) };
	}

	public dispose(): void {
		if (this.#disposed) {
			return;
		}
		this.#disposed = true;
		this.#hostSubscription.dispose();
		this.#listeners.clear();
		const id = this.#sessionId;
		this.#sessionId = undefined;
		this.#snapshot = undefined;
		if (id) {
			this.#closeInBackground(id);
		}
	}

	#closeInBackground(id: PiHostSessionId): void {
		void this.host.close(id).catch((error) => {
			try {
				this.reportBackgroundError("Could not close a Pi Agent session in the background.", error);
			} catch {
				// Error reporting must not turn a handled close failure into an unhandled rejection.
			}
		});
	}

	#acceptBootstrap(bootstrap: PiSessionBootstrapDto): void {
		if (this.#sessionId && this.#sessionId !== bootstrap.snapshot.id) {
			throw new PiHostError(
				"session_identity_changed",
				"Pi returned a session for a different chat tab.",
				false,
			);
		}
		this.#sessionId = bootstrap.snapshot.id;
		this.#acceptSnapshot(bootstrap.snapshot);
	}

	#acceptSnapshot(snapshot: PiSessionSnapshotDto): PiSessionSnapshotDto {
		if (this.#sessionId && snapshot.id !== this.#sessionId) {
			return this.#snapshot ?? snapshot;
		}
		if (!this.#snapshot || snapshot.generation >= this.#snapshot.generation) {
			this.#snapshot = snapshot;
		}
		return this.#snapshot;
	}

	#handleHostEvent(event: PiHostEvent): void {
		if (this.#disposed || event.sessionId !== this.#sessionId) {
			return;
		}
		const currentGeneration = this.#snapshot?.generation ?? 0;
		if (event.generation < currentGeneration) {
			return;
		}
		if (event.type === "session.bootstrap") {
			this.#acceptBootstrap(event.bootstrap);
		} else if (event.type === "session.snapshot") {
			this.#acceptSnapshot(event.snapshot);
		} else if (event.type === "session.state" && this.#snapshot) {
			// State events are the authoritative busy/idle transition. Keep the
			// cached snapshot in sync so host-side guards do not retain a stale
			// `busy: true` after the agent settles.
			this.#snapshot = {
				...this.#snapshot,
				phase: event.phase,
				busy: event.busy,
			};
		} else if (event.type === "session.stats" && this.#snapshot) {
			this.#snapshot = { ...this.#snapshot, stats: event.stats };
		} else if (event.type === "session.closed") {
			this.#sessionId = undefined;
			this.#snapshot = undefined;
		}
		for (const listener of this.#listeners) {
			listener(event);
		}
	}

	#requireId(): PiHostSessionId {
		this.#assertUsable();
		if (!this.#sessionId) {
			throw new PiHostError("session_not_open", "Open a Pi session for this chat tab first.");
		}
		return this.#sessionId;
	}

	#assertUsable(): void {
		if (this.#disposed) {
			throw new PiHostError(
				"controller_disposed",
				"This chat tab has already been disposed.",
				false,
			);
		}
	}
}
