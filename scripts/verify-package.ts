import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
	auditBundledPackageDeclarations,
	auditProductionArtifacts,
	type BundledPackageIdentity,
	bundledPackageKey,
	PRODUCTION_ARTIFACTS,
	readBundledPackages,
} from "./bundle-provenance.js";
import {
	isSafeZipEntryName,
	MAX_ZIP_ARCHIVE_BYTES,
	readZipArchive,
	readZipEntries,
	readZipEntry,
	type ZipEntry,
} from "./zip-archive.js";

interface LicenseArtifact {
	readonly version: string;
	readonly archivePath: string;
}

type SharedLicense = LicenseArtifact;

interface BundledLicense extends LicenseArtifact, BundledPackageIdentity {}

const MAX_UNCOMPRESSED_BYTES = 55 * 1024 * 1024;
const MAX_FILE_COUNT = 6_500;

const PACKAGE_JSON_PATH =
	/^extension\/node_modules\/(?:@[^/]+\/[^/]+|[^/]+)(?:\/node_modules\/(?:@[^/]+\/[^/]+|[^/]+))*\/package\.json$/u;
const PACKAGE_LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-._].*)?$/iu;
const ALLOWED_NATIVE_ASSETS = new Set([
	"extension/node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node",
	"extension/node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-x64/darwin-modifiers.node",
	"extension/node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-arm64/win32-console-mode.node",
	"extension/node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-x64/win32-console-mode.node",
	"extension/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
]);
const SHARED_LICENSES = new Map<string, SharedLicense>([
	[
		"@earendil-works/pi-agent-core",
		{ version: "0.84.3", archivePath: "extension/licenses/pi-MIT.txt" },
	],
	["@earendil-works/pi-ai", { version: "0.84.3", archivePath: "extension/licenses/pi-MIT.txt" }],
	[
		"@earendil-works/pi-client",
		{ version: "0.84.3", archivePath: "extension/licenses/pi-MIT.txt" },
	],
	[
		"@earendil-works/pi-coding-agent",
		{ version: "0.84.3", archivePath: "extension/licenses/pi-MIT.txt" },
	],
	[
		"@earendil-works/pi-protocol",
		{ version: "0.84.3", archivePath: "extension/licenses/pi-MIT.txt" },
	],
	[
		"@earendil-works/pi-telemetry",
		{ version: "0.84.3", archivePath: "extension/licenses/pi-MIT.txt" },
	],
	["@earendil-works/pi-tui", { version: "0.84.3", archivePath: "extension/licenses/pi-MIT.txt" }],
	[
		"@aws-sdk/credential-provider-http",
		{ version: "3.972.72", archivePath: "extension/licenses/aws-sdk-Apache-2.0.txt" },
	],
	[
		"@aws-sdk/credential-provider-login",
		{ version: "3.972.77", archivePath: "extension/licenses/aws-sdk-Apache-2.0.txt" },
	],
	[
		"@aws-sdk/nested-clients",
		{ version: "3.997.44", archivePath: "extension/licenses/aws-sdk-Apache-2.0.txt" },
	],
	[
		"data-uri-to-buffer",
		{ version: "4.0.1", archivePath: "extension/licenses/data-uri-to-buffer-MIT.txt" },
	],
]);

