import type * as vscode from "vscode";
import {
	DEFAULT_VIEW_DESIGN,
	sanitizeViewDesign,
	type ViewDesign,
} from "../../shared/view-design.js";

const GLOBAL_KEY = "piAgent.viewDesign.global";
const WORKSPACE_KEY = "piAgent.viewDesign.workspace";

export class ViewDesignStore {
	public constructor(private readonly context: vscode.ExtensionContext) {
		context.globalState.setKeysForSync([GLOBAL_KEY]);
	}

	public load(): { readonly design: ViewDesign; readonly scope: "global" | "workspace" } {
		const workspace = this.context.workspaceState.get<unknown>(WORKSPACE_KEY);
		if (workspace !== undefined) {
			return { design: sanitizeViewDesign(workspace).value, scope: "workspace" };
		}
		const global = this.context.globalState.get<unknown>(GLOBAL_KEY);
		return {
			design: global === undefined ? DEFAULT_VIEW_DESIGN : sanitizeViewDesign(global).value,
			scope: "global",
		};
	}

	public async save(
		input: unknown,
		scope: "global" | "workspace",
	): Promise<{ readonly design: ViewDesign; readonly issues: readonly string[] }> {
		const result = sanitizeViewDesign(input);
		if (!result.isValid) {
			throw new Error(result.issues.map((issue) => issue.message).join(" "));
		}
		if (scope === "workspace") {
			await this.context.workspaceState.update(WORKSPACE_KEY, result.value);
		} else {
			const priorGlobal = this.context.globalState.get<unknown>(GLOBAL_KEY);
			const priorWorkspace = this.context.workspaceState.get<unknown>(WORKSPACE_KEY);
			try {
				await this.context.globalState.update(GLOBAL_KEY, result.value);
				// Selecting “All workspaces” means the current workspace must stop
				// shadowing that global value after a reload.
				await this.context.workspaceState.update(WORKSPACE_KEY, undefined);
			} catch (error) {
				await Promise.allSettled([
					this.context.globalState.update(GLOBAL_KEY, priorGlobal),
					this.context.workspaceState.update(WORKSPACE_KEY, priorWorkspace),
				]);
				throw error;
			}
		}
		return { design: result.value, issues: result.issues.map((issue) => issue.message) };
	}

	public async reset(scope: "global" | "workspace"): Promise<ViewDesign> {
		if (scope === "workspace") {
			await this.context.workspaceState.update(WORKSPACE_KEY, undefined);
		} else {
			await this.context.globalState.update(GLOBAL_KEY, undefined);
		}
		return this.load().design;
	}
}
