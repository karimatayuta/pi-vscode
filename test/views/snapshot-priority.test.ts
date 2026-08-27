import { describe, expect, test } from "bun:test";
import { snapshotPriorityForIntent } from "../../src/extension/views/snapshot-priority.js";

describe("webview snapshot priority", () => {
	test("publishes the selected chat history immediately", () => {
		expect(snapshotPriorityForIntent("selectChat")).toBe("immediate");
		expect(snapshotPriorityForIntent("ready")).toBe("immediate");
	});

	test("coalesces ordinary high-frequency updates", () => {
		expect(snapshotPriorityForIntent("sendPrompt")).toBe("coalesced");
		expect(snapshotPriorityForIntent("searchFiles")).toBe("coalesced");
	});
});
