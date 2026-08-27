import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_CONTEXT_RESOLUTION_BYTES } from "../../src/shared/prompt-budget.js";

const projectRoot = resolve(import.meta.dir, "../..");
const htmlSource = readFileSync(
	resolve(projectRoot, "src/extension/views/webview-html.ts"),
	"utf8",
);
const providerSource = readFileSync(
	resolve(projectRoot, "src/extension/views/chat-view-provider.ts"),
	"utf8",
);
const manifest = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as {
	readonly capabilities?: {
		readonly untrustedWorkspaces?: { readonly supported?: unknown };
		readonly virtualWorkspaces?: { readonly supported?: unknown };
	};
};

describe("Webview security contract", () => {
	test("keeps resources local and disables privileged Webview features", () => {
		expect(providerSource).toContain("enableCommandUris: false");
		expect(providerSource).toContain("enableForms: false");
		expect(providerSource).toMatch(
			/localResourceRoots:\s*\[\s*vscode\.Uri\.joinPath\(this\.extensionContext\.extensionUri, "dist", "webview"\),\s*\]/u,
		);
	});

	test("retains a deny-by-default CSP with nonce-only scripts", () => {
		for (const directive of [
			"default-src 'none'",
			"connect-src 'none'",
			"media-src 'none'",
			"frame-src 'none'",
			"object-src 'none'",
			"base-uri 'none'",
			"form-action 'none'",
		]) {
			expect(htmlSource).toContain(directive);
		}
		expect(htmlSource).toMatch(/script-src 'nonce-\$\{scriptNonce\}'/u);
		expect(htmlSource).toMatch(/<script type="module" nonce="\$\{scriptNonce\}"/u);
		expect(htmlSource.match(/<script/gu)).toHaveLength(1);
		expect(htmlSource).not.toContain("__PI_WEBVIEW_EPOCH__");
		expect(htmlSource).toMatch(/img-src \$\{webview\.cspSource\} data:/u);
		expect(htmlSource).not.toMatch(/(?:connect|img|script)-src[^\n]*https?:/u);
	});
});

describe("Workspace Trust manifest contract", () => {
	test("advertises limited Restricted Mode and rejects virtual workspaces", () => {
		expect(manifest.capabilities?.untrustedWorkspaces?.supported).toBe("limited");
		expect(manifest.capabilities?.virtualWorkspaces?.supported).toBe(false);
	});
});

describe("context prompt budget manifest contract", () => {
	test("does not advertise a configurable total above the enforced safety cap", async () => {
		const manifest = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
			readonly contributes: {
				readonly configuration: readonly {
					readonly properties?: Readonly<
						Record<string, { readonly maximum?: number; readonly description?: string }>
					>;
				}[];
			};
		};
		const setting = manifest.contributes.configuration
			.flatMap((group) => Object.entries(group.properties ?? {}))
			.find(([key]) => key === "piAgent.context.maxTotalBytes")?.[1];
		expect(setting?.maximum).toBe(MAX_CONTEXT_RESOLUTION_BYTES);
		expect(setting?.description).toContain("8 MiB");
	});
});
