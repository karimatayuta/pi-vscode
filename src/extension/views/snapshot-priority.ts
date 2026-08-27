import type { WebviewToHostMessage } from "../../shared/protocol.js";

export type SnapshotPriority = "coalesced" | "immediate";

/** Selection must publish its newly active history before the user can interact with that tab. */
export function snapshotPriorityForIntent(type: WebviewToHostMessage["type"]): SnapshotPriority {
	return type === "ready" || type === "selectChat" ? "immediate" : "coalesced";
}
