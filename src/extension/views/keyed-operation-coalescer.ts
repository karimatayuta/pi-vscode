/** Shares one in-flight operation per key and permits a fresh operation after settlement. */
export class KeyedOperationCoalescer<Key, Value> {
	readonly #operations = new Map<Key, Promise<Value>>();

	public run(key: Key, task: () => Promise<Value>): Promise<Value> {
		const existing = this.#operations.get(key);
		if (existing) return existing;

		// Install the shared promise before invoking task, preventing reentrant
		// callers from starting the same transaction during synchronous setup.
		const operation = Promise.resolve().then(task);
		this.#operations.set(key, operation);
		void operation.then(
			() => this.#delete(key, operation),
			() => this.#delete(key, operation),
		);
		return operation;
	}

	#delete(key: Key, operation: Promise<Value>): void {
		if (this.#operations.get(key) === operation) this.#operations.delete(key);
	}
}
