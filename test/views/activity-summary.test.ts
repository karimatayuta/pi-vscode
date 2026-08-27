import { describe, expect, test } from "bun:test";
import type { PiStreamDeltaDto } from "../../src/extension/pi/types.js";
import {
	summarizeSessionActivity,
	summarizeStreamActivity,
	summarizeToolActivity,
	taskFocusFromUserText,
} from "../../src/extension/views/activity-summary.js";

describe("Japanese activity summaries", () => {
	test("classifies a request into a short, natural topic without echoing its contents", () => {
		expect(taskFocusFromUserText("認証フローから重複した token 更新処理を除いて")).toBe("認証処理");
		expect(taskFocusFromUserText("チャット入力欄へファイルをドラッグ＆ドロップしたい")).toBe(
			"ファイル添付",
		);
		expect(taskFocusFromUserText("未知の依頼 API_KEY=very-secret-value")).toBe("ご依頼");
	});

	test("describes file tools with a bounded workspace-style path", () => {
		expect(
			summarizeToolActivity(
				{ toolName: "read", args: { path: "/Users/example/project/src/auth.ts" } },
				"認証処理",
				"start",
			),
		).toBe("src/auth.ts を確認しています");
		expect(
			summarizeToolActivity(
				{ toolName: "write", args: { path: "src/auth.ts" } },
				"認証処理",
				"end",
			),
		).toBe("src/auth.ts の変更内容を確認しています");
	});

	test("classifies commands without exposing raw commands or secrets", () => {
		const summary = summarizeToolActivity(
			{
				toolName: "bash",
				args: { command: "API_KEY=very-secret-value bun test test/auth.test.ts" },
			},
			"認証処理",
			"start",
		);
		expect(summary).toBe("認証処理のテストを実行しています");
		expect(summary).not.toContain("very-secret-value");
		expect(summary).not.toContain("auth.test.ts");
	});

	test("never renders thinking delta text or raw chain-of-thought", () => {
		const privateDelta = {
			kind: "thinking",
			text: "private reasoning API_KEY=very-secret-value",
		} satisfies PiStreamDeltaDto;
		const summary = summarizeStreamActivity(privateDelta, "認証処理");
		expect(summary).toBe("認証処理の進め方を整理しています");
		expect(summary).not.toContain("private reasoning");
		expect(summary).not.toContain("very-secret-value");
	});

	test("uses stable Japanese copy for lifecycle phases", () => {
		expect(summarizeSessionActivity("compacting", "ご依頼")).toBe(
			"会話のコンテキストを整理しています",
		);
		expect(summarizeSessionActivity("retrying", "認証処理")).toBe(
			"一時的な問題から処理を再開しています",
		);
		expect(summarizeSessionActivity("idle", "認証処理")).toBe("待機中");
	});

	test("removes controls and caps untrusted labels", () => {
		const summary = summarizeToolActivity(
			{
				toolName: "read",
				args: { path: `src/\n\u202e${"長".repeat(200)}.ts?secret=value` },
			},
			"ご依頼",
			"start",
		);
		expect(summary).not.toContain("\n");
		expect(summary).not.toContain("\u202e");
		expect(summary).not.toContain("secret=value");
		expect([...summary].length).toBeLessThanOrEqual(96);
	});
});
