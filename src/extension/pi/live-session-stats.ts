import type { PiSessionStatsDto, PiUsageDto } from "./types.js";

export const LIVE_STATS_THROTTLE_MS = 160;

function componentTotal(usage: PiUsageDto): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Overlays the latest cumulative streaming usage on confirmed session totals.
 * Each call starts from the same SDK snapshot, so message_update values replace
 * the prior preview instead of being repeatedly accumulated.
 */
export function withLiveMessageUsage(
	confirmed: PiSessionStatsDto,
	latest: PiUsageDto,
): PiSessionStatsDto {
	const contextWindow = confirmed.context?.contextWindow;
	const context =
		contextWindow && latest.total > 0
			? {
					tokens: latest.total,
					contextWindow,
					percent: Math.min(100, Math.max(0, (latest.total / contextWindow) * 100)),
				}
			: confirmed.context;
	const costKind =
		confirmed.costKind === "subscription"
			? "subscription"
			: confirmed.costKind === "estimated" && latest.costKnown
				? "estimated"
				: "unknown";
	return {
		...confirmed,
		tokens: {
			input: confirmed.tokens.input + latest.input,
			output: confirmed.tokens.output + latest.output,
			cacheRead: confirmed.tokens.cacheRead + latest.cacheRead,
			cacheWrite: confirmed.tokens.cacheWrite + latest.cacheWrite,
			total: confirmed.tokens.total + componentTotal(latest),
		},
		cost: confirmed.cost + latest.cost,
		costKind,
		...(context ? { context } : {}),
	};
}

/** Leading-edge throttle; confirmed boundaries always reset and publish immediately. */
export class LiveStatsThrottle {
	#lastPreviewAt: number | undefined;

	public constructor(
		private readonly intervalMs = LIVE_STATS_THROTTLE_MS,
		private readonly now: () => number = Date.now,
	) {}

	public shouldPublishPreview(): boolean {
		const current = this.now();
		if (
			this.#lastPreviewAt !== undefined &&
			current >= this.#lastPreviewAt &&
			current - this.#lastPreviewAt < this.intervalMs
		) {
			return false;
		}
		this.#lastPreviewAt = current;
		return true;
	}

	public confirmed(): void {
		this.#lastPreviewAt = undefined;
	}
}
