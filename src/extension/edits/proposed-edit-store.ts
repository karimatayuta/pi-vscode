import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { BoundedRecordMap } from "./bounded-record-map.js";

export interface ProposedEditRecord {
	readonly id: string;
	readonly uri: vscode.Uri;
	readonly originalText: string;
	readonly proposedText: string;
	readonly patch: string;
	readonly additions: number;
	readonly deletions: number;
	readonly createdAt: number;
	readonly status: "applied";
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
		if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
	}
	return { additions, deletions };
}

const MAX_RETAINED_RECORDS = 32;
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;
const textEncoder = new TextEncoder();

function retainedBytes(record: ProposedEditRecord): number {
	return (
		textEncoder.encode(record.originalText).byteLength +
		textEncoder.encode(record.proposedText).byteLength +
		textEncoder.encode(record.patch).byteLength
	);
}

export class ProposedEditStore implements vscode.TextDocumentContentProvider, vscode.Disposable {
	public static readonly scheme = "pi-agent-proposed";

	readonly #records = new BoundedRecordMap<ProposedEditRecord>({
		maxEntries: MAX_RETAINED_RECORDS,
		maxBytes: MAX_RETAINED_BYTES,
		sizeOf: retainedBytes,
	});
	readonly #onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly #onDidRemove = new vscode.EventEmitter<string>();
	readonly #providerRegistration: vscode.Disposable;

	public readonly onDidChange = this.#onDidChange.event;
	public readonly onDidRemove = this.#onDidRemove.event;

	public constructor() {
		this.#providerRegistration = vscode.workspace.registerTextDocumentContentProvider(
			ProposedEditStore.scheme,
			this,
		);
	}

	public get records(): readonly ProposedEditRecord[] {
		return [...this.#records.values()].sort((left, right) => left.createdAt - right.createdAt);
	}

	public get(id: string): ProposedEditRecord | undefined {
		return this.#records.get(id);
	}

	public add(input: {
		readonly uri: vscode.Uri;
		readonly originalText: string;
		readonly proposedText: string;
		readonly patch: string;
		readonly additions?: number;
		readonly deletions?: number;
	}): ProposedEditRecord {
		const id = randomUUID();
		const counts = countPatchLines(input.patch);
		const record: ProposedEditRecord = {
			id,
			uri: input.uri,
			originalText: input.originalText,
			proposedText: input.proposedText,
			patch: input.patch,
			additions: input.additions ?? counts.additions,
			deletions: input.deletions ?? counts.deletions,
			createdAt: Date.now(),
			status: "applied",
		};
		for (const evicted of this.#records.set(id, record)) this.#notifyRemoved(evicted);
		return record;
	}

	public provideTextDocumentContent(uri: vscode.Uri): string | undefined {
		const id = uri.query;
		const record = this.#records.get(id);
		return uri.fragment === "original" ? record?.originalText : record?.proposedText;
	}

	public async review(id: string): Promise<void> {
		const record = this.#records.get(id);
		if (!record) {
			throw new Error("This proposed edit no longer exists.");
		}
		const originalUri = vscode.Uri.from({
			scheme: ProposedEditStore.scheme,
			path: record.uri.path,
			query: record.id,
			fragment: "original",
		});
		const proposedUri = vscode.Uri.from({
			scheme: ProposedEditStore.scheme,
			path: record.uri.path,
			query: record.id,
			fragment: "proposed",
		});
		await vscode.commands.executeCommand(
			"vscode.diff",
			originalUri,
			proposedUri,
			`${vscode.workspace.asRelativePath(record.uri, false)} — Pi applied edit`,
			{ preview: true },
		);
	}

	public remove(id: string): void {
		const record = this.#records.delete(id);
		if (!record) return;
		this.#notifyRemoved(record);
	}

	#notifyRemoved(record: ProposedEditRecord): void {
		this.#onDidRemove.fire(record.id);
		this.#onDidChange.fire(
			vscode.Uri.from({
				scheme: ProposedEditStore.scheme,
				path: record.uri.path,
				query: record.id,
			}),
		);
	}

	public dispose(): void {
		this.#records.clear();
		this.#providerRegistration.dispose();
		this.#onDidChange.dispose();
		this.#onDidRemove.dispose();
	}
}
