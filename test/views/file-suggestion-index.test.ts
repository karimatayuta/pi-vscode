import { describe, expect, test } from "bun:test";
import { FileSuggestionIndex } from "../../src/extension/views/file-suggestion-index.js";

describe("file suggestion host index", () => {
	test("selects the exact same-name file from its displayed workspace root", () => {
		const index = new FileSuggestionIndex<string>();
		const suggestions = index.replace([
			{
				suggestion: { id: "root-a", label: "root-a/src/config.ts", kind: "file" },
				target: "file:///work/root-a/src/config.ts",
			},
			{
				suggestion: { id: "root-b", label: "root-b/src/config.ts", kind: "file" },
				target: "file:///work/root-b/src/config.ts",
			},
		]);

		expect(suggestions.map((suggestion) => suggestion.label)).toEqual([
			"root-a/src/config.ts",
			"root-b/src/config.ts",
		]);
		expect(index.resolve(suggestions[1]?.id ?? "")).toBe("file:///work/root-b/src/config.ts");
		expect(index.resolve("forged-id")).toBeUndefined();
	});

	test("invalidates old-query IDs and never exceeds its host-side bound", () => {
		const index = new FileSuggestionIndex<number>(2);
		index.replace([{ suggestion: { id: "old", label: "root/old.ts", kind: "file" }, target: 1 }]);
		const current = index.replace(
			[2, 3, 4].map((target) => ({
				suggestion: { id: `current-${target}`, label: `root/${target}.ts`, kind: "file" as const },
				target,
			})),
		);

		expect(current).toHaveLength(2);
		expect(index.resolve("old")).toBeUndefined();
		expect(index.resolve("current-2")).toBe(2);
		expect(index.resolve("current-4")).toBeUndefined();
	});
});
