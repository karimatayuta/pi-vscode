import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import * as vscode from "vscode";
import {
	MAX_CONTEXT_METADATA_BYTES,
	MAX_CONTEXT_RESOLUTION_BYTES,
	MAX_RESOLVED_CONTEXT_ITEMS,
	truncatePromptUtf8,
} from "../../shared/prompt-budget.js";
import { type BackgroundErrorReporter, fireAndReport } from "../async/fire-and-report.js";
import { isPathInside } from "../filesystem/workspace-path.js";

export type ContextItemKind = "file" | "folder" | "selection";

export interface ContextSelection {
	readonly startLine: number;
	readonly startCharacter: number;
	readonly endLine: number;
	readonly endCharacter: number;
	readonly text: string;
	readonly truncated?: boolean;
}

export interface ContextItem {
	readonly id: string;
	readonly uri: vscode.Uri;
	readonly kind: ContextItemKind;
	readonly label: string;
	readonly description?: string;
	readonly selection?: ContextSelection;
	readonly addedAt: number;
}

export interface ResolvedContextItem {
	readonly id: string;
	readonly kind: ContextItemKind;
	readonly uri: string;
	readonly label: string;
	readonly content?: string;
	readonly truncated?: boolean;
	readonly warning?: string;
}

export interface ContextResolutionLimits {
	readonly maxItems: number;
	readonly maxFileBytes: number;
	readonly maxFolderFiles: number;
	readonly maxTotalBytes: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextResolutionLimits = {
	maxItems: 64,
	maxFileBytes: 512 * 1024,
	maxFolderFiles: 200,
	maxTotalBytes: 2 * 1024 * 1024,
};

const textDecoder = new TextDecoder("utf-8", { fatal: false });
const strictTextDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();
const CONTEXT_LIMIT_WARNING =
	"Some context was omitted to keep this request within Pi Agent's safe prompt limits.";

function resolvedMetadataBytes(item: ResolvedContextItem): number {
	const { content: _content, ...metadata } = item;
	return textEncoder.encode(JSON.stringify(metadata)).byteLength;
}

function boundResolvedContextItem(
	item: ResolvedContextItem,
	remainingContentBytes: number,
): ResolvedContextItem {
	const content =
		item.content === undefined
			? undefined
			: truncateUtf8(item.content, Math.max(0, remainingContentBytes));
	return {
		id: truncatePromptUtf8(item.id, 256),
		kind: item.kind,
		uri: truncatePromptUtf8(item.uri, 8_192),
		label: truncatePromptUtf8(item.label, 512),
		...(content === undefined ? {} : { content: content.text }),
		...(item.truncated === true || content?.truncated === true ? { truncated: true } : {}),
		...(item.warning === undefined ? {} : { warning: truncatePromptUtf8(item.warning, 2_048) }),
	};
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("base64url").slice(0, 16);
}

function truncateUtf8(
	value: string,
	maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
	const bytes = textEncoder.encode(value);
	if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
	let end = Math.max(0, maxBytes);
	while (end > 0) {
		try {
			return { text: strictTextDecoder.decode(bytes.subarray(0, end)), truncated: true };
		} catch {
			end -= 1;
		}
	}
	return { text: "", truncated: true };
}

function decodeUtf8Prefix(
	bytes: Uint8Array,
	maxBytes: number,
): { readonly text: string; readonly bytes: number; readonly truncated: boolean } {
	const available = Math.max(0, Math.min(bytes.byteLength, maxBytes));
	const normalized = truncateUtf8(textDecoder.decode(bytes.subarray(0, available)), available);
	return {
		text: normalized.text,
		bytes: textEncoder.encode(normalized.text).byteLength,
		truncated: available < bytes.byteLength || normalized.truncated,
	};
}

function boundedSelectionText(
	document: vscode.TextDocument,
	selection: vscode.Selection,
	maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
	const startOffset = document.offsetAt(selection.start);
	const endOffset = document.offsetAt(selection.end);
	// Bound the range before getText so a very large selection is never fully
	// materialized merely to truncate it afterwards.
	const boundedEndOffset = Math.min(endOffset, startOffset + Math.max(0, maxBytes));
	const boundedRange = new vscode.Range(selection.start, document.positionAt(boundedEndOffset));
	const bounded = truncateUtf8(document.getText(boundedRange), maxBytes);
	return {
		text: bounded.text,
		truncated: bounded.truncated || boundedEndOffset < endOffset,
	};
}

function folderBudgets(maxFiles: number): {
	readonly directories: number;
	readonly entries: number;
} {
	return {
		directories: Math.max(16, maxFiles * 4),
		entries: Math.max(64, maxFiles * 32),
	};
}

function contextKey(uri: vscode.Uri, kind: ContextItemKind, selection?: ContextSelection): string {
	const range = selection
		? `:${selection.startLine}:${selection.startCharacter}:${selection.endLine}:${selection.endCharacter}:${digest(selection.text)}`
		: "";
	return `${kind}:${uri.toString(true)}${range}`;
}

function makeId(key: string): string {
	return `ctx-${digest(key)}`;
}

function labelForUri(uri: vscode.Uri): string {
	return vscode.workspace.asRelativePath(uri) || uri.path.split("/").at(-1) || uri.toString(true);
}

function looksBinary(data: Uint8Array): boolean {
	const sampleLength = Math.min(data.byteLength, 8_192);
	if (sampleLength === 0) {
		return false;
	}
	let suspicious = 0;
	for (let index = 0; index < sampleLength; index += 1) {
		const byte = data[index] ?? 0;
		if (byte === 0) {
			return true;
		}
		if (byte < 7 || (byte > 13 && byte < 32)) {
			suspicious += 1;
		}
	}
	return suspicious / sampleLength > 0.1;
}

export class ContextStore implements vscode.Disposable {
	readonly #items = new Map<string, ContextItem>();
	readonly #onDidChange = new vscode.EventEmitter<readonly ContextItem[]>();
	#limits: ContextResolutionLimits;

