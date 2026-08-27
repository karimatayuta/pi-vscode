import type { ContextResourceDragKind } from "../shared/drop-data.js";

/** Keeps the composer highlight stable while dragenter/dragleave bubble through children. */
export class ComposerDropTracker {
	#active = false;
	#depth = 0;

	public get active(): boolean {
		return this.#active;
	}

	public enter(kind: ContextResourceDragKind): boolean {
		if (kind !== "resource") return this.#active;
		this.#depth += 1;
		this.#active = true;
		return true;
	}

	public over(kind: ContextResourceDragKind): boolean {
		if (kind !== "resource") return this.#active;
		// The resource MIME can first appear on dragover, after an inconclusive dragenter.
		this.#depth = Math.max(1, this.#depth);
		this.#active = true;
		return true;
	}

	public leave(stillWithinComposer: boolean): boolean {
		if (!this.#active) return false;
		this.#depth = Math.max(0, this.#depth - 1);
		this.#active = stillWithinComposer || this.#depth > 0;
		if (!this.#active) this.#depth = 0;
		return this.#active;
	}

	public reset(): false {
		this.#active = false;
		this.#depth = 0;
		return false;
	}
}
