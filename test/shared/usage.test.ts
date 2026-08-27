import { describe, expect, test } from "bun:test";
import {
	contextPercentage,
	contextThreshold,
	formatContextDetail,
	formatEstimatedCost,
	formatUsage,
} from "../../src/shared/usage.js";

describe("context usage", () => {
	test("calculates and clamps percentages", () => {
		expect(contextPercentage(54_000, 128_000)).toBeCloseTo(42.1875);
		expect(contextPercentage(200, 100)).toBe(100);
		expect(contextPercentage(-1, 100)).toBeNull();
		expect(contextPercentage(1, 0)).toBeNull();
		expect(contextPercentage(undefined, 100)).toBeNull();
	});

	test.each([
		[0, "normal"],
		[69.999, "normal"],
		[70, "warning"],
		[89.999, "warning"],
		[90, "critical"],
		[100, "critical"],
		[null, "unavailable"],
	] as const)("maps %s to %s", (percentage, threshold) => {
		expect(contextThreshold(percentage)).toBe(threshold);
	});

	test("formats ready usage without losing its numeric value", () => {
		const result = formatUsage(
			{
				status: "ready",
				usedTokens: 54_000,
				maxTokens: 128_000,
				estimatedCost: 0.18,
				currency: "USD",
			},
			"en-US",
		);
		expect(result.compact).toContain("42%");
		expect(result.compact).toContain("$0.18");
		expect(result.threshold).toBe("normal");
		expect(
			formatContextDetail({
				status: "ready",
				usedTokens: 54_000,
				maxTokens: 128_000,
			}),
		).toContain("42% used");
	});

	test("never reports unknown pricing as zero cost", () => {
		expect(
			formatUsage({
				status: "ready",
				usedTokens: 90,
				maxTokens: 100,
				estimatedCost: null,
			}).costLabel,
		).toBe("Cost unavailable");
		expect(formatUsage({ status: "unavailable" }).compact).toBe(
			"Context unavailable · Cost unavailable",
		);
		expect(formatEstimatedCost(undefined)).toBe("Calculating…");
		expect(formatEstimatedCost(null)).toBe("Cost unavailable");
	});

	test("does not round a real sub-cent cost down to zero", () => {
		expect(formatEstimatedCost(0.0001, "USD", "en-US")).toBe("<$0.01");
		expect(formatEstimatedCost(0, "USD", "en-US")).toContain("$0.00");
	});
});
