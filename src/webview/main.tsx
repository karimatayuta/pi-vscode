import { render } from "preact";
import { validateHostToWebviewMessage } from "../shared/protocol.js";
import { App } from "./App.js";
import { mergeSnapshot } from "./store.js";
import "./styles.css";

window.addEventListener("message", (event: MessageEvent<unknown>) => {
	const result = validateHostToWebviewMessage(event.data);
	if (!result.ok) {
		return;
	}
	const message = result.message;
	if (message.type === "snapshot") {
		mergeSnapshot(message.snapshot);
	} else if (message.type === "focusComposer") {
		document.querySelector<HTMLTextAreaElement>("#pi-prompt")?.focus();
	} else {
		window.dispatchEvent(new CustomEvent("pi-notice", { detail: message }));
	}
});

const root = document.getElementById("root");
if (!root) {
	throw new Error("Pi Agent webview root is missing.");
}
render(<App />, root);
