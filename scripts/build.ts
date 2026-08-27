import { rm, watch } from "node:fs/promises";
import { relative, resolve } from "node:path";

const rootDirectory = resolve(import.meta.dir, "..");
const sourceDirectory = resolve(rootDirectory, "src");
const outputDirectory = resolve(rootDirectory, "dist");
const extensionOutputDirectory = resolve(outputDirectory, "extension");
const webviewOutputDirectory = resolve(outputDirectory, "webview");

if (relative(rootDirectory, outputDirectory) !== "dist") {
	throw new Error("Refusing to clean an unexpected build output directory.");
}

const argumentsSet = new Set(Bun.argv.slice(2));
const production = argumentsSet.has("--production");
const watchMode = argumentsSet.has("--watch");

const piPackages = ["@earendil-works/*"];

async function runBundle(label: string, options: Parameters<typeof Bun.build>[0]): Promise<void> {
	const result = await Bun.build(options);
	if (!result.success) {
		for (const log of result.logs) {
			console.error(log);
		}
		throw new Error(`${label} build failed.`);
	}

	const totalBytes = result.outputs.reduce((sum, output) => sum + output.size, 0);
	console.log(`[build] ${label}: ${result.outputs.length} file(s), ${totalBytes} bytes`);
}

async function build(): Promise<void> {
	const startedAt = performance.now();
	await rm(outputDirectory, { force: true, recursive: true });

	await Promise.all([
		runBundle("extension", {
			entrypoints: [resolve(sourceDirectory, "extension/extension.ts")],
			outdir: extensionOutputDirectory,
			target: "node",
			format: "esm",
			splitting: false,
			external: ["vscode", ...piPackages],
			minify: production,
			sourcemap: "external",
			define: {
				"process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
			},
		}),
		runBundle("webview", {
			entrypoints: [resolve(sourceDirectory, "webview/main.tsx")],
			outdir: webviewOutputDirectory,
			target: "browser",
			format: "esm",
			splitting: false,
			minify: production,
			sourcemap: "external",
			define: {
				"process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
			},
		}),
	]);

	console.log(`[build] complete in ${Math.round(performance.now() - startedAt)} ms`);
}

await build();

if (watchMode) {
	console.log("[build] watching src/ for changes");
	const abortController = new AbortController();
	process.once("SIGINT", () => abortController.abort());
	process.once("SIGTERM", () => abortController.abort());

	let queuedBuild = Promise.resolve();
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		for await (const _event of watch(sourceDirectory, {
			recursive: true,
			signal: abortController.signal,
		})) {
			clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				queuedBuild = queuedBuild.then(build).catch((error: unknown) => {
					console.error(error);
				});
			}, 75);
		}
	} catch (error) {
		if (!(error instanceof DOMException && error.name === "AbortError")) {
			throw error;
		}
	}
	await queuedBuild;
}
