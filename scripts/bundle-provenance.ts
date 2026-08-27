import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface BundledPackageIdentity {
	readonly name: string;
	readonly version: string;
}

export interface ProductionArtifact {
	readonly archivePath: string;
	readonly localPath: string;
}

export const PRODUCTION_ARTIFACTS: readonly ProductionArtifact[] = [
	{
		archivePath: "extension/dist/extension/extension.js",
		localPath: "dist/extension/extension.js",
	},
	{
		archivePath: "extension/dist/webview/main.js",
		localPath: "dist/webview/main.js",
	},
	{
		archivePath: "extension/dist/webview/main.css",
		localPath: "dist/webview/main.css",
	},
];

const PRODUCTION_SOURCE_MAPS = [
	"dist/extension/extension.js.map",
	"dist/webview/main.js.map",
] as const;
const NODE_MODULES_MARKER = "node_modules/";

export function bundledPackageKey(packageIdentity: BundledPackageIdentity): string {
	return `${packageIdentity.name}\0${packageIdentity.version}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	return left.every((byte, index) => byte === right[index]);
}

export function auditProductionArtifacts(
	localArtifacts: ReadonlyMap<string, Uint8Array>,
	packagedArtifacts: ReadonlyMap<string, Uint8Array>,
): readonly string[] {
	const failures: string[] = [];
	for (const artifact of PRODUCTION_ARTIFACTS) {
		const localContent = localArtifacts.get(artifact.archivePath);
		if (!localContent) {
			failures.push(`local production artifact is unavailable: ${artifact.localPath}`);
			continue;
		}
		const packagedContent = packagedArtifacts.get(artifact.archivePath);
		if (!packagedContent) {
			failures.push(`missing packaged production artifact: ${artifact.archivePath}`);
			continue;
		}
		if (!bytesEqual(localContent, packagedContent)) {
			failures.push(
				`packaged production artifact differs from the local build: ${artifact.archivePath}`,
			);
		}
	}
	return failures;
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function packageReferenceFromSource(
	source: string,
	sourceMapPath: string,
	rootDirectory: string,
): { readonly name: string; readonly packageRoot: string } | undefined {
	const normalized = source.replaceAll("\\", "/");
	const markerIndex = normalized.lastIndexOf(NODE_MODULES_MARKER);
	if (markerIndex < 0) return undefined;

	const packagePathParts = normalized.slice(markerIndex + NODE_MODULES_MARKER.length).split("/");
	const first = packagePathParts[0];
	if (!first) return undefined;
	const packageNameParts = first.startsWith("@") ? packagePathParts.slice(0, 2) : [first];
	if (
		(first.startsWith("@") && packageNameParts.length !== 2) ||
		packageNameParts.some((part) => !part || part === "." || part === "..")
	) {
		throw new Error(`Production source map contains an invalid package path: ${source}`);
	}

	const name = packageNameParts.join("/");
	const relativePackageRoot = `${normalized.slice(
		0,
		markerIndex + NODE_MODULES_MARKER.length,
	)}${name}`;
	const packageRoot = resolve(dirname(sourceMapPath), ...relativePackageRoot.split("/"));
	const dependencyRoot = resolve(rootDirectory, "node_modules");
	if (!isWithin(dependencyRoot, packageRoot)) {
		throw new Error(`Production source map resolves outside the dependency root: ${source}`);
	}
	return { name, packageRoot };
}

function isSourceMap(value: unknown): value is { readonly sources: readonly string[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		"sources" in value &&
		Array.isArray(value.sources) &&
		value.sources.every((source) => typeof source === "string")
	);
}

export async function readBundledPackages(
	rootDirectory: string,
): Promise<readonly BundledPackageIdentity[]> {
	const packageRoots = new Map<string, string>();
	for (const relativeMapPath of PRODUCTION_SOURCE_MAPS) {
		const sourceMapPath = resolve(rootDirectory, relativeMapPath);
		let sourceMap: unknown;
		try {
			sourceMap = JSON.parse(await readFile(sourceMapPath, "utf8"));
		} catch (error) {
			throw new Error(`Cannot read production source map ${relativeMapPath}.`, { cause: error });
		}
		if (!isSourceMap(sourceMap)) {
			throw new Error(`Production source map ${relativeMapPath} has an invalid sources list.`);
		}
		for (const source of sourceMap.sources) {
			const reference = packageReferenceFromSource(source, sourceMapPath, rootDirectory);
			if (!reference) continue;
			const existingName = packageRoots.get(reference.packageRoot);
			if (existingName && existingName !== reference.name) {
				throw new Error(
					`Production source map has conflicting packages at ${reference.packageRoot}.`,
				);
			}
			packageRoots.set(reference.packageRoot, reference.name);
		}
	}

	const identities = new Map<string, BundledPackageIdentity>();
	for (const [packageRoot, expectedName] of [...packageRoots].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		let manifest: unknown;
		try {
			manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
		} catch (error) {
			throw new Error(`Cannot read bundled dependency manifest for ${expectedName}.`, {
				cause: error,
			});
		}
		if (
			typeof manifest !== "object" ||
			manifest === null ||
			!("name" in manifest) ||
			manifest.name !== expectedName ||
			!("version" in manifest) ||
			typeof manifest.version !== "string" ||
			manifest.version.length === 0
		) {
			throw new Error(`Bundled dependency manifest is invalid for ${expectedName}.`);
		}
		const identity = { name: expectedName, version: manifest.version };
		identities.set(bundledPackageKey(identity), identity);
	}

	return [...identities.values()].sort(
		(left, right) =>
			left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
	);
}

export function auditBundledPackageDeclarations(
	packages: readonly BundledPackageIdentity[],
	declarations: readonly BundledPackageIdentity[],
	notices: string,
): readonly string[] {
	const failures: string[] = [];
	const declarationsByIdentity = new Map<string, BundledPackageIdentity>();
	const declarationVersionsByName = new Map<string, string[]>();
	for (const declaration of declarations) {
		const key = bundledPackageKey(declaration);
		if (declarationsByIdentity.has(key)) {
			failures.push(
				`duplicate bundled dependency declaration: ${declaration.name}@${declaration.version}`,
			);
		}
		declarationsByIdentity.set(key, declaration);
		const versions = declarationVersionsByName.get(declaration.name) ?? [];
		versions.push(declaration.version);
		declarationVersionsByName.set(declaration.name, versions);
	}

	const packageIdentities = new Set<string>();
	for (const packageIdentity of packages) {
		const key = bundledPackageKey(packageIdentity);
		packageIdentities.add(key);
		if (!declarationsByIdentity.has(key)) {
			const declaredVersions = declarationVersionsByName.get(packageIdentity.name);
			failures.push(
				declaredVersions
					? `bundled dependency version mismatch for ${packageIdentity.name}: source map has ${packageIdentity.version}, declarations have ${declaredVersions.join(", ")}`
					: `bundled dependency has no license declaration: ${packageIdentity.name}@${packageIdentity.version}`,
			);
		}
		if (!notices.includes(`\`${packageIdentity.name}\` ${packageIdentity.version}`)) {
			failures.push(
				`third-party notices do not identify bundled ${packageIdentity.name}@${packageIdentity.version}`,
			);
		}
	}
	for (const declaration of declarations) {
		if (!packageIdentities.has(bundledPackageKey(declaration))) {
			failures.push(
				`declared bundled dependency is absent from production source maps: ${declaration.name}@${declaration.version}`,
			);
		}
	}
	return failures;
}
