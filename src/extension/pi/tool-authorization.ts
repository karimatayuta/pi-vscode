import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InlineExtension, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isPathInside } from "../filesystem/workspace-path.js";
import { redactString } from "./sanitize.js";
import type {
	PiHostSessionId,
	PiToolAuthorizationDecision,
	PiToolAuthorizationRequest,
	PiToolCapability,
	PiToolRisk,
} from "./types.js";

const GATE_NAME = "pi-vscode-permission-gate";
const MAX_PATH_CHARACTERS = 32 * 1024;
const MAX_COMMAND_CHARACTERS = 128 * 1024;
const READ_TOOLS = new Set(["read"]);
const SEARCH_TOOLS = new Set(["grep", "find", "ls"]);
const MUTATION_TOOLS = new Set(["edit", "write"]);
const EXECUTION_TOOLS = new Set(["bash", "powershell"]);
const DANGEROUS_COMMAND = new RegExp(
	[
		String.raw`\b(?:sudo|doas)\b`,
		String.raw`\b(?:rm|rmdir|shred|unlink|truncate)\b`,
		String.raw`\b(?:del|erase|rd)\s+(?:/s|/q|/f)\b`,
		String.raw`\bRemove-Item\b`,
		String.raw`\b(?:mkfs|fdisk|diskpart)\b`,
		String.raw`\bdd\s+[^\n]*(?:of=|if=\/dev\/)`,
		String.raw`\b(?:chmod|chown|chgrp)\b`,
		String.raw`\bgit\s+(?:reset\s+--hard|clean\b|checkout\s+--|restore\b|branch\s+-D|push\b[^\n]*--force|rebase\b)`,
		String.raw`\b(?:curl|wget|fetch|nc|ncat|netcat|telnet|ssh|scp|sftp)\b`,
		String.raw`\b(?:npm|pnpm|yarn|bun)\s+publish\b`,
		String.raw`\b(?:docker|podman)\s+(?:push|system\s+prune)\b`,
		String.raw`\b(?:kill|pkill|killall)\b`,
		String.raw`(?:^|[;&|])\s*(?:eval|source|\.)\s+`,
		String.raw`(?:>|>>|2>)\s*(?:\/dev\/|~\/|\.\.?\/)`,
	].join("|"),
	"iu",
);

export interface ToolAuthorizationGateOptions {
	readonly sessionId: PiHostSessionId;
	readonly cwd: string;
	/** Returns the local workspace roots that are current when a tool call starts. */
	readonly workspaceRoots?: () => readonly string[];
	/** Canonical, package-owned documentation that the built-in read tool may inspect. */
	readonly packageReadResources?: PackageReadResources;
	readonly authorize?: (
		request: PiToolAuthorizationRequest,
	) => Promise<PiToolAuthorizationDecision>;
}

export interface PackageReadResources {
	readonly files: readonly string[];
	readonly directories: readonly string[];
}

export interface ToolClassificationOptions {
	readonly sessionId: PiHostSessionId;
	readonly cwd: string;
	readonly workspaceRoots?: readonly string[];
	readonly packageReadResources?: PackageReadResources;
}

export interface ClassifiedToolCall {
	readonly request: PiToolAuthorizationRequest;
	readonly requiresAuthorization: boolean;
}

function normalizeWindowsShellPath(value: string): string {
	if (
		process.platform !== "win32" ||
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("\\")
	) {
		return value;
	}
	const match = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/iu);
	if (!match?.[1]) {
		return value;
	}
	return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

function resolveLikePi(rawTarget: string, cwd: string): string {
	let normalized = rawTarget.startsWith("@") ? rawTarget.slice(1) : rawTarget;
	normalized = normalized.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu, " ");
	if (normalized === "~") {
		normalized = homedir();
	} else if (
		normalized.startsWith("~/") ||
		(process.platform === "win32" && normalized.startsWith("~\\"))
	) {
		normalized = join(homedir(), normalized.slice(2));
	} else if (/^file:\/\//iu.test(normalized)) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			// The malformed value remains relative to cwd and will require authorization.
		}
	}
	normalized = normalizeWindowsShellPath(normalized);
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

async function canonicalizeNearestExisting(target: string): Promise<string> {
	let cursor = target;
	const suffix: string[] = [];
	while (true) {
		try {
			const existing = await realpath(cursor);
			return resolve(existing, ...suffix);
		} catch {
			const parent = dirname(cursor);
			if (parent === cursor) {
				return target;
			}
			suffix.unshift(basename(cursor));
			cursor = parent;
		}
	}
}

async function canonicalWorkspaceRoots(options: ToolClassificationOptions): Promise<string[]> {
	const configuredRoots = options.workspaceRoots ?? [options.cwd];
	const roots = await Promise.all(
		configuredRoots.map(async (root) => {
			try {
				return await realpath(resolve(root));
			} catch {
				// Removed or unreadable workspace roots must stop granting access immediately.
				return undefined;
			}
		}),
	);
	return [...new Set(roots.filter((root): root is string => root !== undefined))];
}

function isSensitivePath(value: string): boolean {
	const normalized = value
		.replaceAll("\\", "/")
		.replace(/[?*[\]{}]/gu, "")
		.toLowerCase();
	const parts = normalized.split("/").filter(Boolean);
	const name = parts.at(-1) ?? "";
	return (
		parts.some((part) => [".ssh", ".gnupg", ".aws", ".azure", ".git"].includes(part)) ||
		name === ".env" ||
		name.startsWith(".env.") ||
		[".npmrc", ".pypirc", ".netrc", "auth.json", "credentials", "credentials.json"].includes(
			name,
		) ||
		/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/u.test(name) ||
		/(?:^|[._-])(?:secret|private[-_]?key|service[-_]?account)(?:[._-]|$)/u.test(name) ||
		/\.(?:key|pem|p12|pfx|jks)$/u.test(name)
	);
}

