import type { ModelOption, ModelState, ThinkingLevel } from "./types.js";

export interface ModelSettingsDraft {
	readonly provider: string;
	readonly modelId: string;
	readonly thinking: ThinkingLevel;
}

const THINKING_LEVEL_ORDER = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

const THINKING_LEVEL_LABELS: Readonly<Record<ThinkingLevel, string>> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

export function thinkingLevelLabel(level: ThinkingLevel): string {
	return THINKING_LEVEL_LABELS[level];
}

export function nearestSupportedThinkingLevel(
	preferred: ThinkingLevel,
	supported: readonly ThinkingLevel[],
): ThinkingLevel {
	if (supported.length === 0) return "off";
	if (supported.includes(preferred)) return preferred;
	const preferredIndex = THINKING_LEVEL_ORDER.indexOf(preferred);
	return [...supported].sort((left, right) => {
		const leftIndex = THINKING_LEVEL_ORDER.indexOf(left);
		const rightIndex = THINKING_LEVEL_ORDER.indexOf(right);
		const distance = Math.abs(leftIndex - preferredIndex) - Math.abs(rightIndex - preferredIndex);
		return distance === 0 ? leftIndex - rightIndex : distance;
	})[0] as ThinkingLevel;
}

export function draftForCurrentModel(model: ModelState): ModelSettingsDraft | undefined {
	if (!model.provider || !model.id) return undefined;
	return { provider: model.provider, modelId: model.id, thinking: model.thinking };
}

export function draftForModelOption(
	option: ModelOption,
	preferredThinking: ThinkingLevel,
): ModelSettingsDraft {
	return {
		provider: option.provider,
		modelId: option.id,
		thinking: nearestSupportedThinkingLevel(preferredThinking, option.thinkingLevels),
	};
}

export function modelOptionMatchesDraft(
	option: ModelOption,
	draft: ModelSettingsDraft | undefined,
): boolean {
	return Boolean(draft && option.provider === draft.provider && option.id === draft.modelId);
}

export function modelSettingsChanged(
	model: ModelState,
	draft: ModelSettingsDraft | undefined,
): boolean {
	if (!draft) return false;
	return (
		draft.provider !== model.provider ||
		draft.modelId !== model.id ||
		draft.thinking !== model.thinking
	);
}
