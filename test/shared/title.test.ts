import { describe, expect, test } from "bun:test";
import {
	applyGeneratedTitle,
	createChatTitleState,
	createFallbackTitle,
	renameChatTitle,
	sanitizeGeneratedTitle,
	truncateTitle,
	unlockTitleForRegeneration,
} from "../../src/shared/title.js";

describe("chat titles", () => {
	test("creates a compact fallback from the first prompt", () => {
		expect(createFallbackTitle("  Refactor   the\nauth flow  ")).toBe("Refactor the auth flow");
		expect(createFallbackTitle("```ts\nconst secret = 1\n```\nFix it")).toBe("Fix it");
	});

	test("redacts common secret-like values from fallback titles", () => {
		const title = createFallbackTitle("Fix API_KEY=very-secret-value and token-ABCDEF123456789");
		expect(title).not.toContain("very-secret-value");
		expect(title).not.toContain("ABCDEF123456789");
		expect(title).toContain("[redacted]");
	});

	test("normalizes generated title wrappers and word count", () => {
		expect(
			sanitizeGeneratedTitle(
				'Title: "Refactor the authentication refresh token flow safely today"',
				"fallback",
			),
		).toEqual({
			value: "Refactor the authentication refresh token flow…",
			source: "generated",
		});
	});

	test("falls back when the generated title is empty", () => {
		expect(sanitizeGeneratedTitle("  ", "Explain the current selection")).toEqual({
			value: "Explain the current selection",
			source: "fallback",
		});
	});

	test("truncates by Unicode code point instead of splitting a surrogate pair", () => {
		expect(truncateTitle("abc😀def", 5)).toBe("abc😀…");
	});

	test("manual rename locks out late generation until explicitly unlocked", () => {
		const initial = createChatTitleState();
		const renamed = renameChatTitle(initial, "  My auth work  ");
		expect(renamed.ok).toBe(true);
		if (!renamed.ok) {
			throw new Error("Expected rename to succeed");
		}
		expect(renamed.state).toMatchObject({
			value: "My auth work",
			source: "manual",
			renameLocked: true,
		});
		expect(applyGeneratedTitle(renamed.state, "Late generated title", "fallback")).toBe(
			renamed.state,
		);

		const unlocked = unlockTitleForRegeneration(renamed.state);
		expect(applyGeneratedTitle(unlocked, "Fresh generated title", "fallback")).toMatchObject({
			value: "Fresh generated title",
			source: "generated",
		});
	});

	test("rejects empty and overlong manual titles without changing state", () => {
		const state = createChatTitleState();
		expect(renameChatTitle(state, "  ")).toMatchObject({
			ok: false,
			code: "empty",
		});
		expect(renameChatTitle(state, "x".repeat(81))).toMatchObject({
			ok: false,
			code: "too-long",
		});
	});
});
