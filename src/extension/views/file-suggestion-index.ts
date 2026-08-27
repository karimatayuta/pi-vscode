import type { FileSuggestion } from "../../shared/protocol.js";

export interface IndexedFileSuggestion<T> {
	readonly suggestion: FileSuggestion;
	readonly target: T;
}

/**
 * Keeps Webview suggestion IDs bound to the exact host-side resource returned
 * by the latest search. Replacing a query invalidates every prior ID.
 */
export class FileSuggestionIndex<T> {
	readonly #targets = new Map<string, T>();

	public constructor(private readonly maxEntries = 40) {
		if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
			throw new Error("File suggestion capacity must be a positive integer.");
		}
	}

	public replace(entries: readonly IndexedFileSuggestion<T>[]): FileSuggestion[] {
		this.#targets.clear();
		const suggestions: FileSuggestion[] = [];
		for (const entry of entries) {
			if (suggestions.length >= this.maxEntries) break;
			if (this.#targets.has(entry.suggestion.id)) continue;
			this.#targets.set(entry.suggestion.id, entry.target);
			suggestions.push(entry.suggestion);
		}
		return suggestions;
	}

	public resolve(id: string): T | undefined {
		return this.#targets.get(id);
	}

	public clear(): void {
		this.#targets.clear();
	}
}
