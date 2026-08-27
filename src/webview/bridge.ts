import type { WebviewIntent } from "../shared/protocol.js";

declare function acquireVsCodeApi<T = unknown>(): {
	postMessage(message: unknown): void;
	getState(): T | undefined;
	setState(state: T): void;
};

const vscode = acquireVsCodeApi<{ activeChatId?: string }>();
let sequence = 0;

export function postIntent(intent: WebviewIntent): void {
	sequence += 1;
	vscode.postMessage({
		protocolVersion: 1,
		requestId: `wv-${Date.now().toString(36)}-${sequence.toString(36)}`,
		...intent,
	});
}

export function persistActiveChat(activeChatId: string): void {
	vscode.setState({ activeChatId });
}

export function restoredActiveChat(): string | undefined {
	return vscode.getState()?.activeChatId;
}
