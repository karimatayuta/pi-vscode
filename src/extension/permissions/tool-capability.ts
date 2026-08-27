import type { Capability } from "../../shared/approval.js";
import { isPathInsideAnyCanonicalRoot } from "../filesystem/workspace-path.js";
import type { PiToolAuthorizationRequest } from "../pi/types.js";

/** Maps a Pi tool classification onto the policy capability for the current workspace roots. */
export function capabilityForToolRequest(
	request: PiToolAuthorizationRequest,
	localWorkspaceRoots: readonly string[],
): Capability {
	if (!isPathInsideAnyCanonicalRoot(localWorkspaceRoots, request.cwd)) {
		return "filesystem.outside-workspace";
	}
	if (request.target && !isPathInsideAnyCanonicalRoot(localWorkspaceRoots, request.target)) {
		return "filesystem.outside-workspace";
	}
	if (request.capability === "read" && request.risk !== "safe") return "secrets.read";
	if (request.capability === "search")
		return request.risk === "safe" ? "workspace.search" : "secrets.read";
	if (request.capability === "mutate")
		return request.toolName === "write" ? "workspace.write" : "workspace.edit";
	if (request.capability === "execute" || request.capability === "extension")
		return "command.execute";
	return "workspace.read";
}
