import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { ToolAuthorizationRouter } from "../../src/extension/permissions/tool-authorization-router.js";
import { capabilityForToolRequest } from "../../src/extension/permissions/tool-capability.js";
import {
	classifyToolCall,
	createToolAuthorizationExtension,
	moveAuthorizationGateLast,
} from "../../src/extension/pi/tool-authorization.js";
import type { ApprovalMode } from "../../src/shared/approval.js";

const cwd = resolve(import.meta.dir, "../fixtures/workspace");

function toolCall(toolName: string, input: Record<string, unknown>): ToolCallEvent {
	return { type: "tool_call", toolCallId: "call-1", toolName, input } as ToolCallEvent;
}

async function gateHandler(options: Parameters<typeof createToolAuthorizationExtension>[0]) {
	let handler: ((event: ToolCallEvent) => Promise<ToolCallEventResult | undefined>) | undefined;
	const extension = createToolAuthorizationExtension(options);
	const factory = typeof extension === "function" ? extension : extension.factory;
	await factory({
		on(
			event: string,
			candidate: (value: ToolCallEvent) => Promise<ToolCallEventResult | undefined>,
		) {
			if (event === "tool_call") {
				handler = candidate;
			}
		},
	} as unknown as ExtensionAPI);
	if (!handler) {
		throw new Error("permission gate did not register");
	}
	return handler;
}

