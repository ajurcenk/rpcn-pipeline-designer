import { defineConfig } from '@vscode/test-cli';

// Two runs of the same suite (ticket 2.11): the latest stable VS Code, and VS Code 1.100.0, the
// floor that package.json's engines.vscode (^1.100.0) promises; both open no folder. A third run
// (ticket 28), `multiroot`, opens the two-folder test/multiroot workspace and loads only its own
// suite (its entry is not a `*.test.js` file), on the latest stable VS Code. `npm test` runs all
// three; `npx vscode-test --label stable`, `--label floor` or `--label multiroot` runs one.
const shared = {
	files: 'out/test/**/*.test.js',
	// extensionDependencies (redhat.vscode-yaml) are installed automatically by @vscode/test-cli.
	mocha: {
		ui: 'tdd',
		timeout: 20000,
	},
};

export default defineConfig([
	{ label: 'stable', ...shared },
	{ label: 'floor', version: '1.100.0', ...shared },
	{
		label: 'multiroot',
		files: 'out/test/integration-multiroot/index.multiroot.js',
		workspaceFolder: 'test/multiroot/multiroot.code-workspace',
		mocha: shared.mocha,
	},
]);
