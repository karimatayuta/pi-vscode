import { describe, expect, test } from "bun:test";
import { createCompactPatch } from "../../src/extension/edits/compact-patch.js";

describe("createCompactPatch", () => {
	test("creates a focused review patch with exact change counts", () => {
		const patch = createCompactPatch(
			"src/auth.ts",
			"one\ntwo\nthree\nfour\nfive\n",
			"one\ntwo\nTHREE\nextra\nfour\nfive\n",
		);
		expect(patch).toMatchObject({ additions: 2, deletions: 1 });
		expect(patch?.patch).toContain("--- a/src/auth.ts");
		expect(patch?.patch).toContain("-three");
		expect(patch?.patch).toContain("+THREE");
	});

	test("does not create a review record for an unchanged file", () => {
		expect(createCompactPatch("a.ts", "same", "same")).toBeUndefined();
	});

	test("counts a newly written file without a phantom deleted line", () => {
		expect(createCompactPatch("new.ts", "", "one\ntwo\n")).toMatchObject({
			additions: 2,
			deletions: 0,
		});
	});

	test("bounds large previews without losing full-file statistics", () => {
		const before = Array.from({ length: 500 }, (_, index) => `old-${index}`).join("\n");
		const after = Array.from({ length: 700 }, (_, index) => `new-${index}`).join("\n");
		const patch = createCompactPatch("big.ts", before, after, 1_024);
		expect(patch).toMatchObject({ additions: 700, deletions: 500 });
		expect(patch?.patch.length).toBeLessThanOrEqual(1_100);
		expect(patch?.patch).toContain("truncated");
	});
});