const BUNDLED_LICENSE_DECLARATIONS: readonly BundledLicense[] = [
	{
		name: "@preact/signals",
		version: "2.11.1",
		archivePath: "extension/licenses/preact-signals-MIT.txt",
	},
	{
		name: "@preact/signals-core",
		version: "1.14.4",
		archivePath: "extension/licenses/preact-signals-MIT.txt",
	},
	{
		name: "beautiful-mermaid",
		version: "1.1.3",
		archivePath: "extension/licenses/beautiful-mermaid-MIT.txt",
	},
	{
		name: "dompurify",
		version: "3.4.14",
		archivePath: "extension/licenses/dompurify-Apache-2.0.txt",
	},
	{
		name: "elkjs",
		version: "0.11.1",
		archivePath: "extension/licenses/elkjs-EPL-2.0.md",
	},
	{
		name: "entities",
		version: "7.0.1",
		archivePath: "extension/licenses/entities-BSD-2-Clause.txt",
	},
	{
		name: "entities",
		version: "8.0.0",
		archivePath: "extension/licenses/entities-BSD-2-Clause.txt",
	},
	{
		name: "linkify-it",
		version: "6.1.0",
		archivePath: "extension/licenses/linkify-it-MIT.txt",
	},
	{
		name: "markdown-it",
		version: "15.0.0",
		archivePath: "extension/licenses/markdown-it-MIT.txt",
	},
	{
		name: "mdurl",
		version: "2.1.0",
		archivePath: "extension/licenses/mdurl-MIT.txt",
	},
	{
		name: "preact",
		version: "10.29.8",
		archivePath: "extension/licenses/preact-MIT.txt",
	},
	{
		name: "punycode.js",
		version: "2.3.1",
		archivePath: "extension/licenses/punycode-uc-micro-MIT.txt",
	},
	{
		name: "uc.micro",
		version: "3.0.0",
		archivePath: "extension/licenses/punycode-uc-micro-MIT.txt",
	},
	{
		name: "valibot",
		version: "1.4.2",
		archivePath: "extension/licenses/valibot-MIT.txt",
	},
];
const BUNDLED_LICENSES = new Map(
	BUNDLED_LICENSE_DECLARATIONS.map((license) => [bundledPackageKey(license), license] as const),
);

function packageNameFromRoot(root: string): string {
	return root.slice(root.lastIndexOf("/node_modules/") + "/node_modules/".length);
}

