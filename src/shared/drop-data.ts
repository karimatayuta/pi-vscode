/** MIME types VS Code and Electron may expose for local resource drags. */
export const DROP_MIME_TYPES = {
	uriList: "text/uri-list",
	internalUriList: "application/vnd.code.uri-list",
	resources: "ResourceURLs",
	codeFiles: "CodeFiles",
	plainText: "text/plain",
	files: "files",
} as const;

export const READABLE_DROP_MIME_TYPES: readonly string[] = [
	DROP_MIME_TYPES.uriList,
	DROP_MIME_TYPES.internalUriList,
	DROP_MIME_TYPES.resources,
	DROP_MIME_TYPES.codeFiles,
	DROP_MIME_TYPES.plainText,
];

const MAX_DROP_ITEMS = 256;
const MAX_DROP_ITEM_LENGTH = 8_192;

export interface DropDataReader {
	getData(mimeType: string): string;
	readonly files?: ArrayLike<unknown>;
	readonly types?: ArrayLike<string>;
}

export interface DropItemDescriptor {
	readonly kind?: string;
	readonly type?: string;
}

export type ContextResourceDragKind = "resource" | "text" | "unknown";

export type DropPayloads = Readonly<Record<string, string | undefined>>;

/** True for resource drags, while intentionally excluding ordinary selected text. */
export function hasContextResourceDropType(types: ArrayLike<string>): boolean {
	const supported = new Set(
		[
			DROP_MIME_TYPES.uriList,
			DROP_MIME_TYPES.internalUriList,
			DROP_MIME_TYPES.resources,
			DROP_MIME_TYPES.codeFiles,
			DROP_MIME_TYPES.files,
		].map((mime) => mime.toLocaleLowerCase()),
	);
	for (let index = 0; index < types.length; index += 1) {
		const mime = types[index];
		if (mime && supported.has(mime.toLocaleLowerCase())) return true;
	}
	return false;
}

/**
 * Classify the currently visible drag metadata. Drag data is protected while a
 * drag is in flight, and VS Code/Electron may expose its resource MIME only on a
 * later dragover event. File-kind items are therefore accepted as a strong
 * resource signal even when `types` is still empty. Plain text remains an
 * explicit non-resource signal so dragging an editor selection cannot turn into
 * an attachment by accident.
 */
export function classifyContextResourceDrag(
	types: ArrayLike<string>,
	items?: ArrayLike<DropItemDescriptor>,
): ContextResourceDragKind {
	if (hasContextResourceDropType(types)) return "resource";

	let hasText = false;
	for (let index = 0; index < types.length; index += 1) {
		const type = types[index]?.toLocaleLowerCase();
		if (type?.startsWith("text/")) hasText = true;
	}

	if (items) {
		for (let index = 0; index < items.length; index += 1) {
			const item = items[index];
			if (item?.kind?.toLocaleLowerCase() === "file") return "resource";
			if (item?.type && hasContextResourceDropType([item.type])) return "resource";
			if (
				item?.kind?.toLocaleLowerCase() === "string" ||
				item?.type?.toLocaleLowerCase().startsWith("text/")
			) {
				hasText = true;
			}
		}
	}

	return hasText ? "text" : "unknown";
}

function splitUriList(value: string): readonly string[] {
	return value
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

function parseJsonStringArray(value: string): readonly string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === "string")
			: [];
	} catch {
		return [];
	}
}

