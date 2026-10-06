import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// extensionDependencies (redhat.vscode-yaml) are installed automatically by @vscode/test-cli.
	mocha: {
		ui: 'tdd',
		timeout: 20000,
	},
});
