/**
 * Serializes lifecycle mutations and rejects both newly submitted and queued
 * work after closing begins. `beginClose` resolves after all prior work settles.
 */
export class CloseAwareOperationQueue {
	#tail: Promise<void> = Promise.resolve();
	#closing = false;

	public constructor(private readonly closedError: () => Error) {}

	public get closing(): boolean {
		return this.#closing;
	}

	public run<T>(operation: () => Promise<T>): Promise<T> {
		this.#assertAccepting();
		const execute = () => {
			this.#assertAccepting();
			return operation();
		};
		const result = this.#tail.then(execute, execute);
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	public beginClose(): Promise<void> {
		this.#closing = true;
		return this.#tail;
	}

	#assertAccepting(): void {
		if (this.#closing) throw this.closedError();
	}
}
