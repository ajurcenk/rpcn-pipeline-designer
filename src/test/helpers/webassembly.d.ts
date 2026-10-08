// The two WebAssembly types vscode-oniguruma's typings name (test-only tokenizer, ticket 2.9).
// The project's `lib` is ES2022 without DOM, which is where TypeScript defines them.
declare namespace WebAssembly {
	type ImportValue = unknown;
	interface WebAssemblyInstantiatedSource {
		readonly instance: unknown;
		readonly module: unknown;
	}
}
