// Graph view tests (ticket 3.4): the pure layout and style checks of webview/, in plain Node.
// Ticket 11: a test file that renders a component (`*.test.tsx`) opts in to happy-dom with a
// `// @vitest-environment happy-dom` comment; test-setup.ts stubs what that needs (the VS Code
// webview API, and browser APIs React Flow uses that happy-dom lacks), in tests only.
//   npm run test:webview
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	// The repository root, so the tests can read src/test/fixtures/models.
	root: fileURLToPath(new URL('..', import.meta.url)),
	test: {
		include: ['webview/**/*.test.{ts,tsx}'],
		environment: 'node',
		setupFiles: ['webview/src/test-setup.ts'],
	},
});