function inputString(event: ToolCallEvent, key: string): string | undefined {
	const value = (event.input as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function isPackageReadTarget(target: string, resources: PackageReadResources | undefined): boolean {
	return (
		resources?.files.some((file) => resolve(file) === target) === true ||
		resources?.directories.some((directory) => isPathInside(directory, target)) === true
	);
}

function capabilityFor(toolName: string): PiToolCapability {
	if (READ_TOOLS.has(toolName)) {
		return "read";
	}
	if (SEARCH_TOOLS.has(toolName)) {
		return "search";
	}
	if (MUTATION_TOOLS.has(toolName)) {
		return "mutate";
	}
	if (EXECUTION_TOOLS.has(toolName)) {
		return "execute";
	}
	return "extension";
}

function riskFor(options: {
	readonly capability: PiToolCapability;
	readonly outsideWorkspace: boolean;
	readonly sensitive: boolean;
	readonly command?: string;
}): PiToolRisk {
	if (
		options.outsideWorkspace ||
		options.capability === "extension" ||
		(options.command !== undefined && DANGEROUS_COMMAND.test(options.command)) ||
		(options.capability === "mutate" && options.sensitive)
	) {
		return "dangerous";
	}
	if (options.sensitive || options.capability === "execute") {
		return "sensitive";
	}
	return "safe";
}

export async function classifyToolCall(
	event: ToolCallEvent,
	options: ToolClassificationOptions,
): Promise<ClassifiedToolCall> {
	const capability = capabilityFor(event.toolName);
	const rawPath = inputString(event, "path") ?? (capability === "read" ? "" : undefined);
	const command = capability === "execute" ? (inputString(event, "command") ?? "") : undefined;
	let target: string | undefined;
	let outsideWorkspace = false;
	if (rawPath !== undefined) {
		const boundedRawPath = rawPath.slice(0, MAX_PATH_CHARACTERS) || ".";
		const [resolvedTarget, workspaceRoots] = await Promise.all([
			canonicalizeNearestExisting(resolveLikePi(boundedRawPath, options.cwd)),
			canonicalWorkspaceRoots(options),
		]);
		target = resolvedTarget;
		const packageReadAllowed =
			capability === "read" && isPackageReadTarget(resolvedTarget, options.packageReadResources);
		outsideWorkspace =
			!workspaceRoots.some((root) => isPathInside(root, resolvedTarget)) && !packageReadAllowed;
	}
	const searchHint = [rawPath, inputString(event, "glob"), inputString(event, "pattern")]
		.filter((value): value is string => value !== undefined)
		.join("/");
	const sensitive =
		(target !== undefined && isSensitivePath(target)) || isSensitivePath(searchHint);
	const boundedCommand = command?.slice(0, MAX_COMMAND_CHARACTERS);
	const safeCommand = boundedCommand === undefined ? undefined : redactString(boundedCommand);
	const risk = riskFor({
		capability,
		outsideWorkspace,
		sensitive,
		...(boundedCommand === undefined ? {} : { command: boundedCommand }),
	});
	const request: PiToolAuthorizationRequest = {
		sessionId: options.sessionId,
		toolCallId: redactString(event.toolCallId, 256),
		toolName: redactString(event.toolName, 256),
		capability,
		...(target === undefined ? {} : { target }),
		...(safeCommand === undefined ? {} : { command: safeCommand }),
		cwd: resolve(options.cwd),
		risk,
	};
	return {
		request,
		requiresAuthorization: risk !== "safe" || capability === "mutate",
	};
}

export function createToolAuthorizationExtension(
	options: ToolAuthorizationGateOptions,
): InlineExtension {
	return {
		name: GATE_NAME,
		hidden: true,
		factory: (pi) => {
			pi.on("tool_call", async (event) => {
				let classified: ClassifiedToolCall;
				try {
					classified = await classifyToolCall(event, {
						sessionId: options.sessionId,
						cwd: options.cwd,
						...(options.workspaceRoots === undefined
							? {}
							: { workspaceRoots: options.workspaceRoots() }),
						...(options.packageReadResources === undefined
							? {}
							: { packageReadResources: options.packageReadResources }),
					});
				} catch {
					return { block: true, reason: "Tool authorization failed closed." };
				}
				if (!classified.requiresAuthorization) {
					return undefined;
				}
				if (!options.authorize) {
					return {
						block: true,
						reason: "This tool call requires explicit authorization from the VS Code host.",
					};
				}
				try {
					const decision = await options.authorize(classified.request);
					if (decision.allow) {
						return undefined;
					}
					return {
						block: true,
						reason: decision.reason
							? redactString(decision.reason, 2_048)
							: "The VS Code host denied this tool call.",
					};
				} catch {
					return {
						block: true,
						reason: "Tool authorization failed closed.",
					};
				}
			});
		},
	};
}

/** Keep the gate after disk/project extensions so it validates their final argument mutations. */
export function moveAuthorizationGateLast<T extends { readonly path: string }>(
	extensions: readonly T[],
): T[] {
	return [
		...extensions.filter((extension) => extension.path !== `<inline:${GATE_NAME}>`),
		...extensions.filter((extension) => extension.path === `<inline:${GATE_NAME}>`),
	];
}
