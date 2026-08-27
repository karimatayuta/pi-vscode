import { describe, expect, test } from "bun:test";
import { DuplicateSessionFileError } from "../../src/extension/pi/errors.js";
import { SessionRegistry } from "../../src/extension/pi/session-registry.js";

describe("SessionRegistry", () => {
	test("owns a saved transcript only once", () => {
		const registry = new SessionRegistry<string>();
		registry.begin("one", "/sessions/a.jsonl");
		expect(() => registry.begin("two", "/sessions/a.jsonl")).toThrow(DuplicateSessionFileError);
		expect(registry.ids()).toEqual(["one"]);
	});

	test("reserves transitions atomically and restores availability on cancel", () => {
		const registry = new SessionRegistry<string>();
		registry.begin("one", "/sessions/a.jsonl");
		registry.begin("two", "/sessions/b.jsonl");
		registry.reserveTransition("one", "/sessions/c.jsonl");

		expect(() => registry.reserveTransition("one", "/sessions/b.jsonl")).toThrow(
			DuplicateSessionFileError,
		);
		expect(() => registry.begin("three", "/sessions/c.jsonl")).toThrow(DuplicateSessionFileError);

		registry.cancelTransition("one");
		registry.begin("three", "/sessions/c.jsonl");
		expect(() => registry.begin("four", "/sessions/a.jsonl")).toThrow(DuplicateSessionFileError);
	});

	test("commit releases the previous transcript and remove releases the current one", () => {
		const registry = new SessionRegistry<number>();
		registry.begin("one", "/sessions/a.jsonl");
		registry.attach("one", 0);
		registry.reserveTransition("one", "/sessions/b.jsonl");
		registry.commitTransition("one", "/sessions/b.jsonl");

		expect(registry.require("one")).toBe(0);
		registry.begin("two", "/sessions/a.jsonl");
		expect(() => registry.begin("three", "/sessions/b.jsonl")).toThrow(DuplicateSessionFileError);

		expect(registry.remove("one")).toBe(0);
		registry.begin("three", "/sessions/b.jsonl");
	});
});
