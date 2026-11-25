#!/usr/bin/env node
// Story 8.2 (AD-26): writes `assets/agent-runtime.json`, the assistant runtime the extension lets the user
// install (Install assistant runtime…): the Claude Agent SDK at the exact version package.json pins, and
// every platform binary package the SDK lists, each with its tarball's path on the npm registry, its
// version and its sha512 `integrity`, copied from package-lock.json. The extension never ships these
// packages: it downloads the two a platform needs, checks them against this file, and unpacks them into
// its global storage.
//
//   node scripts/gen-agent-runtime.mjs           write assets/agent-runtime.json
//   node scripts/gen-agent-runtime.mjs --check   exit 1 when the file is not what would be written (CI)
//
// `manifestFrom(pkg, lock)` is exported for the unit tests.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SDK = '@anthropic-ai/claude-agent-sdk';
export const REGISTRY = 'https://registry.npmjs.org';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST = path.join(REPO, 'assets', 'agent-runtime.json');
const EXACT = /^\d+\.\d+\.\d+$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** One package's entry: its tarball's path on the registry, its version and integrity, from the lockfile. */
function entryOf(lock, name, version) {
	const entry = lock.packages?.[`node_modules/${name}`];
	if (!entry) {
		throw new Error(`package-lock.json has no node_modules/${name}`);
	}
	if (entry.version !== version) {
		throw new Error(`package-lock.json has ${name}@${entry.version}, not ${version}`);
	}
	if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(`${REGISTRY}/`)) {
		throw new Error(`${name}'s resolved URL is not on ${REGISTRY}: ${entry.resolved}`);
	}
	if (typeof entry.integrity !== 'string' || !SHA512.test(entry.integrity)) {
		throw new Error(`${name} has no sha512 integrity in package-lock.json`);
	}
	return { version, path: entry.resolved.slice(REGISTRY.length), integrity: entry.integrity };
}

/** The manifest for package.json and package-lock.json (parsed); throws when they do not give one. */
export function manifestFrom(pkg, lock) {
	const sdkVersion = pkg.dependencies?.[SDK];
	if (typeof sdkVersion !== 'string' || !EXACT.test(sdkVersion)) {
		throw new Error(`package.json must pin ${SDK} to an exact x.y.z version (it has ${JSON.stringify(sdkVersion)})`);
	}
	const sdkEntry = lock.packages?.[`node_modules/${SDK}`];
	const platforms = Object.keys(sdkEntry?.optionalDependencies ?? {}).filter((n) => n.startsWith(`${SDK}-`)).sort();
	if (platforms.length === 0) {
		throw new Error(`package-lock.json lists no platform package for ${SDK}`);
	}
	const packages = { [SDK]: entryOf(lock, SDK, sdkVersion) };
	for (const name of platforms) {
		if (sdkEntry.optionalDependencies[name] !== sdkVersion) {
			throw new Error(`${SDK} wants ${name}@${sdkEntry.optionalDependencies[name]}, not ${sdkVersion}`);
		}
		packages[name] = entryOf(lock, name, sdkVersion);
	}
	return { sdkVersion, registry: REGISTRY, packages };
}

/** The file's text for a manifest. */
export function manifestText(manifest) {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

function main() {
	const args = process.argv.slice(2);
	if (args.some((a) => a !== '--check')) {
		console.error('gen-agent-runtime: usage: node scripts/gen-agent-runtime.mjs [--check]');
		process.exit(1);
	}
	let text;
	try {
		const read = (f) => JSON.parse(fs.readFileSync(path.join(REPO, f), 'utf8'));
		text = manifestText(manifestFrom(read('package.json'), read('package-lock.json')));
	} catch (err) {
		console.error(`gen-agent-runtime: ${err.message}`);
		process.exit(1);
	}
	if (args.includes('--check')) {
		let current = '';
		try {
			current = fs.readFileSync(MANIFEST, 'utf8');
		} catch {
			// Missing: not the same.
		}
		if (current !== text) {
			console.error('gen-agent-runtime: assets/agent-runtime.json is out of date; run node scripts/gen-agent-runtime.mjs');
			process.exit(1);
		}
		console.log('gen-agent-runtime: assets/agent-runtime.json matches package.json and package-lock.json.');
		return;
	}
	fs.writeFileSync(MANIFEST, text);
	console.log(`gen-agent-runtime: wrote assets/agent-runtime.json (${SDK}@${JSON.parse(text).sdkVersion}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
	main();
}
