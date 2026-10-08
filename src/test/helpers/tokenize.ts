// Tokenizes text the way VS Code highlights it (ticket 2.9): VS Code's own YAML grammars (from
// the running test instance, `vscode.env.appRoot`) plus this extension's Bloblang injection.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as oniguruma from 'vscode-oniguruma';
import * as vsctm from 'vscode-textmate';
import { REPO_ROOT } from './fakeBinary';

export interface Token {
	readonly text: string;
	readonly scopes: readonly string[];
}

let registry: Promise<vsctm.Registry> | undefined;

function yamlSyntaxes(): string {
	return path.join(vscode.env.appRoot, 'extensions', 'yaml', 'syntaxes');
}

async function loadRegistry(): Promise<vsctm.Registry> {
	const wasm = fs.readFileSync(path.join(REPO_ROOT, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm')).buffer;
	await oniguruma.loadWASM(wasm);
	const files: Record<string, string> = {
		'source.yaml': path.join(yamlSyntaxes(), 'yaml.tmLanguage.json'),
		'source.yaml.1.3': path.join(yamlSyntaxes(), 'yaml-1.3.tmLanguage.json'),
		'source.yaml.1.2': path.join(yamlSyntaxes(), 'yaml-1.2.tmLanguage.json'),
		'source.yaml.1.1': path.join(yamlSyntaxes(), 'yaml-1.1.tmLanguage.json'),
		'source.yaml.1.0': path.join(yamlSyntaxes(), 'yaml-1.0.tmLanguage.json'),
		'source.yaml.embedded': path.join(yamlSyntaxes(), 'yaml-embedded.tmLanguage.json'),
		'source.bloblang': path.join(REPO_ROOT, 'syntaxes', 'bloblang.tmLanguage.json'),
		'bloblang.injection': path.join(REPO_ROOT, 'syntaxes', 'bloblang.injection.tmLanguage.json'),
	};
	return new vsctm.Registry({
		onigLib: Promise.resolve({
			createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
			createOnigString: (s: string) => new oniguruma.OnigString(s),
		}),
		loadGrammar: async (scope) => {
			const file = files[scope];
			return file && fs.existsSync(file) ? vsctm.parseRawGrammar(fs.readFileSync(file, 'utf8'), file) : null;
		},
		getInjections: (scope) => (scope.startsWith('source.yaml') ? ['bloblang.injection'] : undefined),
	});
}

/** One array of tokens per line of `text`. */
export async function tokenize(text: string): Promise<Token[][]> {
	registry ??= loadRegistry();
	const grammar = (await (await registry).loadGrammar('source.yaml'))!;
	let state = vsctm.INITIAL;
	return text.split('\n').map((line) => {
		const result = grammar.tokenizeLine(line, state);
		state = result.ruleStack;
		return result.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes }));
	});
}

/** The scopes of the first token on `line` whose text equals `text` (trimmed). */
export function scopesOf(lines: Token[][], line: number, text: string): readonly string[] | undefined {
	return lines[line]?.find((t) => t.text.trim() === text)?.scopes;
}
