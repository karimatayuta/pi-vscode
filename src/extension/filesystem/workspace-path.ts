import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Lexically checks containment after normalizing both paths. */
export function isPathInside(root: string, target: string): boolean {
	const candidate = relative(resolve(root), resolve(target));
	return (
		candidate === "" ||
		(candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate))
	);
}

/**
 * Resolves symlinks for the nearest existing ancestor, then appends missing segments.
 * This lets callers validate a not-yet-created write target against a canonical root.
 */
export function nearestExistingRealPath(target: string): string | undefined {
	let cursor = resolve(target);
	const suffix: string[] = [];
	while (true) {
		try {
			return resolve(realpathSync(cursor), ...suffix);
		} catch {
			const parent = dirname(cursor);
			if (parent === cursor) return undefined;
			suffix.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
			cursor = parent;
		}
	}
}

/**
 * Checks a path against the workspace roots that are current at authorization
 * time. Both sides are canonicalized through their nearest existing ancestor,
 * so removed roots and symlink escapes fail closed while new write targets are
 * still supported.
 */
export function isPathInsideAnyCanonicalRoot(roots: readonly string[], target: string): boolean {
	const canonicalTarget = nearestExistingRealPath(target);
	if (!canonicalTarget) return false;
	return roots.some((root) => {
		const canonicalRoot = nearestExistingRealPath(root);
		return canonicalRoot !== undefined && isPathInside(canonicalRoot, canonicalTarget);
	});
}
