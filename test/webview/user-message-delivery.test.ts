import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../..");
const bridgeSource = readFileSync(resolve(projectRoot, "src/webview/bridge.ts"), "utf8");
const composerSource = readFileSync(
	resolve(projectRoot, "src/webview/components/Composer.tsx"),
	"utf8",
);
const providerSource = readFileSync(
	resolve(projectRoot, "src/extension/views/chat-view-provider.ts"),
	"utf8",
);
const workspaceSource = readFileSync(
	resolve(projectRoot, "src/extension/views/chat-workspace-model.ts"),
	"utf8",
);

describe("user message delivery", () => {
	test("projects a sent request immediately with the wire request ID", () => {
		expect(bridgeSource).toContain("export function postIntent(intent: WebviewIntent): string");
		expect(bridgeSource).toContain("return requestId;");
		expect(composerSource).toContain("const requestId = postIntent({");
		expect(composerSource).toContain("stageOptimisticUserMessage(chatId, {");
		expect(composerSource).toContain("id: requestId");
		expect(composerSource).toContain('role: "user"');
	});

	test("uses the same ID in the host and records the request before asynchronous context work", () => {
		const sendDispatch = providerSource.slice(
			providerSource.indexOf('case "sendPrompt":'),
			providerSource.indexOf('case "stop":'),
		);
		expect(sendDispatch).toContain("message.requestId");

		const sendMethod = workspaceSource.slice(
			workspaceSource.indexOf("public async send("),
			workspaceSource.indexOf("public async stop("),
		);
		const appendIndex = sendMethod.indexOf("record.messages.push({");
		const emitIndex = sendMethod.indexOf("this.#emit();");
		const contextIndex = sendMethod.indexOf("await this.contextStore.resolveForPrompt(contextIds)");
		const agentIndex = sendMethod.indexOf("await record.controller.send({ text: prompt })");
		expect(sendMethod).toContain("id: messageId");
		expect(appendIndex).toBeGreaterThanOrEqual(0);
		expect(emitIndex).toBeGreaterThan(appendIndex);
		expect(contextIndex).toBeGreaterThan(emitIndex);
		expect(agentIndex).toBeGreaterThan(contextIndex);
	});
});
