import type { WebviewIntent } from "../shared/protocol.js";

declare function acquireVsCodeApi<T = unknown>(): {
	postMessage(message: unknown): void;
	getState(): T | undefined;
	setState(state: T): void;
};

const vscode = acquireVsCodeApi<{ activeChatId?: string }>();
let sequence = 0;

export function postIntent(intent: WebviewIntent): string {
	sequence += 1;
	const requestId = `wv-${Date.now().toString(36)}-${sequence.toString(36)}`;
	vscode.postMessage({
		protocolVersion: 1,
		requestId,
		...intent,
	});
	return requestId;
}

export function persistActiveChat(activeChatId: string): void {
	vscode.setState({ activeChatId });
}

export function restoredActiveChat(): string | undefined {
	return vscode.getState()?.activeChatId;
}
