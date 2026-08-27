import { describe, expect, test } from "bun:test";
import { buildCommandCatalog, buildCommandPrompt } from "../../src/extension/pi/command-catalog.js";

describe("Pi command catalog", () => {
	test("uses Pi dispatch precedence and exposes skills as skill:name", () => {
		const commands = buildCommandCatalog({
			extensions: [
				{
					invocationName: "review",
					description: "Extension review",
					getArgumentCompletions: () => [],
				},
			],
			prompts: [{ name: "review", description: "Template review" }, { name: "summarize" }],
			skills: [
				{ name: "review", description: "Skill review" },
				{ name: "testing", description: "Run the testing skill" },
			],
		});

		expect(commands).toEqual([
			{
				invocation: "review",
				kind: "extension",
				description: "Extension review",
				hasArgumentCompletions: true,
			},
			{
				invocation: "summarize",
				kind: "prompt",
				hasArgumentCompletions: false,
			},
			{
				invocation: "skill:review",
				kind: "skill",
				description: "Skill review",
				hasArgumentCompletions: false,
			},
			{
				invocation: "skill:testing",
				kind: "skill",
				description: "Run the testing skill",
				hasArgumentCompletions: false,
			},
		]);
	});

	test("omits malformed commands and builds only catalogued prompts", () => {
		const commands = buildCommandCatalog({
			prompts: [{ name: "valid-command" }, { name: "bad command" }, { name: "/also-bad" }],
		});
		expect(commands).toHaveLength(1);
		expect(buildCommandPrompt(commands, "valid-command", "  focused args  ")).toBe(
			"/valid-command focused args",
		);
		expect(() => buildCommandPrompt(commands, "missing")).toThrow("Unknown Pi command");
	});

	test("caps extension-provided command catalogs before they reach the webview", () => {
		const commands = buildCommandCatalog({
			extensions: Array.from({ length: 20_000 }, (_, index) => ({
				invocationName: `command-${index}`,
			})),
		});
		expect(commands).toHaveLength(4_096);
	});
});
