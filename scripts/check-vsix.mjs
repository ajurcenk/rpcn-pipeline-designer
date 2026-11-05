// Ticket 6.2 (AC 2): packages the extension to a temporary .vsix and checks what it holds: the
// @platformatic/kafka CRC-32C wasm (`extension/dist/native.wasm`) and no native module (`.node`).
// Exits 1 when either is wrong. `npm run check:vsix` (it runs `vsce package`, so `vscode:prepublish`
// rebuilds dist/ for production).
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The file names in a zip's central directory. */
function zipEntries(buf) {
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) {
		throw new Error('not a zip file');
	}
	const count = buf.readUInt16LE(eocd + 10);
	let at = buf.readUInt32LE(eocd + 16);
	const names = [];
	for (let n = 0; n < count; n++) {
		if (buf.readUInt32LE(at) !== 0x02014b50) {
			throw new Error('bad central directory');
		}
		const nameLength = buf.readUInt16LE(at + 28);
		const extraLength = buf.readUInt16LE(at + 30);
		const commentLength = buf.readUInt16LE(at + 32);
		names.push(buf.toString('utf8', at + 46, at + 46 + nameLength));
		at += 46 + nameLength + extraLength + commentLength;
	}
	return names;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-vsix-'));
try {
	const out = path.join(dir, 'extension.vsix');
	execFileSync('npx', ['vsce', 'package', '--out', out], { stdio: ['ignore', 'ignore', 'inherit'] });
	const names = zipEntries(fs.readFileSync(out));
	const problems = [];
	if (!names.includes('extension/dist/native.wasm')) {
		problems.push('extension/dist/native.wasm is missing');
	}
	for (const name of names.filter((n) => n.endsWith('.node'))) {
		problems.push(`${name} is a native module`);
	}
	if (problems.length > 0) {
		console.error(`check:vsix failed:\n  ${problems.join('\n  ')}`);
		process.exitCode = 1;
	} else {
		console.log(`check:vsix: ${names.length} files, extension/dist/native.wasm present, no .node file.`);
	}
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
