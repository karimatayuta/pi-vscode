import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	auditBundledPackageDeclarations,
	auditProductionArtifacts,
	bundledPackageKey,
	readBundledPackages,
} from "../../scripts/bundle-provenance.js";

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value));
}

describe("production bundle provenance", () => {
	test("retains nested versions of the same package and resolves package subpaths", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-vscode-provenance-"));
		try {
			await writeJson(join(root, "dist/extension/extension.js.map"), { sources: [] });
			await writeJson(join(root, "dist/webview/main.js.map"), {
				sources: [
					"../../node_modules/entities/dist/index.js",
					"../../node_modules/markdown-it/node_modules/entities/dist/index.js",
					"../../node_modules/preact/hooks/dist/hooks.js",
				],
			});
			await writeJson(join(root, "node_modules/entities/package.json"), {
				name: "entities",
				version: "7.0.1",
			});
			await writeJson(join(root, "node_modules/markdown-it/node_modules/entities/package.json"), {
				name: "entities",
				version: "8.0.0",
			});
			await writeJson(join(root, "node_modules/preact/package.json"), {
				name: "preact",
				version: "10.29.8",
			});

			const packages = await readBundledPackages(root);
			expect(new Set(packages.map(bundledPackageKey))).toEqual(
				new Set(
					[
						{ name: "entities", version: "7.0.1" },
						{ name: "entities", version: "8.0.0" },
						{ name: "preact", version: "10.29.8" },
					].map(bundledPackageKey),
				),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("reports a nested version that lacks an exact license declaration or notice", () => {
		const packages = [
			{ name: "entities", version: "7.0.1" },
			{ name: "entities", version: "8.0.0" },
		] as const;
		const versionFailures = auditBundledPackageDeclarations(
			packages,
			[{ name: "entities", version: "7.0.1" }],
			"`entities` 7.0.1 and `entities` 8.0.0",
		);
		expect(versionFailures).toContain(
			"bundled dependency version mismatch for entities: source map has 8.0.0, declarations have 7.0.1",
		);

		const noticeFailures = auditBundledPackageDeclarations(
			packages,
			[
				{ name: "entities", version: "7.0.1" },
				{ name: "entities", version: "8.0.0" },
			],
			"`entities` 7.0.1",
		);
		expect(noticeFailures).toContain("third-party notices do not identify bundled entities@8.0.0");
	});

	test("rejects a stale packaged bundle even when its path matches", () => {
		const artifacts = new Map([
			["extension/dist/extension/extension.js", Buffer.from("current extension bundle")],
			["extension/dist/webview/main.js", Buffer.from("current webview bundle")],
			["extension/dist/webview/main.css", Buffer.from("current stylesheet")],
		]);
		const stalePackage = new Map(artifacts);
		stalePackage.set(
			"extension/dist/webview/main.js",
			Buffer.from("stale webview bundle with the same path"),
		);

		expect(auditProductionArtifacts(artifacts, stalePackage)).toEqual([
			"packaged production artifact differs from the local build: extension/dist/webview/main.js",
		]);
		expect(auditProductionArtifacts(artifacts, artifacts)).toEqual([]);
	});
});
