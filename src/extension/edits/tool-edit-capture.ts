import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import * as vscode from "vscode";
import type { ProposedEdit } from "../../shared/protocol.js";
import { isPathInside, nearestExistingRealPath } from "../filesystem/workspace-path.js";
import type { PiToolEventDto } from "../pi/types.js";
import { BoundedRecordMap } from "./bounded-record-map.js";
import { createCompactPatch } from "./compact-patch.js";
import type { ProposedEditStore } from "./proposed-edit-store.js";

interface PendingEditCapture {
	readonly uri: vscode.Uri;
	readonly path: string;
	readonly originalText: string;
}

const MAX_EDIT_REVIEW_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_CAPTURES = 16;
const MAX_PENDING_CAPTURE_BYTES = 16 * 1024 * 1024;
const textEncoder = new TextEncoder();

function captureBytes(capture: PendingEditCapture): number {
	return (
		textEncoder.encode(capture.originalText).byteLength +
		textEncoder.encode(capture.path).byteLength +
		textEncoder.encode(capture.uri.toString(true)).byteLength
	);
}

function stringArgument(args: PiToolEventDto["args"], key: string): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const value = (args as { readonly [key: string]: PiToolEventDto["args"] })[key];
	return typeof value === "string" ? value : undefined;
}

/** Captures the before/after state of Pi edit and write tool calls for editor review. */
export class ToolEditCapture {
	readonly #pending = new BoundedRecordMap<PendingEditCapture>({
		maxEntries: MAX_PENDING_CAPTURES,
		maxBytes: MAX_PENDING_CAPTURE_BYTES,
		sizeOf: captureBytes,
	});

	public constructor(private readonly edits: ProposedEditStore) {}

	public clear(): void {
		this.#pending.clear();
	}

	public begin(tool: PiToolEventDto, workspaceCwd: string): void {
		if (tool.toolName !== "edit" && tool.toolName !== "write") return;
		const rawPath = stringArgument(tool.args, "path")?.trim();
		if (!rawPath || rawPath.includes("\0")) return;
		const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspaceCwd, rawPath);
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absolute));
		if (workspaceFolder?.uri.scheme !== "file") return;
		const canonicalRoot = nearestExistingRealPath(workspaceFolder.uri.fsPath);
		const canonicalTarget = nearestExistingRealPath(absolute);
		if (!canonicalRoot || !canonicalTarget || !isPathInside(canonicalRoot, canonicalTarget)) return;

		let originalText = "";
		try {
			const stat = statSync(absolute);
			if (!stat.isFile() || stat.size > MAX_EDIT_REVIEW_BYTES) return;
			originalText = readFileSync(absolute, "utf8");
			if (originalText.includes("\0")) return;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return;
		}
		this.#pending.set(tool.toolCallId, {
			uri: vscode.Uri.file(absolute),
			path: vscode.workspace.asRelativePath(vscode.Uri.file(absolute), false),
			originalText,
		});
	}

	public finish(tool: PiToolEventDto): ProposedEdit | undefined {
		const capture = this.#pending.delete(tool.toolCallId);
		if (!capture || tool.isError) return undefined;

		let proposedText: string;
		try {
			const stat = statSync(capture.uri.fsPath);
			if (!stat.isFile() || stat.size > MAX_EDIT_REVIEW_BYTES) return undefined;
			proposedText = readFileSync(capture.uri.fsPath, "utf8");
			if (proposedText.includes("\0")) return undefined;
		} catch {
			return undefined;
		}
		const compact = createCompactPatch(capture.path, capture.originalText, proposedText);
		if (!compact) return undefined;
		const stored = this.edits.add({
			uri: capture.uri,
			originalText: capture.originalText,
			proposedText,
			patch: compact.patch,
			additions: compact.additions,
			deletions: compact.deletions,
		});
		return {
			id: stored.id,
			path: capture.path,
			patch: stored.patch,
			additions: stored.additions,
			deletions: stored.deletions,
			status: stored.status,
		};
	}
}
