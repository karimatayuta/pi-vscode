import type { OpenTarget } from "./reference-registry.js";

export interface ParsedReference {
	readonly label: string;
	readonly target: OpenTarget;
}

// Keep bare URLs ASCII-bounded so adjacent CJK prose is not swallowed into the
// destination. Unicode IRIs remain available through deliberate Markdown links.
const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/giu;
const MARKDOWN_DESTINATION_PATTERN =
	/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*))(?:\s+["'][^"'\n]*["'])?\s*\)/gu;
const MARKDOWN_DEFINITION_PATTERN = /^[\t ]{0,3}\[[^\]\n]+\]:[\t ]*(?:<([^>\n]+)>|([^\s<>()]+))/gmu;
// Bare paths stop before prose whitespace and require a file-looking final
// segment. Deliberate links may still point at extensionless folders or paths
// containing spaces through normal Markdown link syntax.
const PATH_PATTERN =
	/(?<![\p{L}\p{N}_./\\@+-])((?:(?:\.\/)?(?:[\p{L}\p{N}_.@+-]+\/)+(?:[\p{L}\p{N}_.@+-]*\.[A-Za-z0-9][A-Za-z0-9+_-]{0,31}|README|LICENSE|CHANGELOG|Makefile|Dockerfile|Procfile|Gemfile|Rakefile|Justfile|Taskfile|WORKSPACE|BUILD|CODEOWNERS)|(?:\.\/)?(?:README(?:\.md)?|LICENSE(?:\.[A-Za-z0-9]+)?|CHANGELOG(?:\.md)?|Makefile|Dockerfile|Procfile|Gemfile|Rakefile|Justfile|Taskfile|WORKSPACE|BUILD|CODEOWNERS|package\.json|tsconfig\.json|biome\.json|bun\.lock|\.gitignore))(?:(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?)|(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?))?)(?![A-Za-z0-9_@+:-]|\.[A-Za-z0-9])/giu;
