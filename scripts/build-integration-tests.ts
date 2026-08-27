import { resolve } from "node:path";

const rootDirectory = resolve(import.meta.dir, "..");
const result = await Bun.build({
	entrypoints: [resolve(rootDirectory, "test/integration/extension.test.ts")],
	external: ["vscode"],
	format: "esm",
	minify: false,
	outdir: resolve(rootDirectory, "dist/test"),
	sourcemap: "external",
	target: "node",
});

if (!result.success) {
	for (const log of result.logs) {
		console.error(log);
	}
	throw new Error("Extension Host test build failed.");
}

console.log(`[build] extension tests: ${result.outputs.length} file(s)`);
