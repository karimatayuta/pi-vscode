export interface ActivationDisposable {
	dispose(): void | PromiseLike<void>;
}

/** Owns partially-created activation resources until VS Code assumes ownership. */
export class ActivationScope {
	#resources: ActivationDisposable[] = [];
	#finished = false;

	public add<T extends ActivationDisposable>(resource: T): T {
		if (this.#finished) throw new Error("The activation scope is already finished.");
		this.#resources.push(resource);
		return resource;
	}

	public commit(target: ActivationDisposable[]): void {
		if (this.#finished) throw new Error("The activation scope is already finished.");
		target.push(...this.#resources);
		this.#resources = [];
		this.#finished = true;
	}

	public async dispose(onError: (error: unknown) => void = () => undefined): Promise<void> {
		if (this.#finished) return;
		this.#finished = true;
		for (const resource of this.#resources.reverse()) {
			try {
				await resource.dispose();
			} catch (error) {
				onError(error);
			}
		}
		this.#resources = [];
	}
}
