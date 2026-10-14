// The webviews' HTML (ticket 3.1; parameterised by bundle in ticket 4.2): one script with a nonce
// and the bundle's stylesheet, under a strict CSP, the same for the graph and the Bloblang panel.
// @xyflow/react sets inline style attributes, hence `'unsafe-inline'` for styles only.

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

/** A random nonce for the script tag. */
export function makeNonce(): string {
	return randomBytes(16).toString('base64');
}

/** The Content-Security-Policy for the extension's webviews. */
export function contentSecurityPolicy(cspSource: string, nonce: string): string {
	return [
		`default-src 'none'`,
		`script-src 'nonce-${nonce}'`,
		`style-src ${cspSource} 'unsafe-inline'`,
		`img-src ${cspSource} data:`,
		`font-src ${cspSource}`,
	].join('; ');
}

/** The graph's page: `dist/webview.js` and `dist/webview.css`. */
export function graphHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
	return webviewHtml(webview, extensionUri, 'webview', title);
}

/**
 * The page that loads `dist/<bundle>.js` and `dist/<bundle>.css`; each `data` entry becomes a
 * `data-<key>` attribute of `#root` (the Bloblang panel's file name, ticket 4.8).
 */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, bundle: string, title: string, data: Readonly<Record<string, string>> = {}): string {
	const nonce = makeNonce();
	const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', `${bundle}.js`));
	const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', `${bundle}.css`));
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
<div id="root"${Object.entries(data).map(([key, value]) => ` data-${key}="${escapeHtml(value)}"`).join('')}></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
