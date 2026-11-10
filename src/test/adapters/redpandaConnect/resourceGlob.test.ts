import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expandResourceEntry, globSegmentRegExp } from '../../../adapters/redpandaConnect/resourceGlob';

// Ticket 46: a `resourceFiles` entry expanded as the binary's Go `filepath.Glob` (the corpus
// harness checks the same against the pinned binaries).
suite('adapters/redpandaConnect resourceGlob', () => {
	const matches = (pattern: string, name: string) => globSegmentRegExp(pattern, false)?.test(name);

	test('*, ? and classes within one segment; \\ escapes', () => {
		assert.strictEqual(matches('*.yaml', '.hidden.yaml'), true, 'a dot file matches, as in Go');
		assert.strictEqual(matches('r?.yaml', 'r1.yaml'), true);
		assert.strictEqual(matches('r?.yaml', 'r12.yaml'), false);
		assert.strictEqual(matches('r[1-2].yaml', 'r2.yaml'), true);
		assert.strictEqual(matches('r[1-2].yaml', 'r3.yaml'), false);
		assert.strictEqual(matches('r[^1].yaml', 'r2.yaml'), true);
		assert.strictEqual(matches('r[^1].yaml', 'r1.yaml'), false);
		assert.strictEqual(matches('r[ab].yaml', 'rb.yaml'), true);
		assert.strictEqual(matches('a\\*b', 'a*b'), true);
		assert.strictEqual(matches('a\\*b', 'axb'), false);
		assert.strictEqual(matches('r[2-1]', 'r1'), false, 'a reversed range matches nothing');
	});

	test('malformed patterns match nothing (Go\'s ErrBadPattern)', () => {
		for (const bad of ['r[1', 'r[]', 'r[-a]', 'r[a-]', 'a\\']) {
			assert.strictEqual(globSegmentRegExp(bad, false), undefined, bad);
		}
	});

	test('expandResourceEntry: the path itself without glob characters; else the existing matches, sorted per directory', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-glob-'));
		try {
			fs.mkdirSync(path.join(dir, 'a'));
			fs.mkdirSync(path.join(dir, 'b'));
			for (const f of ['a/r2.yaml', 'a/r1.yaml', 'b/r1.yaml', 'a/x.txt']) {
				fs.writeFileSync(path.join(dir, f), '');
			}
			assert.deepStrictEqual(expandResourceEntry(path.join(dir, 'gone.yaml')), [path.join(dir, 'gone.yaml')]);
			assert.deepStrictEqual(expandResourceEntry(path.join(dir, 'a', 'r*.yaml')), [path.join(dir, 'a', 'r1.yaml'), path.join(dir, 'a', 'r2.yaml')]);
			assert.deepStrictEqual(expandResourceEntry(path.join(dir, '?', 'r1.yaml')), [path.join(dir, 'a', 'r1.yaml'), path.join(dir, 'b', 'r1.yaml')]);
			assert.deepStrictEqual(expandResourceEntry(path.join(dir, 'none*.yaml')), [], 'no match: none');
			assert.deepStrictEqual(expandResourceEntry(path.join(dir, 'r[1')), [], 'malformed: none');
			assert.deepStrictEqual(expandResourceEntry(path.join(dir, '**', 'r1.yaml')), [path.join(dir, 'a', 'r1.yaml'), path.join(dir, 'b', 'r1.yaml')],
				'** is * (one segment), not a recursive match');
			assert.deepStrictEqual(expandResourceEntry(path.join(dir, '**.yaml')), [], 'not into subdirectories');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
