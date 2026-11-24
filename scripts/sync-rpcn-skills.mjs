#!/usr/bin/env node
// Story 8.1: refreshes the bundled, read-only copy of the `rpcn-skills` project in assets/rpcn-skills/
// (its `skills/` and `.claude-plugin/` only) from a ref of a local checkout, and writes the commit to
// assets/rpcn-skills/PIN. It is a copy: nothing is ever written to the skills checkout.
//
//   node scripts/sync-rpcn-skills.mjs <path to the rpcn-skills checkout> <ref>
//
// Refused, with nothing changed here: a checkout that is not a git repository, a ref that does not name a
// commit there, or a checkout with uncommitted changes in skills/ or .claude-plugin/ (the copy must be
// what the commit holds).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(REPO, 'assets', 'rpcn-skills');
const PARTS = ['skills', '.claude-plugin'];

function fail(message) {
	console.error(`sync-rpcn-skills: ${message}`);
	process.exit(1);
}

const [checkoutArg, ref] = process.argv.slice(2);
if (!checkoutArg || !ref) {
	fail('usage: node scripts/sync-rpcn-skills.mjs <rpcn-skills checkout> <ref>');
}
const checkout = path.resolve(checkoutArg);
const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
	git('rev-parse', '--git-dir');
} catch {
	fail(`${checkout} is not a git checkout`);
}
let commit;
try {
	commit = git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).trim();
} catch {
	fail(`${ref} does not name a commit in ${checkout}`);
}
if (!commit) {
	fail(`${ref} does not name a commit in ${checkout}`);
}
// The copy is the commit's, but a dirty skills/ or .claude-plugin/ means the checkout holds something the
// PIN would not name: refused, so the copy is never mistaken for the working tree.
if (git('status', '--porcelain', '--', ...PARTS).trim() !== '') {
	fail(`${checkout} has uncommitted changes in ${PARTS.join(' or ')}; commit or stash them first (or sync from a clean clone)`);
}
for (const part of PARTS) {
	if (git('ls-tree', '--name-only', commit, part).trim() === '') {
		fail(`${commit} has no ${part}/`);
	}
}

// Extracted into a temporary folder first, so a failure leaves the current copy as it is.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-skills-sync-'));
try {
	const archive = path.join(tmp, 'skills.tar');
	execFileSync('git', ['-C', checkout, 'archive', '--format=tar', '-o', archive, commit, ...PARTS], { stdio: 'inherit' });
	const out = path.join(tmp, 'out');
	fs.mkdirSync(out);
	execFileSync('tar', ['-x', '-f', archive, '-C', out], { stdio: 'inherit' });
	fs.writeFileSync(path.join(out, 'PIN'), `${commit}\n`);
	// Review 25: the new copy is staged beside the old one, complete, then swapped in by renames, so a
	// failure never leaves a half-copied assets/rpcn-skills.
	const staged = `${DEST}.sync-new`;
	const old = `${DEST}.sync-old`;
	fs.rmSync(staged, { recursive: true, force: true });
	fs.rmSync(old, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(DEST), { recursive: true });
	fs.cpSync(out, staged, { recursive: true });
	if (fs.existsSync(DEST)) {
		fs.renameSync(DEST, old);
	}
	try {
		fs.renameSync(staged, DEST);
	} catch (err) {
		if (fs.existsSync(old)) {
			fs.renameSync(old, DEST);
		}
		throw err;
	}
	fs.rmSync(old, { recursive: true, force: true });
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`sync-rpcn-skills: assets/rpcn-skills is ${commit} (${PARTS.join(', ')})`);
