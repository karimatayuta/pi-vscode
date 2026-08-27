export const MAX_PI_PROMPT_CHARACTERS = 16 * 1024 * 1024;
export const MAX_CONTEXT_RESOLUTION_BYTES = 8 * 1024 * 1024;
// One configured folder can contribute up to 2,000 files. The small global
// headroom keeps a bounded aggregate warning while still honoring that limit.
export const MAX_RESOLVED_CONTEXT_ITEMS = 2_048;
export const MAX_CONTEXT_METADATA_BYTES = 256 * 1024;
export const PROMPT_SERIALIZATION_MARGIN = 256 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8Length(value: string): number {
	return encoder.encode(value).byteLength;
}

export function truncatePromptUtf8(value: string, maxBytes: number): string {
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= maxBytes) return value;
	let end = Math.max(0, maxBytes);
	while (end > 0) {
		try {
			return decoder.decode(bytes.subarray(0, end));
		} catch {
			end -= 1;
		}
	}
	return "";
}
