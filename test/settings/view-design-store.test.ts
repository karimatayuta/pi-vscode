import { describe, expect, test } from "bun:test";
import type * as vscode from "vscode";
import { ViewDesignStore } from "../../src/extension/settings/view-design-store.js";
import { DEFAULT_VIEW_DESIGN } from "../../src/shared/view-design.js";

class MemoryMemento {
	readonly values = new Map<string, unknown>();
	readonly failures = new Set<string>();

	public get<T>(key: string, defaultValue?: T): T | undefined {
		return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
	}

	public async update(key: string, value: unknown): Promise<void> {
		if (this.failures.delete(key)) throw new Error(`update failed: ${key}`);
		if (value === undefined) this.values.delete(key);
		else this.values.set(key, value);
	}

	public keys(): readonly string[] {
		return [...this.values.keys()];
	}
}

function fixture(): {
	readonly store: ViewDesignStore;
	readonly global: MemoryMemento;
	readonly workspace: MemoryMemento;
} {
	const global = new MemoryMemento();
	const workspace = new MemoryMemento();
	const context = {
		globalState: {
			...global,
			get: global.get.bind(global),
			update: global.update.bind(global),
			keys: global.keys.bind(global),
			setKeysForSync() {},
		},
		workspaceState: {
			...workspace,
			get: workspace.get.bind(workspace),
			update: workspace.update.bind(workspace),
			keys: workspace.keys.bind(workspace),
		},
	} as unknown as vscode.ExtensionContext;
	return { store: new ViewDesignStore(context), global, workspace };
}

describe("ViewDesignStore", () => {
	test("clears a workspace override when saving for all workspaces", async () => {
		const { store, workspace } = fixture();
		await store.save({ ...DEFAULT_VIEW_DESIGN, textSize: 14 }, "workspace");
		expect(store.load().scope).toBe("workspace");

		await store.save({ ...DEFAULT_VIEW_DESIGN, textSize: 16 }, "global");
		expect(workspace.values.has("piAgent.viewDesign.workspace")).toBeFalse();
		expect(store.load()).toMatchObject({ scope: "global", design: { textSize: 16 } });
	});

	test("restores both scopes if clearing the workspace override fails", async () => {
		const { store, global, workspace } = fixture();
		await store.save({ ...DEFAULT_VIEW_DESIGN, textSize: 13 }, "global");
		await store.save({ ...DEFAULT_VIEW_DESIGN, textSize: 14 }, "workspace");
		workspace.failures.add("piAgent.viewDesign.workspace");

		await expect(store.save({ ...DEFAULT_VIEW_DESIGN, textSize: 16 }, "global")).rejects.toThrow();
		expect(global.values.get("piAgent.viewDesign.global")).toMatchObject({ textSize: 13 });
		expect(workspace.values.get("piAgent.viewDesign.workspace")).toMatchObject({ textSize: 14 });
	});
});
