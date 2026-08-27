/** Monotonic token guard for async UI requests where only the latest result is relevant. */
export class LatestRequest {
	#generation = 0;

	public begin(): number {
		this.#generation += 1;
		return this.#generation;
	}

	public isCurrent(generation: number): boolean {
		return generation === this.#generation;
	}

	public invalidate(): void {
		this.#generation += 1;
	}
}
