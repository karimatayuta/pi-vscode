export class PiHostError extends Error {
	public constructor(
		public readonly code: string,
		message: string,
		public readonly recoverable = true,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "PiHostError";
	}
}

export class DuplicateSessionFileError extends PiHostError {
	public constructor() {
		super("duplicate_session_file", "This saved Pi session is already open in another tab.");
		this.name = "DuplicateSessionFileError";
	}
}
