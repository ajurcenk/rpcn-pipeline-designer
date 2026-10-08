// The graph webview's HTML (ticket 3.1): one script with a nonce and the bundle's stylesheet,
// under a strict CSP. @xyflow/react sets inline style attributes, hence `'unsafe-inline'` for
// styles only.

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

/** A random nonce for the script tag. */
export function makeNonce(): string {
	return randomBytes(16).toString('base64');
}

/** The Content-Security-Policy for the graph webview. */
export function contentSecurityPolicy(cspSource: string, nonce: string): string {
	return [
		`default-src 'none'`,
		`script-src 'nonce-${nonce}'`,
		`style-src ${cspSource} 'unsafe-inline'`,
		`img-src ${cspSource} data:`,
		`font-src ${cspSource}`,
	].join('; ');
}

/** The page that loads `dist/webview.js` and `dist/webview.css`. */
export function graphHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
	const nonce = makeNonce();
	const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
	const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(webview.cspSource, nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style.toString()}">
<title>${escapeHtml(title)}</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
