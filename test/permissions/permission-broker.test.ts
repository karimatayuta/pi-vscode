import { describe, expect, test } from "bun:test";
import {
	evaluatePermission,
	type PermissionAction,
	PermissionBroker,
	type PermissionRequest,
} from "../../src/extension/permissions/permission-broker.js";
import type { ApprovalMode, Capability, RiskLevel } from "../../src/shared/approval.js";

function request(
	capability: Capability,
	risk: RiskLevel = "low",
	id = `${capability}-${risk}`,
): PermissionRequest {
	return {
		id,
		chatId: "chat-1",
		capability,
		risk,
		summary: `Use ${capability}`,
	};
}

describe("permission policy matrix", () => {
	test.each<[ApprovalMode, Capability, RiskLevel, PermissionAction]>([
		["plan", "workspace.read", "low", "allow"],
		["plan", "workspace.edit", "low", "deny"],
		["plan", "command.execute", "high", "deny"],
		["ask", "workspace.read", "medium", "allow"],
		["ask", "workspace.read", "high", "ask"],
		["ask", "workspace.edit", "low", "ask"],
		["autoEdit", "workspace.edit", "high", "allow"],
		["autoEdit", "workspace.write", "medium", "allow"],
		["autoEdit", "workspace.delete", "low", "ask"],
		["autoEdit", "command.execute", "low", "allow"],
		["autoEdit", "command.execute", "high", "allow"],
		["fullAccess", "command.execute", "high", "allow"],
		["fullAccess", "network.access", "medium", "allow"],
	])("%s evaluates %s/%s as %s", (mode, capability, risk, action) => {
		expect(evaluatePermission(mode, request(capability, risk)).action).toBe(action);
	});

	test.each<ApprovalMode>(["ask", "autoEdit", "fullAccess"])(
		"%s always asks before critical operations",
		(mode) => {
			expect(evaluatePermission(mode, request("command.execute", "critical")).action).toBe("ask");
		},
	);

	test.each<ApprovalMode>(["ask", "autoEdit", "fullAccess"])(
		"%s asks before crossing workspace or secret boundaries",
		(mode) => {
			expect(evaluatePermission(mode, request("filesystem.outside-workspace", "low")).action).toBe(
				"ask",
			);
			expect(evaluatePermission(mode, request("secrets.read", "low")).action).toBe("ask");
		},
	);

	test("fails closed when an unvalidated runtime mode reaches the policy boundary", () => {
		expect(() =>
			evaluatePermission("unexpected" as ApprovalMode, request("command.execute", "low")),
		).toThrow("Unknown Pi Agent approval mode");
	});
});

describe("PermissionBroker", () => {
	test("tracks a prompt and binds its response to the originating chat", () => {
		const broker = new PermissionBroker("ask");
		const pending = broker.begin(request("workspace.edit", "medium", "p1"));
		expect(pending.action).toBe("ask");
		expect(broker.pendingForChat("chat-1")).toHaveLength(1);
		expect(() => broker.resolve("p1", "different-chat", true)).toThrow();

		const resolved = broker.resolve("p1", "chat-1", true);
		expect(resolved).toMatchObject({
			action: "allow",
			source: "user",
			reason: "user-approved",
			mode: "ask",
		});
		expect(broker.pendingForChat("chat-1")).toHaveLength(0);
	});

	test("uses the mode captured when approval was requested", () => {
		const broker = new PermissionBroker("ask");
		broker.begin(request("command.execute", "high", "p1"));
		broker.setMode("fullAccess");
		expect(broker.resolve("p1", "chat-1", false).mode).toBe("ask");
	});

	test("blocks duplicate and replayed request IDs", () => {
		const broker = new PermissionBroker("ask");
		broker.begin(request("workspace.edit", "low", "p1"));
		expect(() => broker.begin(request("workspace.write", "low", "p1"))).toThrow(
			"Duplicate permission request",
		);
		broker.resolve("p1", "chat-1", true);
		expect(() => broker.begin(request("workspace.write", "low", "p1"))).toThrow(
			"Duplicate permission request",
		);
		expect(() => broker.resolve("p1", "chat-1", true)).toThrow("Unknown or already resolved");
	});

	test("policy decisions do not enter the pending queue", () => {
		const broker = new PermissionBroker("plan");
		expect(broker.begin(request("workspace.read", "low", "read"))).toMatchObject({
			action: "allow",
			source: "policy",
		});
		expect(broker.begin(request("workspace.write", "low", "write"))).toMatchObject({
			action: "deny",
			source: "policy",
		});
		expect(broker.pendingForChat("chat-1")).toHaveLength(0);
	});

	test("bounds the replay window while retaining the newest consumed request IDs", () => {
		const broker = new PermissionBroker("plan", { maxConsumedRequests: 2 });
		broker.begin(request("workspace.read", "low", "read-1"));
		broker.begin(request("workspace.read", "low", "read-2"));
		expect(() => broker.begin(request("workspace.read", "low", "read-1"))).toThrow(
			"Duplicate permission request",
		);

		broker.begin(request("workspace.read", "low", "read-3"));
		expect(() => broker.begin(request("workspace.read", "low", "read-1"))).not.toThrow();
		expect(() => broker.begin(request("workspace.read", "low", "read-3"))).toThrow(
			"Duplicate permission request",
		);
	});
});
