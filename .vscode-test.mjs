import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@vscode/test-cli";

const isolatedAgentDirectory = fileURLToPath(
	new URL(`./.vscode-test/pi-agent-home-${randomUUID()}`, import.meta.url),
);

export default defineConfig({
	env: {
		PI_CODING_AGENT_DIR: isolatedAgentDirectory,
	},
	extensionDevelopmentPath: process.env.PI_AGENT_TEST_EXTENSION_PATH ?? import.meta.dirname,
	files: "dist/test/**/*.test.js",
	label: "activation",
	launchArgs: ["--disable-extensions", "--disable-gpu", "--skip-release-notes", "--skip-welcome"],
	mocha: {
		timeout: 60_000,
		ui: "tdd",
	},
	version: process.env.PI_AGENT_TEST_VSCODE_VERSION ?? "1.106.3",
	workspaceFolder: fileURLToPath(new URL("./test/fixtures/workspace", import.meta.url)),
});
