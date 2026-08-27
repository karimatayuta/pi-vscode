import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, normalize, relative, resolve, sep } from "node:path";
import MarkdownIt, { type Token } from "markdown-it";

const repositoryRoot = resolve(import.meta.dir, "../..");
const documents = [
	"README.md",
	"CONTRIBUTING.md",
	"SECURITY.md",
	"THIRD_PARTY_NOTICES.md",
	"CHANGELOG.md",
	"docs/ARCHITECTURE.md",
] as const;

function linkedTargets(tokens: readonly Token[]): string[] {
	const targets: string[] = [];
	for (const token of tokens) {
		if (token.type === "link_open") {
			const href = token.attrGet("href");
			if (typeof href === "string" && href) targets.push(href);
		}
		if (token.type === "image") {
			const source = token.attrGet("src");
			if (typeof source === "string" && source) targets.push(source);
		}
		if (token.children) targets.push(...linkedTargets(token.children));
	}
	return targets;
}

function localPath(target: string): string | undefined {
	if (
		target.startsWith("#") ||
		target.startsWith("//") ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)
	) {
		return undefined;
	}
	const path = target.split(/[?#]/u, 1)[0];
	if (!path) return undefined;
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

async function exactCaseExists(absolutePath: string): Promise<boolean> {
	const repositoryRelative = relative(repositoryRoot, absolutePath);
	if (
		repositoryRelative === "" ||
		repositoryRelative === ".." ||
		repositoryRelative.startsWith(`..${sep}`)
	) {
		return repositoryRelative === "";
	}
	let current = repositoryRoot;
	for (const segment of repositoryRelative.split(sep)) {
		const entries = await readdir(current);
		if (!entries.includes(segment)) return false;
		current = resolve(current, segment);
	}
	return true;
}

describe("maintainer documentation", () => {
	test("keeps every relative Markdown link present with exact filename casing", async () => {
		const markdown = new MarkdownIt({ html: false, linkify: false });
		const missing: string[] = [];
		for (const document of documents) {
			const source = await readFile(resolve(repositoryRoot, document), "utf8");
			for (const target of linkedTargets(markdown.parse(source, {}))) {
				const path = localPath(target);
				if (!path) continue;
				const resolved = resolve(repositoryRoot, dirname(document), normalize(path));
				if (!(await exactCaseExists(resolved))) missing.push(`${document} -> ${target}`);
			}
		}
		expect(missing).toEqual([]);
	});
});
