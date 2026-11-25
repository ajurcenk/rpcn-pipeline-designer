// Ticket 6.2 (AC 2), story 8.2: checks what the VSIX holds. There is one VSIX, for every platform; it
// never carries Anthropic's code (the user installs the assistant runtime from VS Code):
//   - the @platformatic/kafka CRC-32C wasm (`extension/dist/native.wasm`) and no native module (`.node`);
//   - the bundled skills (`extension/assets/rpcn-skills/PIN`, `.claude-plugin/plugin.json` and the three
//     `skills/<name>/SKILL.md`);
//   - the runtime manifest (`extension/assets/agent-runtime.json`), for the exact `x.y.z` SDK pin of the
//     VSIX's own `package.json`, listing the platform packages at that version with sha512 integrities;
//   - no `@anthropic-ai/claude-agent-sdk*` file anywhere, no `claude` binary, no `node_modules/`, and no
//     TargetPlatform in the manifest.
// Prints the file count and the size; exits 1 when anything is wrong (each problem on its own line,
// unreadable zips and JSON included).
//
//   node scripts/check-vsix.mjs [--vsix <file>]
//
// Without `--vsix` it packages one first, as CI does (`vsce package --no-dependencies`, which runs
// vscode:prepublish). `zipEntries` and `problemsOf` are exported for the unit tests.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { pathToFileURL } from 'url';

export const SDK = '@anthropic-ai/claude-agent-sdk';
const EXACT = /^\d+\.\d+\.\d+$/;

/**
 * The entries of a zip's central directory (name, and a reader of the file's bytes), and what could not be
 * read (`problems`): no end record, ZIP64, a bad record, a compression method other than stored or deflate.
 */
export function zipEntries(buf) {
	const problems = [];
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) {
		return { entries: [], problems: ['the file is not a zip (no end of central directory)'] };
	}
	const count = buf.readUInt16LE(eocd + 10);
	let at = buf.readUInt32LE(eocd + 16);
	if (count === 0xffff || at === 0xffffffff) {
		return { entries: [], problems: ['the zip is ZIP64, which this check does not read'] };
	}
	const entries = [];
	for (let n = 0; n < count; n++) {
		if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) {
			problems.push(`the zip's central directory is bad at entry ${n}`);
			break;
		}
		const method = buf.readUInt16LE(at + 10);
		const compressedSize = buf.readUInt32LE(at + 20);
		const size = buf.readUInt32LE(at + 24);
		const nameLength = buf.readUInt16LE(at + 28);
		const extraLength = buf.readUInt16LE(at + 30);
		const commentLength = buf.readUInt16LE(at + 32);
		const local = buf.readUInt32LE(at + 42);
		const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
		if (compressedSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
			problems.push(`${name} is a ZIP64 entry, which this check does not read`);
		} else if (method !== 0 && method !== 8) {
			problems.push(`${name} uses compression method ${method} (only stored and deflate are read)`);
		}
		entries.push({
			name,
			read: () => {
				if (method !== 0 && method !== 8) {
					throw new Error(`compression method ${method}`);
				}
				const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
				const data = buf.subarray(start, start + compressedSize);
				return method === 0 ? data : zlib.inflateRawSync(data);
			},
		});
		at += 46 + nameLength + extraLength + commentLength;
	}
	return { entries, problems };
}

/** An entry's JSON, or a problem line in `problems` and `undefined`. */
function jsonOf(entry, problems) {
	if (!entry) {
		return undefined;
	}
	try {
		return JSON.parse(entry.read().toString('utf8'));
	} catch (err) {
		problems.push(`${entry.name} is not readable JSON (${err.message})`);
		return undefined;
	}
}

