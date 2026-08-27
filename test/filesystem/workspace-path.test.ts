import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	isPathInside,
	isPathInsideAnyCanonicalRoot,
	nearestExistingRealPath,
} from "../../src/extension/filesystem/workspace-path.js";

describe("canonical workspace path boundaries", () => {
	test("accepts a root and descendants without accepting prefix siblings or traversal", () => {
		const root = resolve("/workspace/project");
		expect(isPathInside(root, root)).toBeTrue();
		expect(isPathInside(root, join(root, "src", "index.ts"))).toBeTrue();
		expect(isPathInside(root, resolve(root, "..", "project-secret", "key.txt"))).toBeFalse();
		expect(isPathInside(root, resolve(root, "..", "outside.txt"))).toBeFalse();
	});

	test("uses only current roots for targetless command authorization", () => {
		const currentRoot = realpathSync(import.meta.dir);
		expect(
			isPathInsideAnyCanonicalRoot([currentRoot], join(currentRoot, "future", "file.ts")),
		).toBe(true);
		expect(isPathInsideAnyCanonicalRoot([], currentRoot)).toBeFalse();
		expect(
			isPathInsideAnyCanonicalRoot([join(currentRoot, "different-root")], currentRoot),
		).toBeFalse();
	});

	test("canonicalizes the nearest existing ancestor of a future write target", () => {
		const expected = join(realpathSync(import.meta.dir), "not-created", "future.ts");
		expect(nearestExistingRealPath(join(import.meta.dir, "not-created", "future.ts"))).toBe(
			expected,
		);
	});
});
