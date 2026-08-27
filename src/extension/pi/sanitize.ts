import type { PiJsonValue } from "./types.js";

const SENSITIVE_KEY =
	/^(?:api[-_]?key|authorization|password|passwd|secret|access[-_]?token|refresh[-_]?token|cookie|set-cookie|headers?)$/iu;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const COMMON_KEY_VALUE = /\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/gu;
const SECRET_ASSIGNMENT =
	/\b((?:[A-Za-z_][A-Za-z0-9_-]*)?(?:api[-_]?key|token|secret|password|passwd|credential|private[-_]?key)[A-Za-z0-9_-]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/giu;
const SECRET_HEADER =
	/\b((?:[A-Za-z_][A-Za-z0-9_-]*)?(?:api[-_]?key|token|secret|password|passwd|credential|private[-_]?key)[A-Za-z0-9_-]*)\s*:\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const AUTHORIZATION_HEADER = /\b(authorization\s*:\s*)(?:[A-Za-z][A-Za-z0-9_-]*\s+)?[^\s,;]+/giu;
const SECRET_ARGUMENT =
	/(--?(?:api[-_]?key|token|secret|password|passwd|credential)(?:=|\s+))(?:(?:"[^"]*"|'[^']*'|[^\s;&|]+))/giu;
const JSON_SECRET =
	/("(?:api[-_]?key|token|secret|password|passwd|credential|private[-_]?key)"\s*:\s*)"[^"]*"/giu;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu;
const PRIVATE_KEY_BLOCK =
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu;

function stripControlCharacters(value: string): string {
	return [...value]
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code > 31 || code === 9 || code === 10 || code === 13;
		})
		.filter((character) => character.charCodeAt(0) !== 127)
		.join("");
}

export interface SanitizeLimits {
	readonly maxDepth: number;
	readonly maxArrayItems: number;
	readonly maxObjectKeys: number;
	readonly maxStringLength: number;
}

export const DEFAULT_SANITIZE_LIMITS: SanitizeLimits = {
	maxDepth: 6,
	maxArrayItems: 128,
	maxObjectKeys: 64,
	maxStringLength: 64 * 1024,
};

export function redactString(
	value: string,
	maxLength = DEFAULT_SANITIZE_LIMITS.maxStringLength,
): string {
	const normalized = stripControlCharacters(value)
		.replace(PRIVATE_KEY_BLOCK, "[redacted-private-key]")
		.replace(URL_CREDENTIALS, "$1[redacted]@")
		.replace(AUTHORIZATION_HEADER, "$1[redacted]")
		.replace(SECRET_HEADER, "$1: [redacted]")
		.replace(SECRET_ASSIGNMENT, "$1=[redacted]")
		.replace(SECRET_ARGUMENT, "$1[redacted]")
		.replace(JSON_SECRET, '$1"[redacted]"')
		.replace(BEARER_VALUE, "Bearer [redacted]")
		.replace(COMMON_KEY_VALUE, "[redacted-key]");
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, maxLength)}\n…[truncated]`;
}

export function safeErrorMessage(error: unknown, fallback = "Pi operation failed."): string {
	if (error instanceof Error) {
		return redactString(error.message || fallback, 8_192);
	}
	if (typeof error === "string") {
		return redactString(error || fallback, 8_192);
	}
	return fallback;
}

export function toSafeJson(
	value: unknown,
	limits: SanitizeLimits = DEFAULT_SANITIZE_LIMITS,
): PiJsonValue {
	const seen = new WeakSet<object>();

	const visit = (input: unknown, depth: number, propertyName?: string): PiJsonValue => {
		if (input === null) {
			return null;
		}
		if (typeof input === "string") {
			if (propertyName === "data" && input.length > 256) {
				return "[binary omitted]";
			}
			return redactString(input, limits.maxStringLength);
		}
		if (typeof input === "number") {
			return Number.isFinite(input) ? input : String(input);
		}
		if (typeof input === "boolean") {
			return input;
		}
		if (typeof input === "bigint") {
			return input.toString();
		}
		if (typeof input === "undefined" || typeof input === "function" || typeof input === "symbol") {
			return null;
		}
		if (depth >= limits.maxDepth) {
			return "[depth limit]";
		}
		if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) {
			return "[binary omitted]";
		}
		if (Array.isArray(input)) {
			const items = input.slice(0, limits.maxArrayItems).map((item) => visit(item, depth + 1));
			if (input.length > limits.maxArrayItems) {
				items.push(`[${input.length - limits.maxArrayItems} more items]`);
			}
			return items;
		}
		if (typeof input === "object") {
			if (seen.has(input)) {
				return "[circular]";
			}
			seen.add(input);
			const output: Record<string, PiJsonValue> = {};
			let entries: [string, unknown][];
			try {
				entries = Object.entries(input);
			} catch {
				return "[unreadable object]";
			}
			for (const [key, item] of entries.slice(0, limits.maxObjectKeys)) {
				if (SENSITIVE_KEY.test(key)) {
					output[key] = "[redacted]";
					continue;
				}
				output[key] = visit(item, depth + 1, key);
			}
			if (entries.length > limits.maxObjectKeys) {
				output.__truncated__ = `${entries.length - limits.maxObjectKeys} more keys`;
			}
			return output;
		}
		return null;
	};

	return visit(value, 0);
}
