import { randomUUID } from "node:crypto";

export interface OpaqueReferenceLease {
	readonly refId: string;
	readonly epoch: string;
}

interface StoredReference<T> {
	readonly target: T;
	readonly epoch: string;
	readonly expiresAt: number;
}

export interface OpaqueReferenceStoreOptions<T> {
	readonly ttlMs?: number;
	readonly maxEntries?: number;
	readonly now?: () => number;
	readonly createId?: () => string;
	readonly equals?: (left: T, right: T) => boolean;
}

export const DEFAULT_OPAQUE_REFERENCE_TTL_MS = 30 * 60_000;
export const OPAQUE_REFERENCE_REFRESH_INTERVAL_MS = 20 * 60_000;
const DEFAULT_MAX_ENTRIES = 4_096;

/**
 * Keeps Webview references opaque and short-lived while allowing a freshly
 * rendered snapshot to renew or replace its previous lease.
 */
export class OpaqueReferenceStore<T> {
	readonly #entries = new Map<string, StoredReference<T>>();
	readonly #ttlMs: number;
	readonly #maxEntries: number;
	readonly #now: () => number;
	readonly #createId: () => string;
	readonly #equals: (left: T, right: T) => boolean;
	#epoch: string;

	public constructor(options: OpaqueReferenceStoreOptions<T> = {}) {
		this.#ttlMs = options.ttlMs ?? DEFAULT_OPAQUE_REFERENCE_TTL_MS;
		this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.#now = options.now ?? Date.now;
		this.#createId = options.createId ?? randomUUID;
		this.#equals = options.equals ?? Object.is;
		if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) {
			throw new Error("Reference TTL must be a positive number.");
		}
		if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries <= 0) {
			throw new Error("Reference capacity must be a positive integer.");
		}
		this.#epoch = this.#createId();
	}

	public get epoch(): string {
		return this.#epoch;
	}

	public invalidate(): void {
		this.#entries.clear();
		this.#epoch = this.#createId();
	}

	public issue(
		target: T,
		previous?: OpaqueReferenceLease,
		ttlMs = this.#ttlMs,
	): OpaqueReferenceLease {
		const now = this.#now();
		this.#pruneExpired(now);
		if (previous?.epoch === this.#epoch) {
			const existing = this.#entries.get(previous.refId);
			if (
				existing?.epoch === this.#epoch &&
				existing.expiresAt >= now &&
				this.#equals(existing.target, target)
			) {
				// Move a reference used by the latest snapshot to the back of the
				// insertion-ordered map so capacity pressure removes dormant leases first.
				this.#entries.delete(previous.refId);
				this.#entries.set(previous.refId, {
					target: existing.target,
					epoch: existing.epoch,
					expiresAt: now + this.#validTtl(ttlMs),
				});
				return previous;
			}
		}
		return this.#register(target, now, ttlMs);
	}

	public resolve(refId: string, epoch: string): T | undefined {
		if (epoch !== this.#epoch) return undefined;
		const entry = this.#entries.get(refId);
		if (!entry || entry.epoch !== this.#epoch) return undefined;
		if (entry.expiresAt < this.#now()) {
			this.#entries.delete(refId);
			return undefined;
		}
		return entry.target;
	}

	#register(target: T, now: number, ttlMs: number): OpaqueReferenceLease {
		while (this.#entries.size >= this.#maxEntries) {
			const oldest = this.#entries.keys().next().value;
			if (!oldest) break;
			this.#entries.delete(oldest);
		}
		const refId = this.#createId();
		this.#entries.set(refId, {
			target,
			epoch: this.#epoch,
			expiresAt: now + this.#validTtl(ttlMs),
		});
		return { refId, epoch: this.#epoch };
	}

	#pruneExpired(now: number): void {
		for (const [refId, entry] of this.#entries) {
			if (entry.expiresAt < now) this.#entries.delete(refId);
		}
	}

	#validTtl(ttlMs: number): number {
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
			throw new Error("Reference TTL must be a positive number.");
		}
		return ttlMs;
	}
}
