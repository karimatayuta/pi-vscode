import type { ApprovalMode, Capability, RiskLevel } from "../../shared/approval.js";

export interface PermissionRequest {
	readonly id: string;
	readonly chatId: string;
	readonly capability: Capability;
	readonly risk: RiskLevel;
	readonly summary: string;
	readonly resource?: string;
}

export type PermissionAction = "allow" | "ask" | "deny";

export type PermissionReason =
	| "read-only-capability"
	| "plan-mode-mutation"
	| "ask-mode-confirmation"
	| "auto-edit-workspace-change"
	| "auto-edit-confirmation"
	| "full-access"
	| "critical-risk-confirmation"
	| "sensitive-boundary-confirmation";

export interface PermissionEvaluation {
	readonly action: PermissionAction;
	readonly mode: ApprovalMode;
	readonly reason: PermissionReason;
	readonly request: PermissionRequest;
}

export interface ResolvedPermission {
	readonly action: "allow" | "deny";
	readonly source: "policy" | "user";
	readonly mode: ApprovalMode;
	readonly reason: PermissionReason | "user-approved" | "user-denied";
	readonly request: PermissionRequest;
}

const READ_ONLY_CAPABILITIES: ReadonlySet<Capability> = new Set([
	"workspace.read",
	"workspace.search",
]);

const AUTO_EDIT_CAPABILITIES: ReadonlySet<Capability> = new Set([
	"workspace.edit",
	"workspace.write",
]);

const SENSITIVE_BOUNDARY_CAPABILITIES: ReadonlySet<Capability> = new Set([
	"filesystem.outside-workspace",
	"secrets.read",
]);
const DEFAULT_MAX_CONSUMED_REQUESTS = 4_096;

export interface PermissionBrokerOptions {
	readonly maxConsumedRequests?: number;
}

/**
 * Evaluates a capability without mutating broker state.
 *
 * Critical operations always require a one-shot confirmation, even in Full
 * Access. Plan mode is stricter: anything capable of mutation or execution is
 * denied rather than presented for approval.
 */
export function evaluatePermission(
	mode: ApprovalMode,
	request: PermissionRequest,
): PermissionEvaluation {
	const isReadOnly = READ_ONLY_CAPABILITIES.has(request.capability);

	if (mode === "plan") {
		if (isReadOnly) {
			return {
				action: request.risk === "critical" ? "ask" : "allow",
				mode,
				reason: request.risk === "critical" ? "critical-risk-confirmation" : "read-only-capability",
				request,
			};
		}

		return {
			action: "deny",
			mode,
			reason: "plan-mode-mutation",
			request,
		};
	}

	if (SENSITIVE_BOUNDARY_CAPABILITIES.has(request.capability)) {
		return {
			action: "ask",
			mode,
			reason: "sensitive-boundary-confirmation",
			request,
		};
	}

	if (request.risk === "critical") {
		return {
			action: "ask",
			mode,
			reason: "critical-risk-confirmation",
			request,
		};
	}

	if (mode === "ask") {
		const canReadWithoutAsking =
			isReadOnly && (request.risk === "low" || request.risk === "medium");
		return {
			action: canReadWithoutAsking ? "allow" : "ask",
			mode,
			reason: canReadWithoutAsking ? "read-only-capability" : "ask-mode-confirmation",
			request,
		};
	}

	if (mode === "autoEdit") {
		if (isReadOnly) {
			return {
				action: "allow",
				mode,
				reason: "read-only-capability",
				request,
			};
		}

		if (AUTO_EDIT_CAPABILITIES.has(request.capability)) {
			return {
				action: "allow",
				mode,
				reason: "auto-edit-workspace-change",
				request,
			};
		}

		return {
			action: "ask",
			mode,
			reason: "auto-edit-confirmation",
			request,
		};
	}

	if (mode === "fullAccess") {
		return {
			action: "allow",
			mode,
			reason: "full-access",
			request,
		};
	}

	throw new Error("Unknown Pi Agent approval mode.");
}

/**
 * Stateful coordinator for one-shot permission prompts. The policy itself is
 * pure (`evaluatePermission`); this class only prevents duplicate/replayed
 * request IDs and binds a user response to the originating chat.
 */
export class PermissionBroker {
	readonly #pending = new Map<string, PermissionEvaluation>();
	readonly #consumed = new Set<string>();
	readonly #maxConsumedRequests: number;
	#mode: ApprovalMode;

	public constructor(mode: ApprovalMode, options: PermissionBrokerOptions = {}) {
		this.#mode = mode;
		this.#maxConsumedRequests = options.maxConsumedRequests ?? DEFAULT_MAX_CONSUMED_REQUESTS;
		if (!Number.isSafeInteger(this.#maxConsumedRequests) || this.#maxConsumedRequests <= 0) {
			throw new Error("Consumed permission capacity must be a positive integer.");
		}
	}

	public get mode(): ApprovalMode {
		return this.#mode;
	}

	public setMode(mode: ApprovalMode): void {
		this.#mode = mode;
	}

	public evaluate(request: PermissionRequest): PermissionEvaluation {
		return evaluatePermission(this.#mode, request);
	}

	public begin(request: PermissionRequest): PermissionEvaluation | ResolvedPermission {
		this.#assertFreshRequestId(request.id);
		const evaluation = this.evaluate(request);

		if (evaluation.action === "ask") {
			this.#pending.set(request.id, evaluation);
			return evaluation;
		}

		this.#consume(request.id);
		return {
			action: evaluation.action,
			source: "policy",
			mode: evaluation.mode,
			reason: evaluation.reason,
			request,
		};
	}

	public resolve(requestId: string, chatId: string, approved: boolean): ResolvedPermission {
		const evaluation = this.#pending.get(requestId);
		if (!evaluation) {
			throw new Error(`Unknown or already resolved permission request: ${requestId}`);
		}
		if (evaluation.request.chatId !== chatId) {
			throw new Error(`Permission request ${requestId} does not belong to chat ${chatId}`);
		}

		this.#pending.delete(requestId);
		this.#consume(requestId);
		return {
			action: approved ? "allow" : "deny",
			source: "user",
			mode: evaluation.mode,
			reason: approved ? "user-approved" : "user-denied",
			request: evaluation.request,
		};
	}

	public cancel(requestId: string): boolean {
		const deleted = this.#pending.delete(requestId);
		if (deleted) {
			this.#consume(requestId);
		}
		return deleted;
	}

	public pendingForChat(chatId: string): readonly PermissionEvaluation[] {
		return [...this.#pending.values()].filter(({ request }) => request.chatId === chatId);
	}

	public clear(): void {
		for (const requestId of this.#pending.keys()) {
			this.#consume(requestId);
		}
		this.#pending.clear();
	}

	#consume(requestId: string): void {
		this.#consumed.delete(requestId);
		this.#consumed.add(requestId);
		while (this.#consumed.size > this.#maxConsumedRequests) {
			const oldest = this.#consumed.values().next().value;
			if (!oldest) break;
			this.#consumed.delete(oldest);
		}
	}

	#assertFreshRequestId(requestId: string): void {
		if (this.#pending.has(requestId) || this.#consumed.has(requestId)) {
			throw new Error(`Duplicate permission request: ${requestId}`);
		}
	}
}
