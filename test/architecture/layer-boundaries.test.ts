import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const extensionRoot = resolve(import.meta.dir, "../../src/extension");
const sharedRoot = resolve(import.meta.dir, "../../src/shared");
const webviewRoot = resolve(import.meta.dir, "../../src/webview");

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.(?:ts|tsx)$/u.test(entry.name) ? [path] : [];
	});
}

function importsLayer(path: string, layer: "extension" | "webview"): boolean {
	const source = readFileSync(path, "utf8");
	return new RegExp(`(?:from|import)\\s*\\(?\\s*["'][^"']*${layer}/`, "u").test(source);
}

describe("source layer boundaries", () => {
	test("keeps the Extension Host independent from Webview implementation modules", () => {
		const violations = sourceFiles(extensionRoot).flatMap((path) => {
			return importsLayer(path, "webview") ? [relative(extensionRoot, path)] : [];
		});
		expect(violations).toEqual([]);
	});

	test("keeps shared contracts independent and the Webview separate from the Extension Host", () => {
		const sharedViolations = sourceFiles(sharedRoot).filter(
			(path) => importsLayer(path, "extension") || importsLayer(path, "webview"),
		);
		const webviewViolations = sourceFiles(webviewRoot).filter((path) =>
			importsLayer(path, "extension"),
		);
		expect(sharedViolations.map((path) => relative(sharedRoot, path))).toEqual([]);
		expect(webviewViolations.map((path) => relative(webviewRoot, path))).toEqual([]);
	});
});
