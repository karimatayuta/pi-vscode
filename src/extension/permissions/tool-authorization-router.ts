import { randomUUID } from "node:crypto";
import type { ApprovalMode, Capability, RiskLevel } from "../../shared/approval.js";
import { PermissionBroker, type PermissionRequest } from "./permission-broker.js";

export type ToolRisk = "normal" | "sensitive" | "dangerous";

export interface ToolAuthorizationInput {
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly capability: Capability;
	readonly cwd: string;
	readonly target?: string;
	readonly command?: string;
	readonly risk: ToolRisk;
	readonly detail?: string;
}

export interface ToolAuthorizationResult {
	readonly allow: boolean;
	readonly reason?: string;
}

export interface ToolApprovalPrompt {
	readonly id: string;
	readonly chatId: string;
	readonly sessionId: string;
	readonly capability: Capability;
	readonly risk: ToolRisk;
	readonly title: string;
	readonly detail: string;
	readonly command?: string;
	readonly cwd: string;
	readonly targets?: readonly string[];
}

interface PendingAuthorization {
	readonly prompt: ToolApprovalPrompt;
	readonly signature: string;
	readonly broker: PermissionBroker;
	readonly timeout: ReturnType<typeof setTimeout>;
	readonly resolve: (result: ToolAuthorizationResult) => void;
}

interface SessionPolicy {
	readonly chatId: string;
	readonly broker: PermissionBroker;
	readonly grants: Set<string>;
}

export interface ToolAuthorizationRouterOptions {
	readonly maxPending?: number;
	readonly maxPendingPerSession?: number;
	readonly maxSessionGrants?: number;
	readonly approvalTimeoutMs?: number;
}

const DEFAULT_MAX_PENDING = 128;
const DEFAULT_MAX_PENDING_PER_SESSION = 16;
const DEFAULT_MAX_SESSION_GRANTS = 4_096;
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return value;
}

function riskLevel(risk: ToolRisk): RiskLevel {
	return risk === "dangerous" ? "critical" : risk === "sensitive" ? "high" : "medium";
}

function signatureFor(input: ToolAuthorizationInput): string {
	if (input.capability === "command.execute") {
		const executable = input.command?.trim().split(/\s+/u)[0] ?? "";
		return `${input.capability}\0${input.cwd}\0${executable}`;
	}
	return `${input.capability}\0${input.target ?? input.cwd}`;
}

function titleFor(input: ToolAuthorizationInput): string {
	if (input.capability === "command.execute") return `Run ${input.toolName} command?`;
	if (input.capability === "workspace.edit") return "Apply a workspace edit?";
	if (input.capability === "workspace.write") return "Write a workspace file?";
	if (input.capability === "workspace.delete") return "Delete workspace content?";
	if (input.capability === "secrets.read") return "Read a potentially sensitive file?";
	if (input.capability === "filesystem.outside-workspace")
		return "Access a path outside the workspace?";
	return `Allow ${input.toolName}?`;
}

function detailFor(input: ToolAuthorizationInput): string {
	return (
		input.detail ??
		(input.command
			? `Pi wants to run this exact command from ${input.cwd}.`
			: input.target
				? `Pi wants to access ${input.target}.`
				: `Pi requested ${input.capability}.`)
	);
}

export class ToolAuthorizationRouter {
	readonly #sessions = new Map<string, SessionPolicy>();
	readonly #pending = new Map<string, PendingAuthorization>();
	readonly #requestListeners = new Set<(prompt: ToolApprovalPrompt) => void>();
	readonly #resolveListeners = new Set<
		(event: { readonly id: string; readonly chatId: string }) => void
	>();
	readonly #resetListeners = new Set<() => void>();
	readonly #maxPending: number;
	readonly #maxPendingPerSession: number;
	readonly #maxSessionGrants: number;
	readonly #approvalTimeoutMs: number;

