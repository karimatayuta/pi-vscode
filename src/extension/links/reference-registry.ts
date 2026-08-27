import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import { type OpaqueReferenceLease, OpaqueReferenceStore } from "./opaque-reference-store.js";

export type OpenTarget =
	| { readonly kind: "external"; readonly href: string }
	| {
			readonly kind: "workspace";
			readonly folderId?: string;
			readonly relativePath: string;
			readonly line?: number;
			readonly column?: number;
			readonly endLine?: number;
			readonly endColumn?: number;
	  };

export type ReferenceAction = "open" | "openBeside" | "reveal" | "copyPath";

const SAFE_RELATIVE_PATH =
	/^(?![A-Za-z]:)(?![/\\]{2})(?![/\\])(?!.*(?:^|[/\\])\.\.(?:[/\\]|$)).+$/u;

function hasControlCharacter(value: string): boolean {
	return [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
}

function folderId(folder: vscode.WorkspaceFolder): string {
	return `${folder.index}:${folder.uri.scheme}:${folder.uri.authority}`;
}

function sameTarget(left: OpenTarget, right: OpenTarget): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "external" && right.kind === "external") return left.href === right.href;
	if (left.kind !== "workspace" || right.kind !== "workspace") return false;
	return (
		left.folderId === right.folderId &&
		left.relativePath === right.relativePath &&
		left.line === right.line &&
		left.column === right.column &&
		left.endLine === right.endLine &&
		left.endColumn === right.endColumn
	);
}

export class ReferenceRegistry {
	readonly #references = new OpaqueReferenceStore<OpenTarget>({ equals: sameTarget });

	public get epoch(): string {
		return this.#references.epoch;
	}

	public invalidate(): void {
		this.#references.invalidate();
	}

	public issue(target: OpenTarget, previous?: OpaqueReferenceLease): OpaqueReferenceLease {
		return this.#references.issue(target, previous);
	}

	public async open(refId: string, epoch: string, action: ReferenceAction): Promise<void> {
		const target = this.#references.resolve(refId, epoch);
		if (!target) {
			throw new Error("This link has expired. Render the message again and retry.");
		}
		if (target.kind === "external") {
			await this.#openExternal(target.href, action);
			return;
		}
		await this.#openWorkspace(target, action);
	}

	async #openExternal(rawHref: string, action: ReferenceAction): Promise<void> {
		if (rawHref.length > 8_192 || hasControlCharacter(rawHref)) {
			throw new Error("Unsafe URL.");
		}
		let parsed: URL;
		try {
			parsed = new URL(rawHref);
		} catch {
			throw new Error("Invalid URL.");
		}
		if (
			(parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
			parsed.username ||
			parsed.password
		) {
			throw new Error("Only plain HTTP(S) links without embedded credentials can be opened.");
		}
		if (action === "copyPath") {
			await vscode.env.clipboard.writeText(parsed.href);
			return;
		}
		if (action === "reveal") {
			throw new Error("External links cannot be revealed in the workspace Explorer.");
		}
		const uri = vscode.Uri.parse(parsed.href, true);
		const choice = await vscode.window.showWarningMessage(
			`Open this external link?\n${parsed.href}`,
			parsed.protocol === "http:"
				? { modal: true, detail: "This connection is not encrypted." }
				: { modal: true },
			"Open once",
		);
		if (choice === "Open once") {
			await vscode.env.openExternal(uri);
		}
	}

	async #openWorkspace(
		target: Extract<OpenTarget, { kind: "workspace" }>,
		action: ReferenceAction,
	): Promise<void> {
		if (!SAFE_RELATIVE_PATH.test(target.relativePath) || hasControlCharacter(target.relativePath)) {
			throw new Error("Unsafe workspace path.");
		}
		const folders = vscode.workspace.workspaceFolders ?? [];
		const candidates = target.folderId
			? folders.filter((folder) => folderId(folder) === target.folderId)
			: folders;
		const existing: Array<{
			folder: vscode.WorkspaceFolder;
			uri: vscode.Uri;
			stat: vscode.FileStat;
		}> = [];
		for (const folder of candidates) {
			const uri = vscode.Uri.joinPath(folder.uri, target.relativePath);
			if (
				vscode.workspace.getWorkspaceFolder(uri)?.uri.toString(true) !== folder.uri.toString(true)
			) {
				continue;
			}
			try {
				const stat = await vscode.workspace.fs.stat(uri);
				existing.push({ folder, uri, stat });
			} catch {
				// Continue searching the remaining workspace roots.
			}
		}
		if (existing.length === 0) {
			throw new Error(`File not found: ${target.relativePath}`);
		}
		const first = existing[0];
		if (!first) {
			throw new Error(`File not found: ${target.relativePath}`);
		}
		let selected = first;
		if (existing.length > 1) {
			const picked = await vscode.window.showQuickPick(
				existing.map((candidate) => ({
					label: candidate.folder.name,
					description: candidate.folder.uri.toString(true),
					candidate,
				})),
				{ placeHolder: `Choose a workspace root for ${target.relativePath}` },
			);
			if (!picked) {
				return;
			}
			selected = picked.candidate;
		}
		await this.#verifyLocalBoundary(selected.folder.uri, selected.uri);
		if (action === "copyPath") {
			await vscode.env.clipboard.writeText(
				selected.uri.scheme === "file" ? selected.uri.fsPath : selected.uri.toString(true),
			);
			return;
		}
		if (action === "reveal" || (selected.stat.type & vscode.FileType.Directory) !== 0) {
			await vscode.commands.executeCommand("revealInExplorer", selected.uri);
			return;
		}
		const document = await vscode.workspace.openTextDocument(selected.uri);
		const start = document.validatePosition(
			new vscode.Position(
				Math.max(0, (target.line ?? 1) - 1),
				Math.max(0, (target.column ?? 1) - 1),
			),
		);
		const end = document.validatePosition(
			new vscode.Position(
				Math.max(start.line, (target.endLine ?? target.line ?? 1) - 1),
				Math.max(0, (target.endColumn ?? target.column ?? 1) - 1),
			),
		);
		const editor = await vscode.window.showTextDocument(document, {
			viewColumn: action === "openBeside" ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
			preview: true,
			selection: new vscode.Range(start, end),
		});
		editor.revealRange(
			new vscode.Range(start, end),
			vscode.TextEditorRevealType.InCenterIfOutsideViewport,
		);
	}

	async #verifyLocalBoundary(rootUri: vscode.Uri, targetUri: vscode.Uri): Promise<void> {
		if (rootUri.scheme !== "file" || targetUri.scheme !== "file") {
			if ((await vscode.workspace.fs.stat(targetUri)).type & vscode.FileType.SymbolicLink) {
				throw new Error("A symbolic link cannot be verified in this remote workspace.");
			}
			return;
		}
		const [rootPath, targetPath] = await Promise.all([
			realpath(rootUri.fsPath),
			realpath(targetUri.fsPath),
		]);
		const targetRelative = relative(rootPath, targetPath);
		if (
			targetRelative === ".." ||
			targetRelative.startsWith(`..${sep}`) ||
			isAbsolute(targetRelative)
		) {
			throw new Error("The link resolves outside the workspace.");
		}
		if (resolve(rootPath, targetRelative) !== targetPath) {
			throw new Error("The link target could not be verified.");
		}
	}
}
