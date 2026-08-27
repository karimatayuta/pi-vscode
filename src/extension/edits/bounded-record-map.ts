export interface BoundedRecordMapOptions<T> {
	readonly maxEntries: number;
	readonly maxBytes: number;
	readonly sizeOf: (value: T) => number;
}

interface SizedRecord<T> {
	readonly value: T;
	readonly bytes: number;
}

/** Insertion-ordered LRU map with both entry and retained-byte limits. */
export class BoundedRecordMap<T> {
	readonly #records = new Map<string, SizedRecord<T>>();
	readonly #maxEntries: number;
	readonly #maxBytes: number;
	readonly #sizeOf: (value: T) => number;
	#bytes = 0;

	public constructor(options: BoundedRecordMapOptions<T>) {
		if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) {
			throw new Error("Record capacity must be a positive integer.");
		}
		if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
			throw new Error("Record byte capacity must be a positive integer.");
		}
		this.#maxEntries = options.maxEntries;
		this.#maxBytes = options.maxBytes;
		this.#sizeOf = options.sizeOf;
	}

	public get size(): number {
		return this.#records.size;
	}

	public get bytes(): number {
		return this.#bytes;
	}

	public get(key: string): T | undefined {
		const record = this.#records.get(key);
		if (!record) return undefined;
		this.#records.delete(key);
		this.#records.set(key, record);
		return record.value;
	}

	public set(key: string, value: T): readonly T[] {
		const bytes = this.#sizeOf(value);
		if (!Number.isSafeInteger(bytes) || bytes < 0) {
			throw new Error("Record size must be a non-negative safe integer.");
		}
		if (bytes > this.#maxBytes) {
			throw new Error("Record exceeds the retained-byte capacity.");
		}
		const replaced = this.#records.get(key);
		if (replaced) {
			this.#bytes -= replaced.bytes;
			this.#records.delete(key);
		}
		this.#records.set(key, { value, bytes });
		this.#bytes += bytes;

		const evicted: T[] = [];
		while (this.#records.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
			const oldestKey = this.#records.keys().next().value;
			if (!oldestKey) break;
			const oldest = this.#records.get(oldestKey);
			this.#records.delete(oldestKey);
			if (!oldest) continue;
			this.#bytes -= oldest.bytes;
			evicted.push(oldest.value);
		}
		return evicted;
	}

	public delete(key: string): T | undefined {
		const record = this.#records.get(key);
		if (!record) return undefined;
		this.#records.delete(key);
		this.#bytes -= record.bytes;
		return record.value;
	}

	public values(): IterableIterator<T> {
		return [...this.#records.values()].map((record) => record.value).values();
	}

	public clear(): void {
		this.#records.clear();
		this.#bytes = 0;
	}
}
