import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInside } from "../filesystem/workspace-path.js";
import type { PackageReadResources } from "./tool-authorization.js";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** Resolves only the documentation shipped with the installed, pinned Pi package. */
export async function resolvePiPackageReadResources(): Promise<PackageReadResources> {
	const entryPath = fileURLToPath(import.meta.resolve(PI_PACKAGE_NAME));
	const packageRoot = await realpath(resolve(dirname(entryPath), ".."));
	const [readme, docs, examples] = await Promise.all([
		realpath(join(packageRoot, "README.md")),
		realpath(join(packageRoot, "docs")),
		realpath(join(packageRoot, "examples")),
	]);
	if (![readme, docs, examples].every((resource) => isPathInside(packageRoot, resource))) {
		throw new Error("The installed Pi documentation resolves outside its package root.");
	}
	return { files: [readme], directories: [docs, examples] };
}
