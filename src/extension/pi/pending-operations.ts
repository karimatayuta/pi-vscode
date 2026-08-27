/** Tracks a bounded-lifetime set of operations so an owner can drain them on disposal. */
export class PendingOperations {
	readonly #operations = new Set<Promise<unknown>>();

	public track<T>(operation: Promise<T>): Promise<T> {
		this.#operations.add(operation);
		void operation.then(
			() => this.#operations.delete(operation),
			() => this.#operations.delete(operation),
		);
		return operation;
	}

	public async settle(): Promise<void> {
		while (this.#operations.size > 0) {
			await Promise.allSettled([...this.#operations]);
		}
	}
}