	public readonly onDidChange = this.#onDidChange.event;

	public constructor(
		limits: ContextResolutionLimits = DEFAULT_CONTEXT_LIMITS,
		private readonly reportBackgroundError: BackgroundErrorReporter = () => undefined,
	) {
		this.#limits = { ...limits };
	}

	public updateLimits(limits: ContextResolutionLimits): void {
		this.#limits = { ...limits };
	}

	public get items(): readonly ContextItem[] {
		return [...this.#items.values()].sort((left, right) => left.addedAt - right.addedAt);
	}

	public async addUris(uris: readonly vscode.Uri[]): Promise<readonly ContextItem[]> {
		const accepted: ContextItem[] = [];
		for (const sourceUri of uris) {
			const uri = sourceUri.with({ fragment: "", query: "" });
			if (this.#items.size >= this.#limits.maxItems) {
				this.#notify(
					vscode.window.showWarningMessage(
						`Pi Agent context is limited to ${this.#limits.maxItems} items.`,
					),
				);
				break;
			}
			try {
				if (!(await this.#isSafeWorkspaceUri(uri))) {
					this.#notify(
						vscode.window.showWarningMessage(
							"Pi Agent context only accepts non-symbolic files and folders inside this local workspace.",
						),
					);
					continue;
				}
				const stat = await vscode.workspace.fs.stat(uri);
				if (stat.type & vscode.FileType.SymbolicLink) {
					this.#notify(
						vscode.window.showWarningMessage("Pi Agent does not attach symbolic links as context."),
					);
					continue;
				}
				const kind: ContextItemKind = stat.type & vscode.FileType.Directory ? "folder" : "file";
				const key = contextKey(uri, kind);
				if (this.#items.has(key)) {
					continue;
				}
				const item: ContextItem = {
					id: makeId(key),
					uri,
					kind,
					label: labelForUri(uri),
					...(kind === "folder" ? { description: "Folder" } : {}),
					addedAt: Date.now(),
				};
				this.#items.set(key, item);
				accepted.push(item);
			} catch {
				this.#notify(
					vscode.window.showWarningMessage(`Pi Agent could not attach ${uri.toString(true)}.`),
				);
			}
		}
		if (accepted.length > 0) {
			this.#emit();
		}
		return accepted;
	}

	public addSelection(editor: vscode.TextEditor): ContextItem | undefined {
		if (!this.#isSafeWorkspaceUriSync(editor.document.uri)) {
			this.#notify(
				vscode.window.showWarningMessage(
					"Pi Agent selections must come from a non-symbolic file inside this local workspace.",
				),
			);
			return undefined;
		}
		const selection = editor.selection;
		if (selection.isEmpty) {
			this.#notify(
				vscode.window.showInformationMessage(
					"Select some text before adding the current selection.",
				),
			);
			return undefined;
		}
		const selectedText = boundedSelectionText(
			editor.document,
			selection,
			Math.max(0, Math.min(this.#limits.maxFileBytes, this.#limits.maxTotalBytes)),
		);
		const snapshot: ContextSelection = {
			startLine: selection.start.line,
			startCharacter: selection.start.character,
			endLine: selection.end.line,
			endCharacter: selection.end.character,
			text: selectedText.text,
			...(selectedText.truncated ? { truncated: true } : {}),
		};
		const key = contextKey(editor.document.uri, "selection", snapshot);
		const existing = this.#items.get(key);
		if (existing) {
			return existing;
		}
		if (this.#items.size >= this.#limits.maxItems) {
			this.#notify(
				vscode.window.showWarningMessage(
					`Pi Agent context is limited to ${this.#limits.maxItems} items.`,
				),
			);
			return undefined;
		}
		const item: ContextItem = {
			id: makeId(key),
			uri: editor.document.uri,
			kind: "selection",
			label: `${labelForUri(editor.document.uri)}:${selection.start.line + 1}-${selection.end.line + 1}`,
			description: selectedText.truncated ? "Selection snapshot (truncated)" : "Selection snapshot",
			selection: snapshot,
			addedAt: Date.now(),
		};
		this.#items.set(key, item);
		this.#emit();
		return item;
	}

	public remove(id: string): boolean {
		const entry = [...this.#items.entries()].find(([, item]) => item.id === id);
		if (!entry) {
			return false;
		}
		this.#items.delete(entry[0]);
		this.#emit();
		return true;
	}

	public clear(): void {
		if (this.#items.size === 0) {
			return;
		}
		this.#items.clear();
		this.#emit();
	}

	public async resolveForPrompt(ids?: readonly string[]): Promise<readonly ResolvedContextItem[]> {
		const available = new Map(this.items.map((item) => [item.id, item]));
		const selected = ids
			? [...new Set(ids)].flatMap((id) => {
					const item = available.get(id);
					return item ? [item] : [];
				})
			: this.items;
		let remaining = Math.min(this.#limits.maxTotalBytes, MAX_CONTEXT_RESOLUTION_BYTES);
		let metadataBytes = 0;
		let limited = this.#limits.maxTotalBytes > MAX_CONTEXT_RESOLUTION_BYTES;
		const result: ResolvedContextItem[] = [];
		const warningItem: ResolvedContextItem = {
			id: "context:limit",
			kind: "folder",
			uri: "pi-agent:context-limit",
			label: "Context limit",
			warning: CONTEXT_LIMIT_WARNING,
		};
		const metadataLimit = Math.max(
			0,
			MAX_CONTEXT_METADATA_BYTES - resolvedMetadataBytes(warningItem),
		);
		const append = (raw: ResolvedContextItem): boolean => {
			if (result.length >= MAX_RESOLVED_CONTEXT_ITEMS - 1) {
				limited = true;
				return false;
			}
			const item = boundResolvedContextItem(raw, remaining);
			const nextMetadataBytes = resolvedMetadataBytes(item);
			if (metadataBytes + nextMetadataBytes > metadataLimit) {
				limited = true;
				return false;
			}
			metadataBytes += nextMetadataBytes;
			if (item.content !== undefined) {
				const contentBytes = textEncoder.encode(item.content).byteLength;
				remaining -= contentBytes;
				if (item.truncated) limited = true;
			}
			result.push(item);
			return true;
		};
		for (const item of selected) {
			if (remaining <= 0) {
				limited = true;
				break;
			}
			if (item.kind === "selection" && item.selection) {
				const bytes = textEncoder.encode(item.selection.text);
				const decoded = decodeUtf8Prefix(bytes, Math.min(remaining, this.#limits.maxFileBytes));
				if (
					!append({
						id: item.id,
						kind: item.kind,
						uri: item.uri.toString(true),
						label: item.label,
						content: decoded.text,
						truncated: item.selection.truncated === true || decoded.truncated,
					})
				)
					break;
				continue;
			}
			if (item.kind === "file") {
				const resolved = await this.#resolveFile(item, remaining);
				if (!append(resolved)) break;
				continue;
			}
			const folderItems = await this.#resolveFolder(
				item,
				remaining,
				Math.min(this.#limits.maxFolderFiles, MAX_RESOLVED_CONTEXT_ITEMS - 1 - result.length),
			);
			for (const resolved of folderItems) {
				if (!append(resolved)) break;
			}
			if (limited) break;
		}
		if (limited) result.push(warningItem);
		return result;
	}

	async #resolveFile(item: ContextItem, remaining: number): Promise<ResolvedContextItem> {
		try {
			if (!(await this.#isSafeWorkspaceUri(item.uri))) {
				return {
					id: item.id,
					kind: item.kind,
					uri: item.uri.toString(true),
					label: item.label,
					warning: "Skipped because the file is outside the workspace or is now a symbolic link.",
				};
			}
			const openDocument = vscode.workspace.textDocuments.find(
				(document) => !document.isClosed && document.uri.toString(true) === item.uri.toString(true),
			);
			if (openDocument) {
				const documentEnd = openDocument.lineAt(openDocument.lineCount - 1).range.end;
				if (openDocument.offsetAt(documentEnd) > this.#limits.maxFileBytes) {
					return {
						id: item.id,
						kind: item.kind,
						uri: item.uri.toString(true),
						label: item.label,
						warning: `Skipped because the open editor content is larger than ${this.#limits.maxFileBytes} bytes.`,
					};
				}
				const bytes = textEncoder.encode(openDocument.getText());
				if (bytes.byteLength > this.#limits.maxFileBytes) {
					return {
						id: item.id,
						kind: item.kind,
						uri: item.uri.toString(true),
						label: item.label,
						warning: `Skipped because the open editor content is larger than ${this.#limits.maxFileBytes} bytes.`,
					};
				}
				const decoded = decodeUtf8Prefix(bytes, Math.min(remaining, this.#limits.maxFileBytes));
				return {
					id: item.id,
					kind: item.kind,
					uri: item.uri.toString(true),
					label: item.label,
					content: decoded.text,
					truncated: decoded.truncated,
				};
			}
			const stat = await vscode.workspace.fs.stat(item.uri);
			if (stat.size > this.#limits.maxFileBytes) {
				return {
					id: item.id,
					kind: item.kind,
					uri: item.uri.toString(true),
					label: item.label,
					warning: `Skipped because the file is larger than ${this.#limits.maxFileBytes} bytes.`,
				};
			}
			const bytes = await vscode.workspace.fs.readFile(item.uri);
			if (looksBinary(bytes)) {
				return {
					id: item.id,
					kind: item.kind,
					uri: item.uri.toString(true),
					label: item.label,
					warning: "Skipped because the file appears to be binary.",
				};
			}
			const decoded = decodeUtf8Prefix(bytes, Math.min(remaining, this.#limits.maxFileBytes));
			return {
				id: item.id,
				kind: item.kind,
				uri: item.uri.toString(true),
				label: item.label,
				content: decoded.text,
				truncated: decoded.truncated,
			};
		} catch {
			return {
				id: item.id,
				kind: item.kind,
				uri: item.uri.toString(true),
				label: item.label,
				warning: "The file no longer exists or cannot be read.",
			};
		}
	}

	async #resolveFolder(
		item: ContextItem,
		remaining: number,
		maxFiles: number,
	): Promise<readonly ResolvedContextItem[]> {
		const queue = [item.uri];
		let nextDirectory = 0;
		const output: ResolvedContextItem[] = [];
		const budget = folderBudgets(maxFiles);
		let queuedDirectories = 1;
		let visitedDirectories = 0;
		let scannedEntries = 0;
		let resolvedFiles = 0;
		let limited = false;
		let skippedSymbolicLink = false;
		let unreadableLocations = 0;
		while (
			nextDirectory < queue.length &&
			resolvedFiles < maxFiles &&
			remaining > 0 &&
			visitedDirectories < budget.directories &&
			scannedEntries < budget.entries
		) {
			const directory = queue[nextDirectory];
			nextDirectory += 1;
			if (!directory) {
				break;
			}
			visitedDirectories += 1;
			try {
				if (!(await this.#isSafeWorkspaceUri(directory))) {
					unreadableLocations += 1;
					continue;
				}
				const entries = await opendir(directory.fsPath);
				for await (const entry of entries) {
					scannedEntries += 1;
					if (scannedEntries > budget.entries) {
						limited = true;
						break;
					}
					if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
						continue;
					}
					const uri = vscode.Uri.joinPath(directory, entry.name);
					if (entry.isSymbolicLink()) {
						skippedSymbolicLink = true;
					} else if (entry.isDirectory()) {
						if (queuedDirectories < budget.directories) {
							queue.push(uri);
							queuedDirectories += 1;
						} else {
							limited = true;
						}
					} else if (entry.isFile()) {
						if (resolvedFiles >= maxFiles) {
							limited = true;
							break;
						}
						const child: ContextItem = {
							id: `${item.id}:${resolvedFiles}`,
							uri,
							kind: "file",
							label: labelForUri(uri),
							addedAt: item.addedAt,
						};
						const resolved = await this.#resolveFile(child, remaining);
						output.push(resolved);
						resolvedFiles += 1;
						if (resolved.content) {
							remaining -= textEncoder.encode(resolved.content).byteLength;
						}
					}
					if (resolvedFiles >= maxFiles || remaining <= 0) {
						limited = true;
						break;
					}
				}
			} catch {
				// The attachment may change after it was accepted. Count failures, but
				// never expose filesystem error details or hidden paths to the prompt.
				unreadableLocations += 1;
			}
		}
		const warnings: string[] = [];
		if (
			limited ||
			nextDirectory < queue.length ||
			visitedDirectories >= budget.directories ||
			scannedEntries >= budget.entries
		) {
			warnings.push(
				`Folder context was limited to ${maxFiles} files and its traversal safety budget.`,
			);
		}
		if (skippedSymbolicLink) {
			warnings.push("Symbolic links were skipped while resolving folder context.");
		}
		if (unreadableLocations > 0) {
			warnings.push(
				`${unreadableLocations} folder location${unreadableLocations === 1 ? " was" : "s were"} skipped because it no longer exists, is outside the workspace, or cannot be read.`,
			);
		}
		if (warnings.length > 0) {
			output.push({
				id: `${item.id}:warning`,
				kind: "folder",
				uri: item.uri.toString(true),
				label: item.label,
				warning: warnings.join(" "),
			});
		}
		return output;
	}

	#emit(): void {
		this.#onDidChange.fire(this.items);
	}

	#notify(operation: PromiseLike<unknown>): void {
		fireAndReport(
			operation,
			this.reportBackgroundError,
			"Could not show a Pi Agent context notification.",
		);
	}

	async #isSafeWorkspaceUri(uri: vscode.Uri): Promise<boolean> {
		if (uri.scheme !== "file") return false;
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (folder?.uri.scheme !== "file") return false;
		try {
			const targetStat = await lstat(uri.fsPath);
			if (targetStat.isSymbolicLink()) return false;
			const [rootPath, targetPath] = await Promise.all([
				realpath(folder.uri.fsPath),
				realpath(uri.fsPath),
			]);
			return isPathInside(rootPath, targetPath);
		} catch {
			return false;
		}
	}

	#isSafeWorkspaceUriSync(uri: vscode.Uri): boolean {
		if (uri.scheme !== "file") return false;
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (folder?.uri.scheme !== "file") return false;
		try {
			const targetStat = lstatSync(uri.fsPath);
			if (targetStat.isSymbolicLink()) return false;
			return isPathInside(realpathSync(folder.uri.fsPath), realpathSync(uri.fsPath));
		} catch {
			return false;
		}
	}

	public dispose(): void {
		this.#onDidChange.dispose();
		this.#items.clear();
	}
}