function assertPackageContents(
	path: string,
	archive: Buffer,
	entries: readonly ZipEntry[],
	bundledPackages: readonly BundledPackageIdentity[],
	localArtifacts: ReadonlyMap<string, Buffer>,
): void {
	const failures: string[] = [];
	const names = new Set<string>();
	for (const entry of entries) {
		if (names.has(entry.name)) failures.push(`duplicate entry: ${entry.name}`);
		names.add(entry.name);
		if (!isSafeZipEntryName(entry.name)) {
			failures.push(`unsafe path: ${entry.name}`);
		}
		if ((entry.unixMode & 0o170000) === 0o120000) failures.push(`symbolic link: ${entry.name}`);
	}

	const required = [
		"extension.vsixmanifest",
		"extension/package.json",
		"extension/readme.md",
		"extension/LICENSE.txt",
		"extension/THIRD_PARTY_NOTICES.md",
		"extension/licenses/pi-MIT.txt",
		"extension/licenses/aws-sdk-Apache-2.0.txt",
		"extension/licenses/data-uri-to-buffer-MIT.txt",
		...PRODUCTION_ARTIFACTS.map((artifact) => artifact.archivePath),
		"extension/media/pi-agent.svg",
		"extension/node_modules/@earendil-works/pi-coding-agent/package.json",
		"extension/node_modules/@earendil-works/pi-coding-agent/README.md",
		"extension/node_modules/@earendil-works/pi-coding-agent/docs/index.md",
		"extension/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md",
		"extension/node_modules/@earendil-works/pi-coding-agent/docs/skills.md",
		"extension/node_modules/@earendil-works/pi-coding-agent/examples/README.md",
		"extension/node_modules/@earendil-works/pi-coding-agent/examples/sdk/README.md",
		"extension/node_modules/@earendil-works/pi-coding-agent/examples/extensions/README.md",
		"extension/node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node",
		"extension/node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-x64/darwin-modifiers.node",
		"extension/node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-arm64/win32-console-mode.node",
		"extension/node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-x64/win32-console-mode.node",
		"extension/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.js",
		"extension/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
	];
	for (const name of required) {
		if (!names.has(name)) failures.push(`missing required entry: ${name}`);
	}
	const packagedArtifacts = new Map<string, Buffer>();
	for (const artifact of PRODUCTION_ARTIFACTS) {
		const packagedEntry = entries.find((entry) => entry.name === artifact.archivePath);
		if (packagedEntry) {
			packagedArtifacts.set(artifact.archivePath, readZipEntry(archive, packagedEntry));
		}
	}
	failures.push(...auditProductionArtifacts(localArtifacts, packagedArtifacts));
	for (const license of BUNDLED_LICENSES.values()) {
		if (!names.has(license.archivePath)) {
			failures.push(`missing bundled dependency license: ${license.archivePath}`);
		}
	}

	const forbidden = [
		/^extension\/(?:src|scripts|test|docs|\.github|\.vscode)\//u,
		/^extension\/(?:bun\.lock|biome\.json|tsconfig\.json|\.gitignore|\.vscodeignore)$/u,
		/^extension\/(?:CONTRIBUTING|SECURITY)\.md$/u,
		/^extension\/node_modules\/(?:@vscode\/test-(?:cli|electron)|mocha|serialize-javascript)\//u,
		/^extension\/node_modules\/@mariozechner\/clipboard(?:-[^/]+)?\//u,
		/^extension\/node_modules\/@earendil-works\/pi-coding-agent\/examples\/extensions\/doom-overlay\/doom\/build\//u,
		/(?:^|\/)\.env(?:\.|$)/u,
		/(?:^|\/)(?:auth|credentials?|models)\.json$/iu,
		/(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|p12|pfx))$/iu,
		/\.map$/u,
	];
	for (const entry of entries) {
		if (forbidden.some((pattern) => pattern.test(entry.name))) {
			failures.push(`forbidden entry: ${entry.name}`);
		}
		if (/\.(?:node|wasm)$/u.test(entry.name) && !ALLOWED_NATIVE_ASSETS.has(entry.name)) {
			failures.push(`unreviewed native or WebAssembly asset: ${entry.name}`);
		}
	}

	const packageRoots = entries
		.filter((entry) => PACKAGE_JSON_PATH.test(entry.name))
		.map((entry) => entry.name.slice(0, -"/package.json".length));
	const sharedLicenseEntries = new Set<string>();
	const noticesEntry = entries.find((entry) => entry.name === "extension/THIRD_PARTY_NOTICES.md");
	const notices = noticesEntry ? readZipEntry(archive, noticesEntry).toString("utf8") : "";
	const normalizedNotices = notices.replace(/\s+/gu, " ");
	for (const root of packageRoots) {
		const hasOwnLicense = entries.some((entry) => {
			if (!entry.name.startsWith(`${root}/`)) return false;
			const relative = entry.name.slice(root.length + 1);
			return !relative.includes("/") && PACKAGE_LICENSE_FILE.test(relative);
		});
		if (hasOwnLicense) continue;
		const packageName = packageNameFromRoot(root);
		const sharedLicense = SHARED_LICENSES.get(packageName);
		if (!sharedLicense) {
			failures.push(`package has no license file and is not allowlisted: ${packageName}`);
			continue;
		}
		sharedLicenseEntries.add(sharedLicense.archivePath);
		if (!names.has(sharedLicense.archivePath)) {
			failures.push(`missing shared license for ${packageName}: ${sharedLicense.archivePath}`);
		}
		const manifestEntry = entries.find((entry) => entry.name === `${root}/package.json`);
		let packageVersion: string | undefined;
		if (manifestEntry) {
			try {
				const manifest: unknown = JSON.parse(readZipEntry(archive, manifestEntry).toString("utf8"));
				if (
					typeof manifest === "object" &&
					manifest !== null &&
					"name" in manifest &&
					manifest.name === packageName &&
					"version" in manifest &&
					typeof manifest.version === "string"
				) {
					packageVersion = manifest.version;
				}
			} catch {
				// Report the invalid manifest below without exposing archive contents.
			}
		}
		if (!packageVersion) {
			failures.push(`invalid packaged dependency manifest: ${packageName}`);
		} else if (packageVersion !== sharedLicense.version) {
			failures.push(
				`shared-license version mismatch for ${packageName}: package has ${packageVersion}, declaration has ${sharedLicense.version}`,
			);
		}
		if (!normalizedNotices.includes(`\`${packageName}\` ${sharedLicense.version}`)) {
			failures.push(`third-party notices do not identify ${packageName}@${sharedLicense.version}`);
		}
	}
	for (const sharedLicense of sharedLicenseEntries) {
		if (!names.has(sharedLicense)) failures.push(`missing used shared license: ${sharedLicense}`);
	}

	failures.push(
		...auditBundledPackageDeclarations(
			bundledPackages,
			[...BUNDLED_LICENSES.values()],
			normalizedNotices,
		),
	);

	const readmeEntry = entries.find((entry) => entry.name === "extension/readme.md");
	if (readmeEntry) {
		const readme = readZipEntry(archive, readmeEntry).toString("utf8");
		if (
			/\]\((?:\.\/)?(?:CONTRIBUTING|SECURITY)\.md(?:[#)]|$)/iu.test(readme) ||
			/\]\((?:\.\/)?docs\/ARCHITECTURE\.md(?:[#)]|$)/iu.test(readme)
		) {
			failures.push("packaged README contains a relative link to an excluded maintainer document");
		}
	}

	const secretPatterns = [
		/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
		/\bAKIA[0-9A-Z]{16}\b/u,
		/\bghp_[A-Za-z0-9]{30,}\b/u,
		/\bgithub_pat_[A-Za-z0-9_]{30,}\b/u,
		/\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/u,
	];
	for (const entry of entries) {
		if (
			entry.uncompressedBytes > 20 * 1024 * 1024 ||
			!/^extension\/(?:dist\/|package\.json$|readme\.md$|THIRD_PARTY_NOTICES\.md$|licenses\/|media\/)/u.test(
				entry.name,
			)
		) {
			continue;
		}
		const content = readZipEntry(archive, entry).toString("utf8");
		if (secretPatterns.some((pattern) => pattern.test(content))) {
			failures.push(`secret-like content in first-party package entry: ${entry.name}`);
		}
	}

	const uncompressedBytes = entries.reduce((total, entry) => total + entry.uncompressedBytes, 0);
	if (archive.byteLength > MAX_ZIP_ARCHIVE_BYTES) {
		failures.push(
			`archive size ${archive.byteLength} exceeds the ${MAX_ZIP_ARCHIVE_BYTES}-byte budget`,
		);
	}
	if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
		failures.push(
			`uncompressed size ${uncompressedBytes} exceeds the ${MAX_UNCOMPRESSED_BYTES}-byte budget`,
		);
	}
	if (entries.length > MAX_FILE_COUNT) {
		failures.push(`file count ${entries.length} exceeds the ${MAX_FILE_COUNT}-file budget`);
	}

	if (failures.length > 0) {
		throw new Error(`VSIX verification failed:\n- ${failures.join("\n- ")}`);
	}
	const compressedPayloadBytes = entries.reduce((total, entry) => total + entry.compressedBytes, 0);
	console.log(
		`[package] verified ${basename(path)}: ${entries.length} files, ${packageRoots.length} package roots and ${bundledPackages.length} bundled package identities, ${archive.byteLength} archive bytes, ${uncompressedBytes} unpacked bytes (${compressedPayloadBytes} compressed payload bytes)`,
	);
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
const archive = await readZipArchive(packagePath);
const bundledPackages = await readBundledPackages(rootDirectory);
const localArtifacts = new Map<string, Buffer>();
for (const artifact of PRODUCTION_ARTIFACTS) {
	localArtifacts.set(
		artifact.archivePath,
		await readFile(resolve(rootDirectory, artifact.localPath)),
	);
}
assertPackageContents(
	packagePath,
	archive,
	readZipEntries(archive),
	bundledPackages,
	localArtifacts,
);
