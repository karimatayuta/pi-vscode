import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

function nonce(): string {
	return randomBytes(24).toString("base64url");
}

export function createWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const scriptNonce = nonce();
	const scriptUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, "dist", "webview", "main.js"),
	);
	const styleUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, "dist", "webview", "main.css"),
	);
	const csp = [
		"default-src 'none'",
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`font-src ${webview.cspSource}`,
		`img-src ${webview.cspSource} data:`,
		`script-src 'nonce-${scriptNonce}'`,
		"connect-src 'none'",
		"media-src 'none'",
		"frame-src 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	].join("; ");
	return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <link rel="stylesheet" href="${styleUri}">
  <title>Pi Agent</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${scriptNonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
