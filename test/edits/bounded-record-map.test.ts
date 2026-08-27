import { describe, expect, test } from "bun:test";
import { BoundedRecordMap } from "../../src/extension/edits/bounded-record-map.js";

describe("BoundedRecordMap", () => {
	test("evicts the least-recently-used record at entry capacity", () => {
		const records = new BoundedRecordMap<string>({
			maxEntries: 2,
			maxBytes: 100,
			sizeOf: (value) => value.length,
		});
		records.set("a", "one");
		records.set("b", "two");
		expect(records.get("a")).toBe("one");
		expect(records.set("c", "three")).toEqual(["two"]);
		expect([...records.values()]).toEqual(["one", "three"]);
	});

	test("tracks replacements and evicts until the byte budget is satisfied", () => {
		const records = new BoundedRecordMap<string>({
			maxEntries: 4,
			maxBytes: 7,
			sizeOf: (value) => value.length,
		});
		records.set("a", "1234");
		records.set("a", "12");
		records.set("b", "345");
		expect(records.bytes).toBe(5);
		expect(records.set("c", "678")).toEqual(["12"]);
		expect(records.bytes).toBe(6);
	});

	test("rejects a record that cannot fit even by itself", () => {
		const records = new BoundedRecordMap<string>({
			maxEntries: 1,
			maxBytes: 2,
			sizeOf: (value) => value.length,
		});
		expect(() => records.set("large", "123")).toThrow("retained-byte capacity");
		expect(records.size).toBe(0);
	});
});
