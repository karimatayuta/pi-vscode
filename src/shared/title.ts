export const NEW_CHAT_TITLE = "New chat";
export const GENERATED_TITLE_MAX_LENGTH = 48;
export const MANUAL_TITLE_MAX_LENGTH = 80;

export type ChatTitleSource = "placeholder" | "generated" | "fallback" | "manual";

export interface ChatTitleState {
	readonly value: string;
	readonly source: ChatTitleSource;
	/** Prevents late title-generation events from overwriting a user rename. */
	readonly renameLocked: boolean;
}

export type RenameTitleResult =
	| { readonly ok: true; readonly state: ChatTitleState }
	| {
			readonly ok: false;
			readonly code: "empty" | "too-long";
			readonly message: string;
	  };

export function createChatTitleState(): ChatTitleState {
	return {
		value: NEW_CHAT_TITLE,
		source: "placeholder",
		renameLocked: false,
	};
}

function redactSecretLikeText(input: string): string {
	return input
		.replace(
			/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=]\s*[^\s,;]+/giu,
			"[redacted]",
		)
		.replace(/\b(?:sk|pk|token|secret)[-_][A-Za-z0-9_-]{8,}\b/giu, "[redacted]");
}

function replaceControlCharacters(input: string): string {
	return [...input]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
		})
		.join("");
}

function cleanTitleText(input: string): string {
	return replaceControlCharacters(redactSecretLikeText(input))
		.replace(/```[\s\S]*?```/gu, " ")
		.replace(/[`*_~#>]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

export function sanitizePersistedTitle(input: unknown): string {
	if (typeof input !== "string") return NEW_CHAT_TITLE;
	const cleaned = cleanTitleText(input);
	return cleaned.length > 0 ? truncateTitle(cleaned, MANUAL_TITLE_MAX_LENGTH) : NEW_CHAT_TITLE;
}

export function truncateTitle(input: string, maxLength: number): string {
	const characters = [...input];
	if (characters.length <= maxLength) {
		return input;
	}
	if (maxLength <= 1) {
		return "…".slice(0, maxLength);
	}
	return `${characters
		.slice(0, maxLength - 1)
		.join("")
		.trimEnd()}…`;
}

export function createFallbackTitle(
	prompt: string,
	maxLength = GENERATED_TITLE_MAX_LENGTH,
): string {
	const cleaned = cleanTitleText(prompt);
	return cleaned.length === 0 ? NEW_CHAT_TITLE : truncateTitle(cleaned, maxLength);
}

export function sanitizeGeneratedTitle(
	generated: string,
	fallbackPrompt: string,
): { readonly value: string; readonly source: "generated" | "fallback" } {
	const withoutPrefix = generated
		.replace(/^\s*(?:title|chat title)\s*:\s*/iu, "")
		.replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "");
	const cleaned = cleanTitleText(withoutPrefix);

	if (cleaned.length === 0) {
		return {
			value: createFallbackTitle(fallbackPrompt),
			source: "fallback",
		};
	}

	// English-like generated titles are kept deliberately scannable. CJK titles
	// generally contain no spaces and are bounded by the character limit below.
	const words = cleaned.split(/\s+/u);
	const concise = words.length > 7 ? words.slice(0, 7).join(" ") : cleaned;
	return {
		value: truncateTitle(concise, GENERATED_TITLE_MAX_LENGTH),
		source: "generated",
	};
}

export function applyGeneratedTitle(
	state: ChatTitleState,
	generated: string,
	fallbackPrompt: string,
): ChatTitleState {
	if (state.renameLocked) {
		return state;
	}
	const next = sanitizeGeneratedTitle(generated, fallbackPrompt);
	return {
		value: next.value,
		source: next.source,
		renameLocked: false,
	};
}

export function renameChatTitle(_state: ChatTitleState, requestedTitle: string): RenameTitleResult {
	const value = replaceControlCharacters(requestedTitle).replace(/\s+/gu, " ").trim();
	if (value.length === 0) {
		return {
			ok: false,
			code: "empty",
			message: "Chat title cannot be empty.",
		};
	}
	if ([...value].length > MANUAL_TITLE_MAX_LENGTH) {
		return {
			ok: false,
			code: "too-long",
			message: `Chat title cannot exceed ${MANUAL_TITLE_MAX_LENGTH} characters.`,
		};
	}
	return {
		ok: true,
		state: {
			value,
			source: "manual",
			renameLocked: true,
		},
	};
}

/** Explicitly permits the next generated title to replace a manual title. */
export function unlockTitleForRegeneration(state: ChatTitleState): ChatTitleState {
	return state.renameLocked ? { ...state, renameLocked: false } : state;
}