	public constructor(options: ToolAuthorizationRouterOptions = {}) {
		this.#maxPending = positiveInteger(options.maxPending ?? DEFAULT_MAX_PENDING, "Pending limit");
		this.#maxPendingPerSession = positiveInteger(
			options.maxPendingPerSession ?? DEFAULT_MAX_PENDING_PER_SESSION,
			"Per-session pending limit",
		);
		this.#maxSessionGrants = positiveInteger(
			options.maxSessionGrants ?? DEFAULT_MAX_SESSION_GRANTS,
			"Session grant limit",
		);
		this.#approvalTimeoutMs = positiveInteger(
			options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
			"Approval timeout",
		);
	}

	public onDidRequest(listener: (prompt: ToolApprovalPrompt) => void): { dispose(): void } {
		this.#requestListeners.add(listener);
		return { dispose: () => this.#requestListeners.delete(listener) };
	}

	public onDidResolve(
		listener: (event: { readonly id: string; readonly chatId: string }) => void,
	): { dispose(): void } {
		this.#resolveListeners.add(listener);
		return { dispose: () => this.#resolveListeners.delete(listener) };
	}

	public onDidReset(listener: () => void): { dispose(): void } {
		this.#resetListeners.add(listener);
		return { dispose: () => this.#resetListeners.delete(listener) };
	}

	public register(sessionId: string, chatId: string, mode: ApprovalMode): void {
		this.#sessions.set(sessionId, {
			chatId,
			broker: new PermissionBroker(mode),
			grants: new Set(),
		});
	}

	public unregister(sessionId: string): void {
		const session = this.#sessions.get(sessionId);
		if (!session) return;
		for (const [id, pending] of this.#pending) {
			if (pending.prompt.sessionId === sessionId) {
				clearTimeout(pending.timeout);
				pending.broker.cancel(id);
				pending.resolve({ allow: false, reason: "The chat session was closed." });
				this.#pending.delete(id);
				this.#emitResolved({ id, chatId: session.chatId });
			}
		}
		session.broker.clear();
		session.grants.clear();
		this.#sessions.delete(sessionId);
	}

	public cancelPendingForSession(
		sessionId: string,
		reason = "The pending tool request was cancelled.",
	): number {
		let cancelled = 0;
		for (const [id, pending] of this.#pending) {
			if (pending.prompt.sessionId !== sessionId) continue;
			clearTimeout(pending.timeout);
			pending.broker.cancel(id);
			pending.resolve({ allow: false, reason });
			this.#pending.delete(id);
			this.#emitResolved({ id, chatId: pending.prompt.chatId });
			cancelled += 1;
		}
		return cancelled;
	}

	public setMode(sessionId: string, mode: ApprovalMode): void {
		const session = this.#sessions.get(sessionId);
		if (!session) return;
		session.broker.setMode(mode);
		if (mode === "plan" || mode === "ask") {
			session.grants.clear();
		}
	}

	public async authorize(input: ToolAuthorizationInput): Promise<ToolAuthorizationResult> {
		const session = this.#sessions.get(input.sessionId);
		if (!session) {
			return {
				allow: false,
				reason: "The tool request is not attached to an active Pi Agent chat.",
			};
		}
		const signature = signatureFor(input);
		if (input.risk !== "dangerous" && session.grants.delete(signature)) {
			// A Set preserves insertion order, so reinsertion makes this a bounded LRU.
			session.grants.add(signature);
			return { allow: true };
		}
		const id = randomUUID();
		const request: PermissionRequest = {
			id,
			chatId: session.chatId,
			capability: input.capability,
			risk: riskLevel(input.risk),
			summary: detailFor(input),
			...(input.target ? { resource: input.target } : {}),
		};
		const evaluation = session.broker.begin(request);
		if (evaluation.action === "allow" || evaluation.action === "deny") {
			return {
				allow: evaluation.action === "allow",
				...(evaluation.action === "deny"
					? { reason: "Blocked by the active Pi Agent approval mode." }
					: {}),
			};
		}
		const pendingForSession = [...this.#pending.values()].filter(
			(pending) => pending.prompt.sessionId === input.sessionId,
		).length;
		if (this.#pending.size >= this.#maxPending || pendingForSession >= this.#maxPendingPerSession) {
			session.broker.cancel(id);
			return {
				allow: false,
				reason: "Too many tool approval requests are already waiting.",
			};
		}
		const prompt: ToolApprovalPrompt = {
			id,
			chatId: session.chatId,
			sessionId: input.sessionId,
			capability: input.capability,
			risk: input.risk,
			title: titleFor(input),
			detail: detailFor(input),
			...(input.command ? { command: input.command } : {}),
			cwd: input.cwd,
			...(input.target ? { targets: [input.target] } : {}),
		};
		return new Promise<ToolAuthorizationResult>((resolve) => {
			const timeout = setTimeout(() => {
				session.broker.cancel(id);
				this.#pending.delete(id);
				this.#emitResolved({ id, chatId: session.chatId });
				resolve({ allow: false, reason: "The approval request expired." });
			}, this.#approvalTimeoutMs);
			this.#pending.set(id, { prompt, signature, broker: session.broker, timeout, resolve });
			for (const listener of this.#requestListeners) {
				listener(prompt);
			}
		});
	}

	public resolve(
		id: string,
		chatId: string,
		decision: "deny" | "allowOnce" | "allowSession",
	): boolean {
		const pending = this.#pending.get(id);
		if (!pending || pending.prompt.chatId !== chatId) {
			return false;
		}
		clearTimeout(pending.timeout);
		this.#pending.delete(id);
		const approved = decision !== "deny";
		pending.broker.resolve(id, chatId, approved);
		if (decision === "allowSession" && pending.prompt.risk === "normal") {
			const session = this.#sessions.get(pending.prompt.sessionId);
			if (session) this.#rememberGrant(session, pending.signature);
		}
		pending.resolve(
			approved ? { allow: true } : { allow: false, reason: "The user denied this tool request." },
		);
		this.#emitResolved({ id, chatId });
		return true;
	}

	public reset(): void {
		for (const session of this.#sessions.values()) {
			session.grants.clear();
			session.broker.clear();
		}
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timeout);
			pending.resolve({ allow: false, reason: "Permissions were reset." });
			this.#pending.delete(id);
			this.#emitResolved({ id, chatId: pending.prompt.chatId });
		}
		for (const listener of this.#resetListeners) listener();
	}

	public dispose(): void {
		this.reset();
		this.#sessions.clear();
		this.#requestListeners.clear();
		this.#resolveListeners.clear();
		this.#resetListeners.clear();
	}

	#emitResolved(event: { readonly id: string; readonly chatId: string }): void {
		for (const listener of this.#resolveListeners) {
			listener(event);
		}
	}

	#rememberGrant(session: SessionPolicy, signature: string): void {
		session.grants.delete(signature);
		session.grants.add(signature);
		while (session.grants.size > this.#maxSessionGrants) {
			const oldest = session.grants.values().next().value;
			if (oldest === undefined) break;
			session.grants.delete(oldest);
		}
	}
}