describe("Pi tool authorization gate", () => {
	test("allows ordinary reads inside cwd without prompting", async () => {
		const classified = await classifyToolCall(toolCall("read", { path: "src/index.ts" }), {
			sessionId: "session-1",
			cwd,
		});
		expect(classified.requiresAuthorization).toBe(false);
		expect(classified.request).toMatchObject({ capability: "read", risk: "safe" });
		expect(classified.request.target?.endsWith("/test/fixtures/workspace/src/index.ts")).toBe(true);
	});

	test("requires authorization for outside and secret reads", async () => {
		const outside = await classifyToolCall(toolCall("read", { path: "../outside.txt" }), {
			sessionId: "session-1",
			cwd,
		});
		const secret = await classifyToolCall(toolCall("read", { path: ".env.production" }), {
			sessionId: "session-1",
			cwd,
		});
		expect(outside).toMatchObject({ requiresAuthorization: true, request: { risk: "dangerous" } });
		expect(secret).toMatchObject({ requiresAuthorization: true, request: { risk: "sensitive" } });
	});

	test("allows only canonical package documentation through the outside-workspace boundary", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "pi-vscode-package-read-"));
		const workspace = join(fixture, "workspace");
		const packageRoot = join(fixture, "pi-coding-agent");
		const docs = join(packageRoot, "docs");
		const examples = join(packageRoot, "examples");
		const docsSibling = join(packageRoot, "docs-private");
		const readme = join(packageRoot, "README.md");
		const outsideSecret = join(fixture, "outside-secret.txt");
		try {
			await Promise.all([
				mkdir(workspace, { recursive: true }),
				mkdir(docs, { recursive: true }),
				mkdir(examples, { recursive: true }),
				mkdir(docsSibling, { recursive: true }),
			]);
			await Promise.all([
				writeFile(readme, "readme"),
				writeFile(join(docs, "models.md"), "models"),
				writeFile(join(examples, "extension.ts"), "example"),
				writeFile(join(docsSibling, "private.md"), "private"),
				writeFile(outsideSecret, "secret"),
			]);
			await symlink(outsideSecret, join(docs, "escaped.md"));
			const packageReadResources = {
				files: [await realpath(readme)],
				directories: [await realpath(docs), await realpath(examples)],
			};
			const classify = (toolName: string, path: string) =>
				classifyToolCall(toolCall(toolName, { path }), {
					sessionId: "session-1",
					cwd: workspace,
					packageReadResources,
				});

			await expect(classify("read", readme)).resolves.toMatchObject({
				requiresAuthorization: false,
				request: { risk: "safe" },
			});
			await expect(classify("read", join(docs, "models.md"))).resolves.toMatchObject({
				requiresAuthorization: false,
				request: { risk: "safe" },
			});
			await expect(classify("read", join(examples, "extension.ts"))).resolves.toMatchObject({
				requiresAuthorization: false,
				request: { risk: "safe" },
			});
			for (const rejectedPath of [
				join(docs, "..", "docs-private", "private.md"),
				join(docs, "escaped.md"),
				join(docsSibling, "private.md"),
			]) {
				await expect(classify("read", rejectedPath)).resolves.toMatchObject({
					requiresAuthorization: true,
					request: { risk: "dangerous" },
				});
			}
			await expect(classify("edit", join(docs, "models.md"))).resolves.toMatchObject({
				requiresAuthorization: true,
				request: { risk: "dangerous" },
			});
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});

	test("treats every current canonical workspace root as normal tool scope", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "pi-vscode-multi-root-auth-"));
		const firstRoot = join(fixture, "first");
		const secondRoot = join(fixture, "second");
		const prefixSibling = join(fixture, "second-private");
		const outside = join(fixture, "outside");
		const secondFile = join(secondRoot, "src", "index.ts");
		const secondSecret = join(secondRoot, ".env");
		const outsideFile = join(outside, "outside.ts");
		try {
			await Promise.all([
				mkdir(firstRoot, { recursive: true }),
				mkdir(join(secondRoot, "src"), { recursive: true }),
				mkdir(prefixSibling, { recursive: true }),
				mkdir(outside, { recursive: true }),
			]);
			await Promise.all([
				writeFile(secondFile, "export const value = 1;"),
				writeFile(secondSecret, "TOKEN=secret"),
				writeFile(join(prefixSibling, "private.ts"), "private"),
				writeFile(outsideFile, "outside"),
			]);
			await symlink(outsideFile, join(secondRoot, "escaped.ts"));
			const roots = [firstRoot, secondRoot];
			const classify = (toolName: string, path: string) =>
				classifyToolCall(toolCall(toolName, { path }), {
					sessionId: "session-1",
					cwd: firstRoot,
					workspaceRoots: roots,
				});

			for (const toolName of ["read", "ls", "find"]) {
				await expect(classify(toolName, secondRoot)).resolves.toMatchObject({
					requiresAuthorization: false,
					request: { risk: "safe" },
				});
			}
			for (const toolName of ["edit", "write"]) {
				await expect(classify(toolName, secondFile)).resolves.toMatchObject({
					requiresAuthorization: true,
					request: { capability: "mutate", risk: "safe" },
				});
			}
			await expect(classify("read", secondSecret)).resolves.toMatchObject({
				requiresAuthorization: true,
				request: { risk: "sensitive" },
			});
			for (const rejectedPath of [
				join(secondRoot, "escaped.ts"),
				outsideFile,
				join(prefixSibling, "private.ts"),
			]) {
				await expect(classify("read", rejectedPath)).resolves.toMatchObject({
					requiresAuthorization: true,
					request: { risk: "dangerous" },
				});
			}

			for (const mode of ["plan", "ask", "autoEdit", "fullAccess"] satisfies ApprovalMode[]) {
				for (const toolName of ["edit", "write"]) {
					const router = new ToolAuthorizationRouter();
					router.register("session-1", "chat-1", mode);
					if (mode === "ask") {
						router.onDidRequest((prompt) => router.resolve(prompt.id, "chat-1", "allowOnce"));
					}
					const handler = await gateHandler({
						sessionId: "session-1",
						cwd: firstRoot,
						workspaceRoots: () => roots,
						authorize: (request) =>
							router.authorize({
								sessionId: request.sessionId,
								toolCallId: request.toolCallId,
								toolName: request.toolName,
								capability: capabilityForToolRequest(request, roots),
								cwd: request.cwd,
								...(request.target === undefined ? {} : { target: request.target }),
								risk: request.risk === "safe" ? "normal" : request.risk,
							}),
					});
					const result = await handler(toolCall(toolName, { path: secondFile }));
					expect(result === undefined).toBe(mode !== "plan");
					router.dispose();
				}
			}

			let currentRoots: readonly string[] = roots;
			const dynamicGate = await gateHandler({
				sessionId: "session-1",
				cwd: firstRoot,
				workspaceRoots: () => currentRoots,
			});
			expect(await dynamicGate(toolCall("read", { path: secondFile }))).toBeUndefined();
			currentRoots = [firstRoot];
			expect(await dynamicGate(toolCall("read", { path: secondFile }))).toMatchObject({
				block: true,
			});

			await rm(secondRoot, { recursive: true, force: true });
			await expect(classify("read", secondFile)).resolves.toMatchObject({
				requiresAuthorization: true,
				request: { risk: "dangerous" },
			});
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	});

	test("routes normal workspace mutations and higher-risk tools through approval", async () => {
		const edit = await classifyToolCall(toolCall("edit", { path: "src/index.ts", edits: [] }), {
			sessionId: "session-1",
			cwd,
		});
		const shell = await classifyToolCall(toolCall("bash", { command: "bun test" }), {
			sessionId: "session-1",
			cwd,
		});
		const deletions = await Promise.all(
			["rm -rf dist", "del build.log", "Remove-Item generated", "find . -delete"].map((command) =>
				classifyToolCall(toolCall("bash", { command }), {
					sessionId: "session-1",
					cwd,
				}),
			),
		);
		const dangerous = await classifyToolCall(toolCall("bash", { command: "git reset --hard" }), {
			sessionId: "session-1",
			cwd,
		});
		const custom = await classifyToolCall(toolCall("deploy", { environment: "prod" }), {
			sessionId: "session-1",
			cwd,
		});
		expect(edit).toMatchObject({
			requiresAuthorization: true,
			request: { capability: "mutate", risk: "safe" },
		});
		expect(shell.request).toMatchObject({ capability: "execute", risk: "sensitive" });
		for (const deletion of deletions) expect(deletion.request.risk).toBe("dangerous");
		expect(dangerous.request.risk).toBe("dangerous");
		expect(custom.request).toMatchObject({ capability: "extension", risk: "dangerous" });
	});

	test("fails closed without a host callback and honors an explicit allow", async () => {
		const denied = await gateHandler({ sessionId: "session-1", cwd });
		expect(await denied(toolCall("write", { path: "new.ts", content: "value" }))).toMatchObject({
			block: true,
		});

		const requests: unknown[] = [];
		const allowed = await gateHandler({
			sessionId: "session-1",
			cwd,
			authorize: async (request) => {
				requests.push(request);
				return { allow: true };
			},
		});
		expect(await allowed(toolCall("bash", { command: "bun test" }))).toBeUndefined();
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ sessionId: "session-1", toolCallId: "call-1" });

		const normalEdit = await gateHandler({
			sessionId: "session-1",
			cwd,
			authorize: async (request) => {
				requests.push(request);
				return { allow: true };
			},
		});
		expect(
			await normalEdit(toolCall("edit", { path: "src/index.ts", oldText: "a", newText: "b" })),
		).toBeUndefined();
		expect(requests[1]).toMatchObject({ capability: "mutate", risk: "safe" });
	});

	test("keeps the hidden gate after argument-mutating extensions", () => {
		expect(
			moveAuthorizationGateLast([
				{ path: "<inline:pi-vscode-permission-gate>" },
				{ path: "/project/mutator.ts" },
			]),
		).toEqual([{ path: "/project/mutator.ts" }, { path: "<inline:pi-vscode-permission-gate>" }]);
	});
});
