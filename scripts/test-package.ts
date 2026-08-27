import { access, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { extractZipArchive, readZipArchive, readZipEntries } from "./zip-archive.js";

interface PiResourcePaths {
	getReadmePath(): string;
	getDocsPath(): string;
	getExamplesPath(): string;
}

const rootDirectory = resolve(import.meta.dir, "..");
const manifest = (await Bun.file(resolve(rootDirectory, "package.json")).json()) as {
	readonly name: string;
	readonly version: string;
};
const packagePath = resolve(
	rootDirectory,
	Bun.argv[2] ?? `${manifest.name}-${manifest.version}.vsix`,
);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-agent-package-test-"));

async function run(command: readonly string[], environment = process.env): Promise<void> {
	const child = Bun.spawn([...command], {
		cwd: rootDirectory,
		env: environment,
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) {
		throw new Error(`${command.join(" ")} failed with exit code ${exitCode}.`);
	}
}

function isPiResourcePaths(value: unknown): value is PiResourcePaths {
	return (
		typeof value === "object" &&
		value !== null &&
		"getReadmePath" in value &&
		typeof value.getReadmePath === "function" &&
		"getDocsPath" in value &&
		typeof value.getDocsPath === "function" &&
		"getExamplesPath" in value &&
		typeof value.getExamplesPath === "function"
	);
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

try {
	await access(packagePath);
	const archive = await readZipArchive(packagePath);
	await extractZipArchive(archive, readZipEntries(archive), temporaryDirectory);

	const extensionPath = resolve(temporaryDirectory, "extension");
	const piPackagePath = resolve(extensionPath, "node_modules/@earendil-works/pi-coding-agent");
	const piPackageRealPath = await realpath(piPackagePath);
	const sdkPath = resolve(piPackagePath, "dist/index.js");
	await import(`${pathToFileURL(sdkPath).href}?package-test=${Date.now()}`);

	const configPath = resolve(piPackagePath, "dist/config.js");
	const config: unknown = await import(
		`${pathToFileURL(configPath).href}?package-test=${Date.now()}`
	);
	if (!isPiResourcePaths(config)) {
		throw new Error("The packaged Pi configuration module does not expose its resource paths.");
	}
	for (const [label, resourcePath, expectedKind] of [
		["README", config.getReadmePath(), "file"],
		["docs", config.getDocsPath(), "directory"],
		["examples", config.getExamplesPath(), "directory"],
	] as const) {
		const resourceRealPath = await realpath(resourcePath);
		if (!isWithin(piPackageRealPath, resourceRealPath)) {
			throw new Error(`Packaged Pi ${label} resolves outside its package root.`);
		}
		const resourceStat = await stat(resourceRealPath);
		if (
			(expectedKind === "file" && !resourceStat.isFile()) ||
			(expectedKind === "directory" && !resourceStat.isDirectory())
		) {
			throw new Error(`Packaged Pi ${label} is not a ${expectedKind}.`);
		}
	}
	console.log("[package] Pi SDK import and documentation resource paths passed");

	await run(["bun", "run", "build:test"]);
	await run([resolve(rootDirectory, "node_modules/.bin/vscode-test"), "--fail-zero"], {
		...process.env,
		PI_AGENT_TEST_EXTENSION_PATH: extensionPath,
	});
	console.log("[package] unpacked VSIX passed Extension Host tests");
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
