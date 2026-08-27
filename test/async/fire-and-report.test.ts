import { describe, expect, test } from "bun:test";
import { fireAndReport } from "../../src/extension/async/fire-and-report.js";

describe("fireAndReport", () => {
	test("reports a rejected background operation exactly once", async () => {
		const reports: Array<{ readonly message: string; readonly error: unknown }> = [];
		const error = new Error("post failed");
		fireAndReport(
			Promise.reject(error),
			(message, reportedError) => reports.push({ message, error: reportedError }),
			"Could not post.",
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(reports).toEqual([{ message: "Could not post.", error }]);
	});

	test("contains an error thrown by the reporter", async () => {
		fireAndReport(
			Promise.reject(new Error("operation")),
			() => {
				throw new Error("reporter");
			},
			"Handled",
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(true).toBeTrue();
	});
});
