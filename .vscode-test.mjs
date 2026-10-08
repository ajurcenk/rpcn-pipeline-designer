import { defineConfig } from '@vscode/test-cli';

// Two runs of the same suite (ticket 2.11): the latest stable VS Code, and VS Code 1.100.0, the
// floor that package.json's engines.vscode (^1.100.0) promises. `npm test` runs both;
// `npx vscode-test --label stable` or `--label floor` runs one.
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
]);
