// Corpus harness only (ticket 1.7): plain Node, outside the mocha / VS Code suite and its `tsc` build.
//   npm run test:corpus          compare every corpus config against its recorded lint output
//   npm run test:corpus:record   rewrite the records (`--mode record`)
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
	test: {
		include: ['test/corpus/**/*.test.ts'],
		environment: 'node',
		// One line per config and version, plus the skip message when a binary is missing locally.
		reporters: ['verbose'],
		testTimeout: 60_000,
		env: { CORPUS_RECORD: mode === 'record' ? '1' : '' },
	},
}));
