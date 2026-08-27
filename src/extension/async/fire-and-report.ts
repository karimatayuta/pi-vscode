export type BackgroundErrorReporter = (message: string, error: unknown) => void;

/** Explicitly owns a background Thenable so it cannot reject unobserved. */
export function fireAndReport(
	operation: PromiseLike<unknown>,
	report: BackgroundErrorReporter,
	message: string,
): void {
	void Promise.resolve(operation).catch((error) => {
		try {
			report(message, error);
		} catch {
			// Reporting must not turn a handled failure into another rejection.
		}
	});
}
