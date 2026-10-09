// Graph view tests (ticket 3.4): the pure layout and style checks of webview/, in plain Node.
//   npm run test:webview
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	// The repository root, so the tests can read src/test/fixtures/models.
	root: fileURLToPath(new URL('..', import.meta.url)),
	test: {
		include: ['webview/**/*.test.ts'],
		environment: 'node',
	},
});