function encodePathSegments(value: string): string {
	return value
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

function absolutePathToFileUri(value: string): string | undefined {
	if (/^[A-Za-z]:[\\/]/u.test(value)) {
		const normalized = value.replaceAll("\\", "/");
		const drive = normalized.slice(0, 2);
		return `file:///${drive}${encodePathSegments(normalized.slice(2))}`;
	}
	if (/^\\\\[^\\]+\\[^\\]+/u.test(value)) {
		const normalized = value.slice(2).replaceAll("\\", "/");
		const [host, ...path] = normalized.split("/");
		if (!host || path.length === 0) return undefined;
		return `file://${encodeURIComponent(host)}/${encodePathSegments(path.join("/"))}`;
	}
	if (value.startsWith("/")) {
		return `file://${encodePathSegments(value)}`;
	}
	return undefined;
}

function normalizeDropEntry(value: string, allowPath: boolean): string | undefined {
	const trimmed = value.trim();
	let hasControlCharacter = false;
	for (let index = 0; index < trimmed.length; index += 1) {
		const code = trimmed.charCodeAt(index);
		if (code <= 31 || code === 127) {
			hasControlCharacter = true;
			break;
		}
	}
	if (trimmed.length === 0 || trimmed.length > MAX_DROP_ITEM_LENGTH || hasControlCharacter) {
		return undefined;
	}
	if (allowPath) {
		const pathUri = absolutePathToFileUri(trimmed);
		if (pathUri) return pathUri;
	}
	try {
		const url = new URL(trimmed);
		if (url.protocol.toLocaleLowerCase() !== "file:") return undefined;
		url.hash = "";
		url.search = "";
		return url.href;
	} catch {
		return undefined;
	}
}

/**
 * Normalize drop data without trusting it. Only local file URIs and absolute file
 * paths are returned; the extension host still validates workspace containment,
 * file type, symlinks, existence, and configured limits before attaching anything.
 */
export function parseDroppedUris(payloads: DropPayloads): readonly string[] {
	const byMime = new Map(
		Object.entries(payloads).map(([mime, value]) => [mime.toLocaleLowerCase(), value] as const),
	);
	const candidates: Array<{ readonly value: string; readonly allowPath: boolean }> = [];
	const addUriList = (mime: string) => {
		const value = byMime.get(mime.toLocaleLowerCase());
		if (value) {
			for (const entry of splitUriList(value)) candidates.push({ value: entry, allowPath: false });
		}
	};
	addUriList(DROP_MIME_TYPES.uriList);
	addUriList(DROP_MIME_TYPES.internalUriList);

	for (const mime of [DROP_MIME_TYPES.resources, DROP_MIME_TYPES.codeFiles]) {
		const value = byMime.get(mime.toLocaleLowerCase());
		if (!value) continue;
		for (const entry of parseJsonStringArray(value)) {
			candidates.push({ value: entry, allowPath: mime === DROP_MIME_TYPES.codeFiles });
		}
	}

	const plain = byMime.get(DROP_MIME_TYPES.plainText);
	if (plain) {
		for (const entry of splitUriList(plain)) candidates.push({ value: entry, allowPath: true });
	}

	const result: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const normalized = normalizeDropEntry(candidate.value, candidate.allowPath);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
		if (result.length >= MAX_DROP_ITEMS) break;
	}
	return result;
}

/** Read all known textual transfer formats before the browser clears drag data. */
export function readDroppedUris(dataTransfer: DropDataReader): readonly string[] {
	const payloads: Record<string, string> = {};
	if (dataTransfer.types) {
		for (let index = 0; index < dataTransfer.types.length; index += 1) {
			const type = dataTransfer.types[index];
			if (!type) continue;
			const readable = READABLE_DROP_MIME_TYPES.some(
				(candidate) => candidate.toLocaleLowerCase() === type.toLocaleLowerCase(),
			);
			if (!readable) continue;
			const value = dataTransfer.getData(type);
			if (value) payloads[type] = value;
		}
	}
	for (const mime of READABLE_DROP_MIME_TYPES) {
		const value = dataTransfer.getData(mime);
		if (value) payloads[mime] = value;
	}
	const nativePaths: string[] = [];
	if (dataTransfer.files) {
		for (let index = 0; index < dataTransfer.files.length; index += 1) {
			const path = (dataTransfer.files[index] as { readonly path?: unknown } | undefined)?.path;
			if (typeof path === "string") nativePaths.push(path);
		}
	}
	if (nativePaths.length > 0) {
		const existing = parseJsonStringArray(payloads[DROP_MIME_TYPES.codeFiles] ?? "");
		payloads[DROP_MIME_TYPES.codeFiles] = JSON.stringify([...existing, ...nativePaths]);
	}
	return parseDroppedUris(payloads);
}
