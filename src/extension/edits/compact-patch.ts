export interface CompactPatch {
	readonly patch: string;
	readonly additions: number;
	readonly deletions: number;
}

const DEFAULT_MAX_PATCH_CHARACTERS = 200_000;
const CONTEXT_LINES = 3;

function lines(value: string): string[] {
	if (value.length === 0) return [];
	const normalized = value.replaceAll("\r\n", "\n");
	const output = normalized.split("\n");
	if (normalized.endsWith("\n")) output.pop();
	return output;
}

function boundedPatch(parts: readonly string[], maxCharacters: number): string {
	let output = "";
	for (const part of parts) {
		if (output.length + part.length + 1 > maxCharacters) {
			return `${output}… diff preview truncated …\n`;
		}
		output += `${part}\n`;
	}
	return output;
}

/**
 * Builds one bounded unified-diff hunk around the changed middle of a file.
 * Pi's built-in edit/write tool has already performed the mutation when this
 * is called; the result is a review artifact and must never be executed again.
 */
export function createCompactPatch(
	path: string,
	before: string,
	after: string,
	maxCharacters = DEFAULT_MAX_PATCH_CHARACTERS,
): CompactPatch | undefined {
	if (before === after) return undefined;
	const oldLines = lines(before);
	const newLines = lines(after);
	let prefix = 0;
	while (
		prefix < oldLines.length &&
		prefix < newLines.length &&
		oldLines[prefix] === newLines[prefix]
	) {
		prefix += 1;
	}
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix += 1;
	}
	const oldChangedEnd = oldLines.length - suffix;
	const newChangedEnd = newLines.length - suffix;
	const deletions = oldChangedEnd - prefix;
	const additions = newChangedEnd - prefix;
	const contextStart = Math.max(0, prefix - CONTEXT_LINES);
	const oldContextEnd = Math.min(oldLines.length, oldChangedEnd + CONTEXT_LINES);
	const newContextEnd = Math.min(newLines.length, newChangedEnd + CONTEXT_LINES);
	const safePath = path.replace(/[\r\n]/gu, " ");
	const parts = [
		`--- a/${safePath}`,
		`+++ b/${safePath}`,
		`@@ -${contextStart + 1},${oldContextEnd - contextStart} +${contextStart + 1},${newContextEnd - contextStart} @@`,
		...oldLines.slice(contextStart, prefix).map((line) => ` ${line}`),
		...oldLines.slice(prefix, oldChangedEnd).map((line) => `-${line}`),
		...newLines.slice(prefix, newChangedEnd).map((line) => `+${line}`),
		...newLines.slice(newChangedEnd, newContextEnd).map((line) => ` ${line}`),
	];
	return {
		patch: boundedPatch(parts, Math.max(1_024, maxCharacters)),
		additions,
		deletions,
	};
}