const COLON_POSITION_PATTERN = /:(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?$/u;
const HASH_POSITION_PATTERN = /#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C(\d+))?)?$/iu;
const MAX_REFERENCE_LABEL_LENGTH = 512;
const MAX_WORKSPACE_PATH_LENGTH = 8_192;

function stripTrailingUrlPunctuation(value: string): string {
	let output = value;
	while (/[.,;:!?]$/u.test(output)) {
		output = output.slice(0, -1);
	}
	while (
		output.endsWith(")") &&
		(output.match(/\)/gu)?.length ?? 0) > (output.match(/\(/gu)?.length ?? 0)
	) {
		output = output.slice(0, -1);
	}
	while (
		output.endsWith("]") &&
		(output.match(/\]/gu)?.length ?? 0) > (output.match(/\[/gu)?.length ?? 0)
	) {
		output = output.slice(0, -1);
	}
	return output;
}

/** Removes fenced and inline code so prose auto-linking never makes code executable-looking. */
function proseOnly(markdown: string): string {
	return markdown
		.replace(/```[\s\S]*?```/gu, (block) => " ".repeat(block.length))
		.replace(/~~~[\s\S]*?~~~/gu, (block) => " ".repeat(block.length))
		.replace(/`[^`\n]*`/gu, (block) => " ".repeat(block.length));
}

function safePositiveInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 10_000_000 ? parsed : undefined;
}

function hasControlCharacter(value: string): boolean {
	return [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
}

function decodedDestination(value: string): string | undefined {
	try {
		return decodeURIComponent(value.trim());
	} catch {
		return undefined;
	}
}

function workspaceTarget(
	rawDestination: string,
	allowExtensionless: boolean,
): ParsedReference | undefined {
	const label = decodedDestination(rawDestination);
	if (
		!label ||
		label.length > MAX_REFERENCE_LABEL_LENGTH ||
		label.length > MAX_WORKSPACE_PATH_LENGTH ||
		hasControlCharacter(label)
	)
		return undefined;

	let relativePath = label;
	let position: RegExpExecArray | null = HASH_POSITION_PATTERN.exec(relativePath);
	if (position) {
		relativePath = relativePath.slice(0, position.index);
	} else {
		position = COLON_POSITION_PATTERN.exec(relativePath);
		if (position) relativePath = relativePath.slice(0, position.index);
	}
	while (relativePath.startsWith("./")) relativePath = relativePath.slice(2);
	if (
		!relativePath ||
		relativePath.length > MAX_WORKSPACE_PATH_LENGTH ||
		relativePath.startsWith("/") ||
		relativePath.includes("\\") ||
		relativePath.includes("?") ||
		relativePath.includes("#") ||
		/^[A-Za-z][A-Za-z\d+.-]*:/u.test(relativePath)
	)
		return undefined;
	const segments = relativePath.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
	if (!allowExtensionless && !PATH_PATTERN.test(`x/${relativePath.split("/").at(-1) ?? ""}`)) {
		PATH_PATTERN.lastIndex = 0;
		return undefined;
	}
	PATH_PATTERN.lastIndex = 0;

	const line = safePositiveInteger(position?.[1]);
	const column = safePositiveInteger(position?.[2]);
	const endLine = safePositiveInteger(position?.[3]);
	const endColumn = safePositiveInteger(position?.[4]);
	if (position && line === undefined) return undefined;
	return {
		label,
		target: {
			kind: "workspace",
			relativePath,
			...(line === undefined ? {} : { line }),
			...(column === undefined ? {} : { column }),
			...(endLine === undefined ? {} : { endLine }),
			...(endColumn === undefined ? {} : { endColumn }),
		},
	};
}

function explicitTarget(rawDestination: string): ParsedReference | undefined {
	const label = rawDestination.trim();
	if (!label || label.length > MAX_REFERENCE_LABEL_LENGTH || hasControlCharacter(label))
		return undefined;
	try {
		const parsed = new URL(label);
		if (
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			!parsed.username &&
			!parsed.password
		) {
			return { label, target: { kind: "external", href: parsed.href } };
		}
	} catch {
		// A relative Markdown destination may be a workspace path.
	}
	return workspaceTarget(label, true);
}

function targetKey(target: OpenTarget): string {
	return target.kind === "external"
		? `url:${target.href}`
		: `path:${target.relativePath}:${target.line ?? ""}:${target.column ?? ""}:${target.endLine ?? ""}:${target.endColumn ?? ""}`;
}

export function parseMessageReferences(markdown: string, limit = 64): ParsedReference[] {
	const prose = proseOnly(markdown);
	const references: ParsedReference[] = [];
	const seen = new Set<string>();
	const addReference = (reference: ParsedReference): boolean => {
		const key = targetKey(reference.target);
		if (seen.has(key)) return false;
		seen.add(key);
		references.push(reference);
		return references.length >= limit;
	};

	for (const pattern of [MARKDOWN_DESTINATION_PATTERN, MARKDOWN_DEFINITION_PATTERN]) {
		pattern.lastIndex = 0;
		for (const match of prose.matchAll(pattern)) {
			const reference = explicitTarget(match[1] ?? match[2] ?? "");
			if (reference && addReference(reference)) return references;
		}
	}

	const bareProse = [MARKDOWN_DESTINATION_PATTERN, MARKDOWN_DEFINITION_PATTERN].reduce(
		(value, pattern) => value.replace(pattern, (markdownLink) => " ".repeat(markdownLink.length)),
		prose,
	);
	for (const match of bareProse.matchAll(URL_PATTERN)) {
		const href = stripTrailingUrlPunctuation(match[0]);
		if (!href || href.length > MAX_REFERENCE_LABEL_LENGTH) continue;
		try {
			const parsed = new URL(href);
			if (
				(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
				parsed.username ||
				parsed.password
			)
				continue;
			if (addReference({ label: href, target: { kind: "external", href: parsed.href } })) {
				return references;
			}
		} catch {
			// Ignore malformed prose URLs.
		}
	}

	PATH_PATTERN.lastIndex = 0;
	for (const match of bareProse.matchAll(PATH_PATTERN)) {
		const reference = workspaceTarget(match[1] ?? "", false);
		if (reference && addReference(reference)) return references;
	}
	return references;
}