/** What is wrong with the VSIX's entries (empty: nothing). */
export function problemsOf(entries) {
	const names = entries.map((e) => e.name);
	const byName = new Map(entries.map((e) => [e.name, e]));
	const problems = [];
	const required = [
		'extension/dist/native.wasm',
		'extension/package.json',
		'extension/assets/rpcn-skills/PIN',
		'extension/assets/rpcn-skills/.claude-plugin/plugin.json',
		...['rpcn-design', 'rpcn-author', 'rpcn-test'].map((skill) => `extension/assets/rpcn-skills/skills/${skill}/SKILL.md`),
		'extension/assets/agent-runtime.json',
	];
	for (const file of required.filter((f) => !names.includes(f))) {
		problems.push(`${file} is missing`);
	}
	for (const name of names.filter((n) => n.endsWith('.node'))) {
		problems.push(`${name} is a native module`);
	}
	for (const name of names) {
		const parts = name.split('/');
		if (parts.some((p, i) => p === '@anthropic-ai' && (parts[i + 1] ?? '').startsWith('claude-agent-sdk')) || parts.some((p) => p.startsWith('claude-agent-sdk'))) {
			problems.push(`${name} is Anthropic's Agent SDK (the user installs it; the VSIX never carries it)`);
		} else if (parts.at(-1) === 'claude' || parts.at(-1) === 'claude.exe') {
			problems.push(`${name} looks like a Claude Code binary`);
		} else if (parts.includes('node_modules')) {
			problems.push(`${name} is in a node_modules folder`);
		}
	}
	const manifest = (() => {
		try {
			return byName.get('extension.vsixmanifest')?.read().toString('utf8') ?? '';
		} catch {
			return '';
		}
	})();
	const platform = /<Identity\b[^>]*\bTargetPlatform="([^"]*)"/.exec(manifest)?.[1];
	if (platform !== undefined) {
		problems.push(`the VSIX names TargetPlatform=${platform}; there is one VSIX for every platform`);
	}
	const pkg = jsonOf(byName.get('extension/package.json'), problems);
	const pinned = pkg?.dependencies?.[SDK];
	if (pkg && (typeof pinned !== 'string' || !EXACT.test(pinned))) {
		problems.push(`extension/package.json does not pin ${SDK} to an exact x.y.z version (it has ${JSON.stringify(pinned)})`);
	}
	const runtime = jsonOf(byName.get('extension/assets/agent-runtime.json'), problems);
	if (runtime && typeof pinned === 'string') {
		if (runtime.sdkVersion !== pinned) {
			problems.push(`extension/assets/agent-runtime.json is for ${runtime.sdkVersion}, not the pinned ${pinned}`);
		}
		if (runtime.packages?.[SDK]?.version !== pinned || !String(runtime.packages?.[SDK]?.integrity ?? '').startsWith('sha512-')) {
			problems.push(`extension/assets/agent-runtime.json has no ${SDK}@${pinned} with a sha512 integrity`);
		}
		const platforms = Object.entries(runtime.packages ?? {}).filter(([name]) => name.startsWith(`${SDK}-`));
		if (platforms.length === 0) {
			problems.push('extension/assets/agent-runtime.json lists no platform package');
		}
		for (const [name, entry] of platforms.filter(([, e]) => e?.version !== pinned || !/^sha512-/.test(String(e?.integrity ?? '')))) {
			problems.push(`extension/assets/agent-runtime.json has ${name} without ${pinned} and a sha512 integrity (${JSON.stringify(entry)})`);
		}
	}
	return problems;
}

function main() {
	const args = process.argv.slice(2);
	let vsix;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--vsix' && args[i + 1]) {
			vsix = path.resolve(args[++i]);
		} else {
			console.error(`check:vsix: unknown argument ${args[i]}; usage: node scripts/check-vsix.mjs [--vsix <file>]`);
			process.exit(1);
		}
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-vsix-'));
	try {
		if (!vsix) {
			vsix = path.join(dir, 'extension.vsix');
			execFileSync('npx', ['vsce', 'package', '--no-dependencies', '--out', vsix], { stdio: ['ignore', 'ignore', 'inherit'] });
		}
		const buf = fs.readFileSync(vsix);
		const read = zipEntries(buf);
		const problems = [...read.problems, ...problemsOf(read.entries)];
		const size = `${(buf.length / 1024 / 1024).toFixed(1)} MB`;
		if (problems.length > 0) {
			console.error(`check:vsix failed (${path.basename(vsix)}):\n  ${problems.join('\n  ')}`);
			process.exitCode = 1;
		} else {
			console.log(`check:vsix: ${path.basename(vsix)}, ${read.entries.length} files, ${size}: no Anthropic package, the runtime manifest for the exact SDK pin, the skills, native.wasm, no .node file.`);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
	main();
}
