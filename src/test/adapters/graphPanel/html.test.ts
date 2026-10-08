import * as assert from 'assert';
import * as vscode from 'vscode';
import { graphHtml } from '../../../adapters/graphPanel/html';

const CSP_SOURCE = 'https://csp.example';
const webview = {
	cspSource: CSP_SOURCE,
	asWebviewUri: (uri: vscode.Uri) => uri.with({ scheme: 'https', authority: 'csp.example' }),
} as unknown as vscode.Webview;
const extensionUri = vscode.Uri.file('/ext');

const cspOf = (html: string) => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];
const scriptNonceOf = (html: string) => /<script nonce="([^"]+)" src="[^"]*dist\/webview\.js"><\/script>/.exec(html)?.[1];

suite('adapters/graphPanel html (3.1)', () => {
	test('CSP: the exact directive list, with the script nonce', () => {
		const html = graphHtml(webview, extensionUri, 'Graph: a.yaml');
		const nonce = scriptNonceOf(html);
		assert.ok(nonce, 'the script tag carries a nonce');
		assert.deepStrictEqual(cspOf(html)?.split('; '), [
			`default-src 'none'`,
			`script-src 'nonce-${nonce}'`,
			`style-src ${CSP_SOURCE} 'unsafe-inline'`,
			`img-src ${CSP_SOURCE} data:`,
			`font-src ${CSP_SOURCE}`,
		]);
		assert.strictEqual((html.match(/<script/g) ?? []).length, 1);
		assert.ok(html.includes('<link rel="stylesheet" href="https://csp.example/ext/dist/webview.css">'));
	});

	test('a fresh nonce per page', () => {
		const a = scriptNonceOf(graphHtml(webview, extensionUri, 't'));
		const b = scriptNonceOf(graphHtml(webview, extensionUri, 't'));
		assert.ok(a && b);
		assert.notStrictEqual(a, b);
	});

	test('the title is escaped', () => {
		const html = graphHtml(webview, extensionUri, `Graph: <b>"x" & 'y'</b>.yaml`);
		assert.ok(html.includes('<title>Graph: &#60;b&#62;&#34;x&#34; &#38; &#39;y&#39;&#60;/b&#62;.yaml</title>'));
		assert.ok(!html.includes('<b>'));
	});
});
