/**
 * Serializes a high-frequency async task and retains at most one trailing run.
 *
 * Calling `request` while the task is active never creates an unbounded queue:
 * all requests received during that run collapse into one fresh execution.
 */
export class CoalescedTask {
	#pending = false;
	#running: Promise<void> | undefined;
	#disposed = false;

	public constructor(
		private readonly task: () => Promise<void>,
		private readonly onError: (error: unknown) => void = () => undefined,
	) {}

	public request(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		this.#pending = true;
		return this.#running ?? this.#start();
	}

	public dispose(): void {
		this.#disposed = true;
		this.#pending = false;
	}

	async #drain(): Promise<void> {
		do {
			this.#pending = false;
			try {
				await this.task();
			} catch (error) {
				try {
					this.onError(error);
				} catch {
					// A disposed logger must not turn an owned task failure into an
					// unhandled rejection.
				}
			}
		} while (this.#pending && !this.#disposed);
	}

	#start(): Promise<void> {
		const operation = this.#drain().finally(() => {
			if (this.#running === operation) this.#running = undefined;
		});
		this.#running = operation;
		return operation;
	}
}
