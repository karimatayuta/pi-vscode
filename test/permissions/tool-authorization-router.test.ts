import { describe, expect, test } from "bun:test";
import { ToolAuthorizationRouter } from "../../src/extension/permissions/tool-authorization-router.js";

describe("ToolAuthorizationRouter", () => {
	test("Plan mode denies mutation without prompting", async () => {
		const router = new ToolAuthorizationRouter();
		router.register("session", "chat", "plan");
		const result = await router.authorize({
			sessionId: "session",
			toolCallId: "tool",
			toolName: "edit",
			capability: "workspace.edit",
			cwd: "/workspace",
			target: "/workspace/a.ts",
			risk: "normal",
		});
		expect(result.allow).toBe(false);
		router.dispose();
	});

	test("Ask mode waits for an exact approval and rejects replay", async () => {
		const router = new ToolAuthorizationRouter();
		router.register("session", "chat", "ask");
		let promptId = "";
		router.onDidRequest((prompt) => {
			promptId = prompt.id;
			expect(prompt.command).toBe("bun test");
			expect(router.resolve(prompt.id, "other-chat", "allowOnce")).toBe(false);
			expect(router.resolve(prompt.id, "chat", "allowOnce")).toBe(true);
		});
		const result = await router.authorize({
			sessionId: "session",
			toolCallId: "tool",
			toolName: "bash",
			capability: "command.execute",
			cwd: "/workspace",
			command: "bun test",
			risk: "normal",
		});
		expect(promptId).not.toBe("");
		expect(result.allow).toBe(true);
		expect(router.resolve(promptId, "chat", "allowOnce")).toBe(false);
		router.dispose();
	});

	test("dangerous approvals are never promoted to a session grant", async () => {
		const router = new ToolAuthorizationRouter();
		router.register("session", "chat", "fullAccess");
		let prompts = 0;
		router.onDidRequest((prompt) => {
			prompts += 1;
			router.resolve(prompt.id, "chat", "allowSession");
		});
		const request = {
			sessionId: "session",
			toolCallId: "tool",
			toolName: "bash",
			capability: "command.execute" as const,
			cwd: "/workspace",
			command: "git reset --hard",
			risk: "dangerous" as const,
		};
		expect((await router.authorize(request)).allow).toBe(true);
		expect((await router.authorize({ ...request, toolCallId: "tool-2" })).allow).toBe(true);
		expect(prompts).toBe(2);
		router.dispose();
	});

	test("reuses a normal edit grant only for the exact workspace target", async () => {
		const router = new ToolAuthorizationRouter();
		router.register("session", "chat", "ask");
		let prompts = 0;
		router.onDidRequest((prompt) => {
			prompts += 1;
			router.resolve(prompt.id, "chat", prompts === 1 ? "allowSession" : "deny");
		});
		const edit = {
			sessionId: "session",
			toolCallId: "tool-1",
			toolName: "edit",
			capability: "workspace.edit" as const,
			cwd: "/workspace",
			target: "/workspace/a.ts",
			risk: "normal" as const,
		};
		expect((await router.authorize(edit)).allow).toBe(true);
		expect((await router.authorize({ ...edit, toolCallId: "tool-2" })).allow).toBe(true);
		expect(
			(
				await router.authorize({
					...edit,
					toolCallId: "tool-3",
					target: "/workspace/b.ts",
				})
			).allow,
		).toBe(false);
		expect(prompts).toBe(2);
		router.dispose();
	});

	test("bounds session grants and evicts the least recently used target", async () => {
		const router = new ToolAuthorizationRouter({ maxSessionGrants: 2 });
		router.register("session", "chat", "ask");
		let prompts = 0;
		router.onDidRequest((prompt) => {
			prompts += 1;
			router.resolve(prompt.id, "chat", "allowSession");
		});
		const authorizeTarget = (target: string) =>
			router.authorize({
				sessionId: "session",
				toolCallId: `tool-${target}`,
				toolName: "edit",
				capability: "workspace.edit",
				cwd: "/workspace",
				target: `/workspace/${target}.ts`,
				risk: "normal",
			});

		expect((await authorizeTarget("a")).allow).toBe(true);
		expect((await authorizeTarget("b")).allow).toBe(true);
		expect((await authorizeTarget("a")).allow).toBe(true); // Refresh A's recency.
		expect((await authorizeTarget("c")).allow).toBe(true); // Evicts B.
		expect((await authorizeTarget("a")).allow).toBe(true);
		expect(prompts).toBe(3);
		expect((await authorizeTarget("b")).allow).toBe(true);
		expect(prompts).toBe(4);
		router.dispose();
	});

	test("fails closed when global or per-session approval queues reach their bounds", async () => {
		const router = new ToolAuthorizationRouter({ maxPending: 2, maxPendingPerSession: 1 });
		for (const session of ["one", "two", "three"]) router.register(session, session, "ask");
		const request = (sessionId: string, toolCallId: string) => ({
			sessionId,
			toolCallId,
			toolName: "edit",
			capability: "workspace.edit" as const,
			cwd: "/workspace",
			target: `/workspace/${toolCallId}.ts`,
			risk: "normal" as const,
		});
		const first = router.authorize(request("one", "first"));
		expect(await router.authorize(request("one", "same-session-overflow"))).toMatchObject({
			allow: false,
			reason: expect.stringContaining("Too many"),
		});
		const second = router.authorize(request("two", "second"));
		expect(await router.authorize(request("three", "global-overflow"))).toMatchObject({
			allow: false,
			reason: expect.stringContaining("Too many"),
		});
		expect(router.cancelPendingForSession("one")).toBe(1);
		expect(router.cancelPendingForSession("two")).toBe(1);
		expect((await first).allow).toBe(false);
		expect((await second).allow).toBe(false);
		router.dispose();
	});

	test("cancels every pending request for a stopped session and notifies observers", async () => {
		const router = new ToolAuthorizationRouter();
		router.register("session", "chat", "ask");
		const resolved: string[] = [];
		router.onDidResolve(({ id }) => resolved.push(id));
		const pending = router.authorize({
			sessionId: "session",
			toolCallId: "tool",
			toolName: "bash",
			capability: "command.execute",
			cwd: "/workspace",
			command: "bun test",
			risk: "normal",
		});
		expect(router.cancelPendingForSession("session", "Stopped")).toBe(1);
		expect(await pending).toEqual({ allow: false, reason: "Stopped" });
		expect(resolved).toHaveLength(1);
		router.dispose();
	});

	test("reset rejects pending tools, preserves policy modes, and emits one reset event", async () => {
		const router = new ToolAuthorizationRouter();
		router.register("session", "chat", "fullAccess");
		router.register("restricted", "restricted-chat", "plan");
		router.register("automatic", "automatic-chat", "autoEdit");
		let resets = 0;
		router.onDidReset(() => {
			resets += 1;
		});
		const pending = router.authorize({
			sessionId: "session",
			toolCallId: "dangerous",
			toolName: "bash",
			capability: "command.execute",
			cwd: "/workspace",
			command: "git reset --hard",
			risk: "dangerous",
		});
		router.reset();
		expect(await pending).toEqual({ allow: false, reason: "Permissions were reset." });
		expect(resets).toBe(1);
		expect(
			await router.authorize({
				sessionId: "session",
				toolCallId: "after-reset",
				toolName: "bash",
				capability: "command.execute",
				cwd: "/workspace",
				command: "bun test",
				risk: "normal",
			}),
		).toEqual({ allow: true });
		expect(
			(
				await router.authorize({
					sessionId: "restricted",
					toolCallId: "restricted-after-reset",
					toolName: "bash",
					capability: "command.execute",
					cwd: "/workspace",
					command: "bun test",
					risk: "normal",
				})
			).allow,
		).toBe(false);
		expect(
			await router.authorize({
				sessionId: "automatic",
				toolCallId: "automatic-after-reset",
				toolName: "edit",
				capability: "workspace.edit",
				cwd: "/workspace",
				target: "/workspace/a.ts",
				risk: "normal",
			}),
		).toEqual({ allow: true });
		router.dispose();
	});

	test("reset clears target grants without changing Ask mode", async () => {
		const router = new ToolAuthorizationRouter();
		router.register("session", "chat", "ask");
		let prompts = 0;
		router.onDidRequest((prompt) => {
			prompts += 1;
			router.resolve(prompt.id, "chat", prompts === 1 ? "allowSession" : "deny");
		});
		const request = {
			sessionId: "session",
			toolCallId: "before-reset",
			toolName: "edit",
			capability: "workspace.edit" as const,
			cwd: "/workspace",
			target: "/workspace/a.ts",
			risk: "normal" as const,
		};
		expect((await router.authorize(request)).allow).toBe(true);
		expect((await router.authorize({ ...request, toolCallId: "granted" })).allow).toBe(true);
		expect(prompts).toBe(1);
		router.reset();
		expect((await router.authorize({ ...request, toolCallId: "after-reset" })).allow).toBe(false);
		expect(prompts).toBe(2);
		router.dispose();
	});
});
