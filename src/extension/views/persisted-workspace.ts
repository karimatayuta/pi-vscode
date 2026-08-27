import { isAbsolute } from "node:path";
import type { ApprovalMode } from "../../shared/approval.js";
import { sanitizePersistedTitle } from "../../shared/title.js";
import type { PiThinkingLevel } from "../pi/types.js";

export interface PersistedTab {
	readonly id: string;
	readonly title: string;
	readonly manualTitle: boolean;
	readonly sessionFile?: string;
	readonly approvalMode: ApprovalMode;
	readonly model?: { readonly provider: string; readonly id: string };
	readonly thinking?: PiThinkingLevel;
}

export interface PersistedWorkspace {
	readonly version: 1;
	readonly activeChatId?: string;
	readonly tabs: readonly PersistedTab[];
}

const MAX_TABS = 20;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_PROVIDER = /^[A-Za-z0-9._-]{1,256}$/u;
const THINKING_LEVELS: ReadonlySet<string> = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function hasControlCharacters(value: string): boolean {
	return [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
}

function restoredMode(value: unknown, trusted: boolean): ApprovalMode {
	if (!trusted) return "plan";
	if (value === "plan" || value === "ask" || value === "autoEdit") return value;
	// Full Access is deliberately never restored across extension lifetimes.
	return "ask";
}

function sessionFile(value: unknown): string | undefined {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 4_096 ||
		!isAbsolute(value) ||
		hasControlCharacters(value)
	) {
		return undefined;
	}
	return value;
}

function model(value: unknown): PersistedTab["model"] | undefined {
	const candidate = object(value);
	if (
		!candidate ||
		typeof candidate.provider !== "string" ||
		!SAFE_PROVIDER.test(candidate.provider)
	) {
		return undefined;
	}
	if (
		typeof candidate.id !== "string" ||
		candidate.id.length === 0 ||
		candidate.id.length > 512 ||
		hasControlCharacters(candidate.id)
	) {
		return undefined;
	}
	return { provider: candidate.provider, id: candidate.id };
}

export function parsePersistedWorkspace(
	value: unknown,
	trusted: boolean,
): PersistedWorkspace | undefined {
	const workspace = object(value);
	if (workspace?.version !== 1 || !Array.isArray(workspace.tabs)) return undefined;
	const tabs: PersistedTab[] = [];
	const ids = new Set<string>();
	for (const rawTab of workspace.tabs.slice(0, MAX_TABS)) {
		const tab = object(rawTab);
		if (!tab || typeof tab.id !== "string" || !SAFE_ID.test(tab.id) || ids.has(tab.id)) continue;
		ids.add(tab.id);
		const restoredModel = model(tab.model);
		const restoredSessionFile = sessionFile(tab.sessionFile);
		const thinking =
			typeof tab.thinking === "string" && THINKING_LEVELS.has(tab.thinking)
				? (tab.thinking as PiThinkingLevel)
				: undefined;
		tabs.push({
			id: tab.id,
			title: sanitizePersistedTitle(tab.title),
			manualTitle: tab.manualTitle === true,
			approvalMode: restoredMode(tab.approvalMode, trusted),
			...(restoredSessionFile === undefined ? {} : { sessionFile: restoredSessionFile }),
			...(restoredModel === undefined ? {} : { model: restoredModel }),
			...(thinking === undefined ? {} : { thinking }),
		});
	}
	const activeChatId =
		typeof workspace.activeChatId === "string" && ids.has(workspace.activeChatId)
			? workspace.activeChatId
			: undefined;
	return {
		version: 1,
		tabs,
		...(activeChatId === undefined ? {} : { activeChatId }),
	};
}
