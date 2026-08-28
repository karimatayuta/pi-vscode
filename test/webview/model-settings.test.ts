import { describe, expect, test } from "bun:test";
import {
	draftForCurrentModel,
	draftForModelOption,
	modelOptionMatchesDraft,
	modelSettingsChanged,
	nearestSupportedThinkingLevel,
	thinkingLevelLabel,
} from "../../src/webview/model-settings.js";
import type { ModelOption, ModelState } from "../../src/webview/types.js";

const current: ModelState = {
	provider: "anthropic",
	id: "claude-current",
	name: "Claude Current",
	thinking: "high",
	options: [],
	loading: false,
};

const option: ModelOption = {
	provider: "openai",
	id: "developer-model",
	name: "Developer Model",
	contextWindow: 200_000,
	supportsImages: true,
	thinkingLevels: ["off", "low", "medium"],
};

describe("model settings drafts", () => {
	test("keeps reasoning when supported and otherwise selects the nearest lower effort", () => {
		expect(nearestSupportedThinkingLevel("medium", option.thinkingLevels)).toBe("medium");
		expect(nearestSupportedThinkingLevel("high", option.thinkingLevels)).toBe("medium");
		expect(nearestSupportedThinkingLevel("off", ["minimal", "low"])).toBe("minimal");
		expect(nearestSupportedThinkingLevel("max", [])).toBe("off");
	});

	test("stages model and reasoning together without mutating the current state", () => {
		const currentDraft = draftForCurrentModel(current);
		expect(currentDraft).toEqual({
			provider: "anthropic",
			modelId: "claude-current",
			thinking: "high",
		});
		expect(modelSettingsChanged(current, currentDraft)).toBe(false);

		const nextDraft = draftForModelOption(option, current.thinking);
		expect(nextDraft).toEqual({
			provider: "openai",
			modelId: "developer-model",
			thinking: "medium",
		});
		expect(modelOptionMatchesDraft(option, nextDraft)).toBe(true);
		expect(modelSettingsChanged(current, nextDraft)).toBe(true);
		expect(current.thinking).toBe("high");
	});

	test("uses developer-friendly labels for extended reasoning levels", () => {
		expect(thinkingLevelLabel("xhigh")).toBe("Extra high");
		expect(thinkingLevelLabel("max")).toBe("Max");
	});
});
