export interface WorkspaceTrustReloadActions {
	/** Enters the fail-closed state before any asynchronous reload work starts. */
	readonly enterReloadRequired: () => void;
	readonly announceReload: () => PromiseLike<unknown>;
	readonly reloadWindow: () => PromiseLike<unknown>;
	readonly reportAnnouncementFailure: (error: unknown) => void;
	readonly handleReloadFailure: (error: unknown) => void;
}

/**
 * Captures whether this Extension Host was activated for a trusted workspace.
 * A later trust grant cannot elevate a live Pi runtime; only a new Extension
 * Host may construct trusted sessions.
 */
export class WorkspaceTrustState {
	#trusted: boolean;
	#reloadRequired = false;

	public constructor(initiallyTrusted: boolean) {
		this.#trusted = initiallyTrusted;
	}

	public get trusted(): boolean {
		return this.#trusted;
	}

	public get reloadRequired(): boolean {
		return this.#reloadRequired;
	}

	public requireReload(): boolean {
		if (this.#reloadRequired) return false;
		this.#trusted = false;
		this.#reloadRequired = true;
		return true;
	}
}

/**
 * Owns the one-shot transition after VS Code grants Workspace Trust. The
 * notification is intentionally not awaited: a passive toast must never hold
 * up the security-sensitive window reload.
 */
export class WorkspaceTrustReloadCoordinator {
	#operation: Promise<void> | undefined;

	public constructor(private readonly actions: WorkspaceTrustReloadActions) {}

	public handleGrant(): Promise<void> {
		if (this.#operation) return this.#operation;
		this.actions.enterReloadRequired();
		this.#announce();
		this.#operation = this.#reload();
		return this.#operation;
	}

	#announce(): void {
		try {
			void Promise.resolve(this.actions.announceReload()).catch((error) => {
				this.actions.reportAnnouncementFailure(error);
			});
		} catch (error) {
			this.actions.reportAnnouncementFailure(error);
		}
	}

	async #reload(): Promise<void> {
		try {
			await this.actions.reloadWindow();
		} catch (error) {
			this.actions.handleReloadFailure(error);
		}
	}
}
