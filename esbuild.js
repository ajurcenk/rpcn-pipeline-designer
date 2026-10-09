const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Builds in flight across both contexts: "[watch] build started" prints when the first one starts
// and "[watch] build finished" only when the last one ends, so a background task's problem
// matcher sees one build that ends after both dist/extension.js and dist/webview.js are written.
let inFlight = 0;

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			if (inFlight++ === 0) {
				console.log('[watch] build started');
			}
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			if (--inFlight === 0) {
				console.log('[watch] build finished');
			}
		});
	},
};

async function main() {
	const shared = {
		bundle: true,
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	};
	// The extension host bundle (Node, CommonJS).
	const extension = await esbuild.context({
		...shared,
		entryPoints: [
			'src/extension.ts'
		],
		format: 'cjs',
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
	});
	// The graph webview bundle (browser, one IIFE script; AD-4, AD-15).
	const webview = await esbuild.context({
		...shared,
		entryPoints: [
			'webview/src/main.tsx'
		],
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		jsx: 'automatic',
		outfile: 'dist/webview.js',
		// elk.bundled.js requires `web-worker` only when given a `workerUrl`; the graph never is (AD-4).
		external: ['web-worker'],
		// The codicon font referenced by @vscode/codicons' CSS lands next to it as dist/codicon.ttf.
		loader: { '.ttf': 'file' },
		assetNames: '[name]',
		define: {
			'process.env.NODE_ENV': production ? '"production"' : '"development"',
		},
	});
	const contexts = [extension, webview];
	if (watch) {
		await Promise.all(contexts.map((ctx) => ctx.watch()));
	} else {
		await Promise.all(contexts.map((ctx) => ctx.rebuild()));
		await Promise.all(contexts.map((ctx) => ctx.dispose()));
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
