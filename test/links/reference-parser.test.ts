import { describe, expect, test } from "bun:test";
import { parseMessageReferences } from "../../src/extension/links/reference-parser.js";

describe("parseMessageReferences", () => {
	test("extracts safe HTTP URLs and workspace paths with positions", () => {
		const result = parseMessageReferences(
			"See https://pi.dev/docs. Open src/auth.ts:40:12 or packages/ui/App.tsx:8-12.",
		);
		expect(result).toContainEqual({
			label: "https://pi.dev/docs",
			target: { kind: "external", href: "https://pi.dev/docs" },
		});
		expect(result).toContainEqual({
			label: "src/auth.ts:40:12",
			target: { kind: "workspace", relativePath: "src/auth.ts", line: 40, column: 12 },
		});
		expect(result).toContainEqual({
			label: "packages/ui/App.tsx:8-12",
			target: { kind: "workspace", relativePath: "packages/ui/App.tsx", line: 8, endLine: 12 },
		});
	});

	test("ends bare file paths before adjacent Japanese prose and ignores tool-name phrases", () => {
		const result = parseMessageReferences(
			"src/extension/links/reference-parser.tsを修正します。find や ls の結果と edit/write前後の内容から判断します。",
		);

		expect(result).toEqual([
			{
				label: "src/extension/links/reference-parser.ts",
				target: {
					kind: "workspace",
					relativePath: "src/extension/links/reference-parser.ts",
				},
			},
		]);
	});

	test("supports deliberate Markdown file links without creating partial path references", () => {
		const result = parseMessageReferences(
			"[space](<packages/my app/src/file.ts>) [line](src/My%20File.ts:12:3-14:5) [folder](docs/guides)",
		);

		expect(result).toEqual([
			{
				label: "packages/my app/src/file.ts",
				target: { kind: "workspace", relativePath: "packages/my app/src/file.ts" },
			},
			{
				label: "src/My File.ts:12:3-14:5",
				target: {
					kind: "workspace",
					relativePath: "src/My File.ts",
					line: 12,
					column: 3,
					endLine: 14,
					endColumn: 5,
				},
			},
			{
				label: "docs/guides",
				target: { kind: "workspace", relativePath: "docs/guides" },
			},
		]);
	});

	test("keeps balanced parentheses in explicit external link destinations", () => {
		const result = parseMessageReferences(
			"[Reference](https://en.wikipedia.org/wiki/Function_(computer_programming))",
		);

		expect(result).toEqual([
			{
				label: "https://en.wikipedia.org/wiki/Function_(computer_programming)",
				target: {
					kind: "external",
					href: "https://en.wikipedia.org/wiki/Function_(computer_programming)",
				},
			},
		]);
	});

	test("keeps balanced parentheses in bare URLs and stops before adjacent Japanese prose", () => {
		const result = parseMessageReferences(
			"See https://en.wikipedia.org/wiki/Function_(computer_programming). https://example.com/docsを参照します。",
		);

		expect(result).toEqual([
			{
				label: "https://en.wikipedia.org/wiki/Function_(computer_programming)",
				target: {
					kind: "external",
					href: "https://en.wikipedia.org/wiki/Function_(computer_programming)",
				},
			},
			{
				label: "https://example.com/docs",
				target: { kind: "external", href: "https://example.com/docs" },
			},
		]);
	});

	test("drops unmatched punctuation around a bare URL without breaking IPv6 brackets", () => {
		expect(parseMessageReferences("[https://example.com/docs] http://[::1]/status")).toEqual([
			{
				label: "https://example.com/docs",
				target: { kind: "external", href: "https://example.com/docs" },
			},
			{
				label: "http://[::1]/status",
				target: { kind: "external", href: "http://[::1]/status" },
			},
		]);
	});

	test("recognizes root files and GitHub-style line fragments", () => {
		expect(parseMessageReferences("Open README.md and src/auth.ts#L12-L14.")).toEqual([
			{
				label: "README.md",
				target: { kind: "workspace", relativePath: "README.md" },
			},
			{
				label: "src/auth.ts#L12-L14",
				target: { kind: "workspace", relativePath: "src/auth.ts", line: 12, endLine: 14 },
			},
		]);
	});

	test("does not mistake ordinary version and technology prose for root files", () => {
		expect(
			parseMessageReferences("Use Node.js and TypeScript 7.0+. Version 2.0 is ready, e.g. today."),
		).toEqual([]);
	});

	test("does not auto-link code fences or inline code", () => {
		const result = parseMessageReferences(
			"`src/inline.ts:2`\n```ts\nopen('src/fenced.ts:3')\n```\nUse src/real.ts:4",
		);
		expect(result.map((entry) => entry.label)).toEqual(["src/real.ts:4"]);
	});

	test("rejects unsafe and credential-bearing values", () => {
		const result = parseMessageReferences(
			"https://good@example.com/x ../../etc/passwd file:///etc/passwd javascript:alert(1) [escape](src/%2e%2e/secret.ts) [absolute](/etc/passwd)",
		);
		expect(result).toHaveLength(0);
	});
});
