import { describe, expect, test } from "bun:test";
import { LatestRequest } from "../../src/extension/views/latest-request.js";

describe("LatestRequest", () => {
	test("prevents an older async result from replacing the latest result", () => {
		const requests = new LatestRequest();
		const older = requests.begin();
		const latest = requests.begin();

		expect(requests.isCurrent(older)).toBe(false);
		expect(requests.isCurrent(latest)).toBe(true);
	});

	test("invalidates pending work on disposal", () => {
		const requests = new LatestRequest();
		const pending = requests.begin();
		requests.invalidate();
		expect(requests.isCurrent(pending)).toBe(false);
	});
});
