import { DuplicateSessionFileError, PiHostError } from "./errors.js";
import type { PiHostSessionId } from "./types.js";

interface RegistryRecord<T> {
	value: T | undefined;
	currentFile: string | undefined;
	pendingFile: string | undefined;
}

export class SessionRegistry<T> {
	readonly #records = new Map<PiHostSessionId, RegistryRecord<T>>();
	readonly #fileOwners = new Map<string, PiHostSessionId>();

	public begin(id: PiHostSessionId, currentFile?: string): void {
		if (this.#records.has(id)) {
			throw new PiHostError(
				"duplicate_session_id",
				"A Pi session with this identifier already exists.",
				false,
			);
		}
		if (currentFile) {
			this.#claimFile(id, currentFile);
		}
		this.#records.set(id, { value: undefined, currentFile, pendingFile: undefined });
	}

	public attach(id: PiHostSessionId, value: T): void {
		this.#record(id).value = value;
	}

	public get(id: PiHostSessionId): T | undefined {
		return this.#records.get(id)?.value;
	}

	public require(id: PiHostSessionId): T {
		const value = this.get(id);
		if (value === undefined) {
			throw new PiHostError("unknown_session", "This Pi chat session is no longer available.");
		}
		return value;
	}

	public reserveTransition(id: PiHostSessionId, nextFile: string): void {
		const entry = this.#record(id);
		if (entry.pendingFile === nextFile) {
			return;
		}
		this.#claimFile(id, nextFile);
		if (entry.pendingFile) {
			this.#releaseFile(id, entry.pendingFile);
		}
		entry.pendingFile = nextFile;
	}

	public commitTransition(id: PiHostSessionId, actualFile?: string): void {
		const entry = this.#record(id);
		const nextFile = actualFile ?? entry.pendingFile;
		if (entry.pendingFile && entry.pendingFile !== nextFile) {
			this.#releaseFile(id, entry.pendingFile);
		}
		if (nextFile && this.#fileOwners.get(nextFile) !== id) {
			this.#claimFile(id, nextFile);
		}
		if (entry.currentFile && entry.currentFile !== nextFile) {
			this.#releaseFile(id, entry.currentFile);
		}
		entry.currentFile = nextFile;
		entry.pendingFile = undefined;
	}

	public cancelTransition(id: PiHostSessionId): void {
		const entry = this.#record(id);
		if (entry.pendingFile && entry.pendingFile !== entry.currentFile) {
			this.#releaseFile(id, entry.pendingFile);
		}
		entry.pendingFile = undefined;
	}

	public ids(): PiHostSessionId[] {
		return [...this.#records.keys()];
	}

	public remove(id: PiHostSessionId): T | undefined {
		const entry = this.#records.get(id);
		if (!entry) {
			return undefined;
		}
		if (entry.currentFile) {
			this.#releaseFile(id, entry.currentFile);
		}
		if (entry.pendingFile && entry.pendingFile !== entry.currentFile) {
			this.#releaseFile(id, entry.pendingFile);
		}
		this.#records.delete(id);
		return entry.value;
	}

	public clear(): void {
		this.#records.clear();
		this.#fileOwners.clear();
	}

	#record(id: PiHostSessionId): RegistryRecord<T> {
		const entry = this.#records.get(id);
		if (!entry) {
			throw new PiHostError("unknown_session", "This Pi chat session is no longer available.");
		}
		return entry;
	}

	#claimFile(id: PiHostSessionId, file: string): void {
		const owner = this.#fileOwners.get(file);
		if (owner && owner !== id) {
			throw new DuplicateSessionFileError();
		}
		this.#fileOwners.set(file, id);
	}

	#releaseFile(id: PiHostSessionId, file: string): void {
		if (this.#fileOwners.get(file) === id) {
			this.#fileOwners.delete(file);
		}
	}
}
