const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Builds in flight across all contexts: "[watch] build started" prints when the first one starts
// and "[watch] build finished" only when the last one ends, so a background task's problem
// matcher sees one build that ends after dist/extension.js, dist/webview.js, dist/bloblang.js and dist/logs.js are written.
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

/**
 * Ticket 6.2 (AD-24): @platformatic/kafka loads the optional native `@node-rs/crc32` when it can be
 * required, else its WebAssembly CRC-32C. The extension ships no native module, so the bundle's copy
 * of that lookup always fails and the wasm one is used (also in a checkout whose node_modules has the
 * native package). The build fails when the library's lookup is no longer where this expects it.
 * @type {import('esbuild').Plugin}
 */
const noNativeCrc32Plugin = {
	name: 'no-native-crc32',
	setup(build) {
		build.onLoad({ filter: /[\\/]@platformatic[\\/]kafka[\\/]dist[\\/]protocol[\\/]crc32c\.js$/ }, async (args) => {
			const source = await fs.promises.readFile(args.path, 'utf8');
			const lookup = "require('@node-rs/crc32')";
			if (!source.includes(lookup)) {
				return { errors: [{ text: `${args.path}: ${lookup} not found; check how this @platformatic/kafka version loads its native CRC-32C` }] };
			}
			return { contents: source.replace(lookup, "(() => { throw new Error('@node-rs/crc32 is not shipped'); })()"), loader: 'js' };
		});
	},
};

/**
 * Ticket 6.2: @platformatic/kafka reads its CRC-32C wasm from `new URL('../dist/native.wasm',
 * import.meta.url)`; with `import.meta.url` defined from the bundle's own file, that is
 * `dist/native.wasm`, copied there on every build.
 * @type {import('esbuild').Plugin}
 */
const copyWasmPlugin = {
	name: 'copy-native-wasm',
	setup(build) {
		build.onEnd(async (result) => {
			if (result.errors.length > 0) {
				return;
			}
			const from = path.join(path.dirname(require.resolve('@platformatic/wasm-utils')), 'native.wasm');
			await fs.promises.mkdir('dist', { recursive: true });
			await fs.promises.copyFile(from, path.join('dist', 'native.wasm'));
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
		// Ticket 6.2 (AD-24): @platformatic/kafka is ESM and reads files beside itself through
		// `import.meta.url`, which a CommonJS bundle lacks: it is this file's own URL.
		define: { 'import.meta.url': '__rpcn_import_meta_url' },
		banner: { js: "var __rpcn_import_meta_url = require('url').pathToFileURL(__filename).href;" },
		plugins: [noNativeCrc32Plugin, copyWasmPlugin, ...shared.plugins],
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
	// The Bloblang test panel's webview bundle (browser, one IIFE script; ticket 4.2, AD-15).
	const bloblang = await esbuild.context({
		...shared,
		entryPoints: [
			'webview/src/bloblang/main.tsx'
		],
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		jsx: 'automatic',
		outfile: 'dist/bloblang.js',
		define: {
			'process.env.NODE_ENV': production ? '"production"' : '"development"',
		},
	});
	// The Pipeline Logs tab's webview bundle (browser, one IIFE script; ticket 6.2).
	const logs = await esbuild.context({
		...shared,
		entryPoints: [
			'webview/src/logs/main.tsx'
		],
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		jsx: 'automatic',
		outfile: 'dist/logs.js',
		define: {
			'process.env.NODE_ENV': production ? '"production"' : '"development"',
		},
	});
	const contexts = [extension, webview, bloblang, logs];
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
