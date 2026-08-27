export type UsageStatus = "ready" | "calculating" | "unavailable";

export interface UsageSnapshot {
	readonly status: UsageStatus;
	readonly usedTokens?: number;
	readonly maxTokens?: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cachedInputTokens?: number;
	/** `undefined` means pricing has not arrived; `null` means unavailable. */
	readonly estimatedCost?: number | null;
	readonly currency?: string;
}

export type ContextThreshold = "normal" | "warning" | "critical" | "unavailable";

export interface FormattedUsage {
	readonly compact: string;
	readonly contextLabel: string;
	readonly costLabel: string;
	readonly percentage: number | null;
	readonly threshold: ContextThreshold;
}

function isFiniteNonNegative(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value >= 0;
}

export function contextPercentage(
	usedTokens: number | undefined,
	maxTokens: number | undefined,
): number | null {
	if (
		!isFiniteNonNegative(usedTokens) ||
		maxTokens === undefined ||
		!Number.isFinite(maxTokens) ||
		maxTokens <= 0
	) {
		return null;
	}

	return Math.min(100, Math.max(0, (usedTokens / maxTokens) * 100));
}

export function contextThreshold(percentage: number | null): ContextThreshold {
	if (percentage === null || !Number.isFinite(percentage)) {
		return "unavailable";
	}
	if (percentage >= 90) {
		return "critical";
	}
	if (percentage >= 70) {
		return "warning";
	}
	return "normal";
}

export function formatTokenCount(value: number, locale = "en-US"): string {
	return new Intl.NumberFormat(locale, {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(value);
}

export function formatEstimatedCost(
	amount: number | null | undefined,
	currency = "USD",
	locale = "en-US",
): string {
	if (amount === undefined) {
		return "Calculating…";
	}
	if (amount === null || !Number.isFinite(amount) || amount < 0) {
		return "Cost unavailable";
	}

	const normalizedCurrency = /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : "USD";
	if (amount > 0 && amount < 0.01) {
		const oneCent = new Intl.NumberFormat(locale, {
			style: "currency",
			currency: normalizedCurrency,
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		}).format(0.01);
		return `<${oneCent}`;
	}

	return new Intl.NumberFormat(locale, {
		style: "currency",
		currency: normalizedCurrency,
		minimumFractionDigits: 2,
		maximumFractionDigits: amount >= 100 ? 2 : 4,
	}).format(amount);
}

export function formatUsage(usage: UsageSnapshot, locale = "en-US"): FormattedUsage {
	if (usage.status === "calculating") {
		return {
			compact: "Calculating…",
			contextLabel: "Calculating context…",
			costLabel: "Calculating…",
			percentage: null,
			threshold: "unavailable",
		};
	}

	if (usage.status === "unavailable") {
		return {
			compact: "Context unavailable · Cost unavailable",
			contextLabel: "Context unavailable",
			costLabel: "Cost unavailable",
			percentage: null,
			threshold: "unavailable",
		};
	}

	const percentage = contextPercentage(usage.usedTokens, usage.maxTokens);
	const contextLabel = percentage === null ? "Context unavailable" : `${Math.round(percentage)}%`;
	const costLabel = formatEstimatedCost(usage.estimatedCost, usage.currency, locale);

	return {
		compact: `${contextLabel} · ${costLabel}`,
		contextLabel,
		costLabel,
		percentage,
		threshold: contextThreshold(percentage),
	};
}

export function formatContextDetail(usage: UsageSnapshot, locale = "en-US"): string {
	const percentage = contextPercentage(usage.usedTokens, usage.maxTokens);
	if (
		usage.status !== "ready" ||
		percentage === null ||
		usage.usedTokens === undefined ||
		usage.maxTokens === undefined
	) {
		return usage.status === "calculating" ? "Calculating context…" : "Context unavailable";
	}

	return `${formatTokenCount(usage.usedTokens, locale)} / ${formatTokenCount(
		usage.maxTokens,
		locale,
	)} tokens · ${Math.round(percentage)}% used`;
}
