import type { ChatMessage, ReferenceDescriptor } from "../../shared/protocol.js";
import { type ParsedReference, parseMessageReferences } from "./reference-parser.js";
import type { OpenTarget } from "./reference-registry.js";

interface ReferenceLease {
	readonly refId: string;
	readonly epoch: string;
}

export interface MessageReferenceIssuer {
	issue(target: OpenTarget, previous?: ReferenceLease): ReferenceLease;
}

interface CachedReferences {
	readonly text: string;
	readonly references: readonly ParsedReference[];
}

/** Avoids rescanning immutable history text on every streaming snapshot. */
export class MessageReferenceCache {
	readonly #entries = new WeakMap<ChatMessage, CachedReferences>();

	public constructor(
		private readonly parse: (
			markdown: string,
		) => readonly ParsedReference[] = parseMessageReferences,
	) {}

	public referencesFor(message: ChatMessage): readonly ParsedReference[] {
		const cached = this.#entries.get(message);
		if (cached?.text === message.text) return cached.references;
		const references = this.parse(message.text);
		this.remember(message, references);
		return references;
	}

	public remember(message: ChatMessage, references: readonly ParsedReference[]): void {
		this.#entries.set(message, { text: message.text, references });
	}
}

function descriptorKind(target: OpenTarget): ReferenceDescriptor["kind"] {
	return target.kind === "external" ? "external" : "file";
}

function descriptorKey(descriptor: ReferenceDescriptor): string {
	return `${descriptor.kind}\u0000${descriptor.label}`;
}

function sameDescriptors(
	left: readonly ReferenceDescriptor[] | undefined,
	right: readonly ReferenceDescriptor[],
): boolean {
	if (!left || left.length !== right.length) return false;
	return left.every((descriptor, index) => {
		const candidate = right[index];
		return (
			candidate !== undefined &&
			descriptor.refId === candidate.refId &&
			descriptor.epoch === candidate.epoch &&
			descriptor.label === candidate.label &&
			descriptor.kind === candidate.kind &&
			descriptor.ariaLabel === candidate.ariaLabel
		);
	});
}

/** Reissues stale opaque leases from the host-parsed message text. */
export function refreshMessageReferences(
	message: ChatMessage,
	issuer: MessageReferenceIssuer,
	cache?: MessageReferenceCache,
	maxReferences = Number.POSITIVE_INFINITY,
): ChatMessage {
	const previousByKey = new Map(
		(message.references ?? []).map((descriptor) => [descriptorKey(descriptor), descriptor]),
	);
	const allParsedReferences = cache?.referencesFor(message) ?? parseMessageReferences(message.text);
	const parsedReferences = allParsedReferences.slice(0, Math.max(0, maxReferences));
	const references = parsedReferences.map((parsed) => {
		const kind = descriptorKind(parsed.target);
		const previous = previousByKey.get(`${kind}\u0000${parsed.label}`);
		const lease = issuer.issue(parsed.target, previous);
		return {
			...lease,
			label: parsed.label,
			kind,
			ariaLabel:
				parsed.target.kind === "external"
					? `Open ${parsed.label} in browser`
					: `Open ${parsed.label} in the editor`,
		} satisfies ReferenceDescriptor;
	});
	if (sameDescriptors(message.references, references)) return message;
	const { references: _staleReferences, ...messageWithoutReferences } = message;
	const refreshed =
		references.length > 0 ? { ...messageWithoutReferences, references } : messageWithoutReferences;
	cache?.remember(refreshed, allParsedReferences);
	return refreshed;
}

function stripMessageReferences(message: ChatMessage): ChatMessage {
	if (message.references === undefined) return message;
	const { references: _references, ...withoutReferences } = message;
	return withoutReferences;
}

/** Issues a bounded, newest-first set of leases so one snapshot cannot evict itself. */
export function refreshHistoryReferences(
	messages: readonly ChatMessage[],
	issuer: MessageReferenceIssuer,
	cache: MessageReferenceCache,
	maxReferences = 2_048,
): ChatMessage[] {
	let remaining = Math.max(0, maxReferences);
	const refreshed = [...messages];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message) continue;
		if (remaining <= 0) {
			refreshed[index] = stripMessageReferences(message);
			continue;
		}
		const next = refreshMessageReferences(message, issuer, cache, remaining);
		remaining -= next.references?.length ?? 0;
		refreshed[index] = next;
	}
	return refreshed;
}
