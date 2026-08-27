import { describe, expect, test } from "bun:test";
import { ComposerDropTracker } from "../../src/webview/composer-drop-tracker.js";

describe("composer drop hover tracking", () => {
	test("activates when resource metadata first becomes available on dragover", () => {
		const tracker = new ComposerDropTracker();
		expect(tracker.enter("unknown")).toBe(false);
		expect(tracker.over("resource")).toBe(true);
		expect(tracker.active).toBe(true);
	});

	test("does not activate for an ordinary text selection", () => {
		const tracker = new ComposerDropTracker();
		expect(tracker.enter("text")).toBe(false);
		expect(tracker.over("text")).toBe(false);
	});

	test("does not flicker while moving across composer children", () => {
		const tracker = new ComposerDropTracker();
		expect(tracker.enter("resource")).toBe(true);
		expect(tracker.enter("resource")).toBe(true);
		expect(tracker.leave(true)).toBe(true);
		expect(tracker.leave(false)).toBe(false);
	});

	test("resets a drag that ends or drops elsewhere", () => {
		const tracker = new ComposerDropTracker();
		tracker.enter("resource");
		expect(tracker.reset()).toBe(false);
		expect(tracker.active).toBe(false);
	});
});
