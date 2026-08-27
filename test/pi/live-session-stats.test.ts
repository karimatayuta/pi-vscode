import { describe, expect, test } from "bun:test";
import {
	LiveStatsThrottle,
	withLiveMessageUsage,
} from "../../src/extension/pi/live-session-stats.js";
import type { PiSessionStatsDto, PiUsageDto } from "../../src/extension/pi/types.js";

const confirmed: PiSessionStatsDto = {
	userMessages: 2,
	assistantMessages: 1,
	toolCalls: 0,
	toolResults: 0,
	totalMessages: 3,
	tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, total: 150 },
	cost: 0.1,
	costKind: "estimated",
	context: { tokens: 150, contextWindow: 1_000, percent: 15 },
};

function usage(values: Partial<PiUsageDto>): PiUsageDto {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: 0,
		costKnown: true,
		...values,
	};
}

describe("live Pi session stats", () => {
	test("replaces cumulative message_update usage instead of adding previews together", () => {
		const first = withLiveMessageUsage(
			confirmed,
			usage({ input: 10, output: 2, total: 12, cost: 0.01 }),
		);
		const latest = withLiveMessageUsage(
			confirmed,
			usage({ input: 12, output: 5, total: 17, cost: 0.015 }),
		);
		expect(first.tokens).toEqual({
			input: 110,
			output: 22,
			cacheRead: 30,
			cacheWrite: 0,
			total: 162,
		});
		expect(latest.tokens).toEqual({
			input: 112,
			output: 25,
			cacheRead: 30,
			cacheWrite: 0,
			total: 167,
		});
		expect(latest.cost).toBeCloseTo(0.115);
		expect(latest.context).toMatchObject({ tokens: 17, contextWindow: 1_000 });
		expect(latest.context?.percent).toBeCloseTo(1.7);
	});

	test("keeps unknown streaming pricing unavailable instead of reporting zero", () => {
		const preview = withLiveMessageUsage(
			confirmed,
			usage({ input: 10, total: 10, cost: 0, costKnown: false }),
		);
		expect(preview.costKind).toBe("unknown");
		const subscription = withLiveMessageUsage(
			{ ...confirmed, costKind: "subscription" },
			usage({ input: 10, total: 10, costKnown: false }),
		);
		expect(subscription.costKind).toBe("subscription");
	});

	test("throttles streaming previews and resets at confirmed boundaries", () => {
		let now = 1_000;
		const throttle = new LiveStatsThrottle(100, () => now);
		expect(throttle.shouldPublishPreview()).toBe(true);
		now += 20;
		expect(throttle.shouldPublishPreview()).toBe(false);
		now += 80;
		expect(throttle.shouldPublishPreview()).toBe(true);
		throttle.confirmed();
		expect(throttle.shouldPublishPreview()).toBe(true);
	});
});
