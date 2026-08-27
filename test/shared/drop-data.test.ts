import { describe, expect, test } from "bun:test";
import {
	classifyContextResourceDrag,
	DROP_MIME_TYPES,
	hasContextResourceDropType,
	parseDroppedUris,
	readDroppedUris,
} from "../../src/shared/drop-data.js";

describe("drop data normalization", () => {
	test("distinguishes resource drags from ordinary selected text", () => {
		expect(hasContextResourceDropType(["text/plain"])).toBe(false);
		expect(hasContextResourceDropType(["TEXT/PLAIN", "FILES"])).toBe(true);
		expect(hasContextResourceDropType(["application/vnd.code.uri-list"])).toBe(true);
	});

	test("classifies incomplete resource metadata without mistaking selected text", () => {
		expect(classifyContextResourceDrag(["text/plain", "text/html"])).toBe("text");
		expect(classifyContextResourceDrag([], [{ kind: "string", type: "text/plain" }])).toBe("text");
		expect(classifyContextResourceDrag([], [{ kind: "file", type: "" }])).toBe("resource");
		expect(classifyContextResourceDrag([], [{ kind: "string", type: "CodeFiles" }])).toBe(
			"resource",
		);
		expect(classifyContextResourceDrag([], [])).toBe("unknown");
		expect(classifyContextResourceDrag(["application/vnd.code.uri-list"])).toBe("resource");
	});

	test("parses URI lists, ignores comments, strips locations, and deduplicates", () => {
		expect(
			parseDroppedUris({
				"text/uri-list":
					"# Explorer selection\r\nfile:///workspace/src/a.ts#L3,5\r\nfile:///workspace/src/b.ts\nfile:///workspace/src/a.ts",
			}),
		).toEqual(["file:///workspace/src/a.ts", "file:///workspace/src/b.ts"]);
	});

	test("supports VS Code internal URI and resource-list transfer formats", () => {
		expect(
			parseDroppedUris({
				"APPLICATION/VND.CODE.URI-LIST": "file:///workspace/a.ts\nfile:///workspace/folder",
				ResourceURLs: JSON.stringify([
					"file:///workspace/b.ts?unused=1#L2",
					"https://example.com/not-context",
				]),
			}),
		).toEqual(["file:///workspace/a.ts", "file:///workspace/folder", "file:///workspace/b.ts"]);
	});

	test("converts CodeFiles absolute POSIX, Windows, and UNC paths", () => {
		expect(
			parseDroppedUris({
				CodeFiles: JSON.stringify([
					"/workspace/a file.ts",
					"C:\\repo\\src\\a#b.ts",
					"\\\\server\\share\\folder name",
				]),
			}),
		).toEqual([
			"file:///workspace/a%20file.ts",
			"file:///C:/repo/src/a%23b.ts",
			"file://server/share/folder%20name",
		]);
	});

	test("uses plain text only for absolute paths or local file URIs", () => {
		expect(
			parseDroppedUris({
				"text/plain":
					"README.md\nPlease open /workspace/not-a-standalone-path\n/workspace/real.ts\nfile:///workspace/also.ts\nhttps://example.com",
			}),
		).toEqual(["file:///workspace/real.ts", "file:///workspace/also.ts"]);
	});

	test("ignores malformed, non-local, control-character, and oversized entries", () => {
		expect(
			parseDroppedUris({
				ResourceURLs: "not-json",
				CodeFiles: JSON.stringify(["relative/file.ts", "https://example.com", "/bad\u0000name"]),
				"text/uri-list": `untitled:note\nfile:///workspace/${"x".repeat(8_193)}`,
			}),
		).toEqual([]);
	});

	test("reads every supported textual MIME immediately", () => {
		const values = new Map<string, string>([
			[DROP_MIME_TYPES.uriList, "file:///workspace/a.ts"],
			[DROP_MIME_TYPES.codeFiles, JSON.stringify(["/workspace/b.ts"])],
		]);
		expect(readDroppedUris({ getData: (mime) => values.get(mime) ?? "" })).toEqual([
			"file:///workspace/a.ts",
			"file:///workspace/b.ts",
		]);
	});

	test("uses native file paths when Electron exposes them", () => {
		expect(
			readDroppedUris({
				getData: () => "",
				files: [{ path: "/workspace/a.ts" }, { path: "/workspace/folder" }],
			}),
		).toEqual(["file:///workspace/a.ts", "file:///workspace/folder"]);
	});
});
