import * as assert from 'assert';
import {
	confirmsSaveAs, isSaveAsCandidate, overwrittenBy, PENDING_RENAME_MS, PendingRenames, renamedKey, renamedThrough, renameFate, renameWinners,
	SAVE_AS_CLOSE_MS, SAVE_AS_WINDOW_MS, saveAsExpired, type Rename,
} from '../../../adapters/graphPanel/tabs';

const k = (p: string) => `file:///d/${p}`;

suite('adapters/graphPanel tabs: renames (3.10, F7)', () => {
	test('renamedKey: a file, a folder prefix, a near name that is no prefix, no match', () => {
		assert.strictEqual(renamedKey(k('a.yaml'), [{ from: k('a.yaml'), to: k('b.yaml') }]), k('b.yaml'));
		const folder = [{ from: k('a'), to: k('z') }];
		assert.strictEqual(renamedKey(k('a/x.yaml'), folder), k('z/x.yaml'));
		assert.strictEqual(renamedKey(k('a/sub/x.yaml'), [{ from: `${k('a')}/`, to: k('z') }]), k('z/sub/x.yaml'));
		assert.strictEqual(renamedKey(k('ab'), folder), undefined, '/d/ab is not inside /d/a');
		assert.strictEqual(renamedKey(k('ab/x.yaml'), folder), undefined);
		assert.strictEqual(renamedKey(k('c.yaml'), folder), undefined);
		// The first rename that matches wins (no chaining).
		assert.strictEqual(renamedKey(k('a.yaml'), [{ from: k('a.yaml'), to: k('t.yaml') }, { from: k('t.yaml'), to: k('b.yaml') }]), k('t.yaml'));
	});

	test('renamedThrough: a file, a folder prefix and a near name, applied in order', () => {
		assert.strictEqual(renamedThrough(k('a.yaml'), [{ from: k('a.yaml'), to: k('b.yaml') }]), k('b.yaml'));
		assert.strictEqual(renamedThrough(k('a/x.yaml'), [{ from: k('a'), to: k('z') }]), k('z/x.yaml'));
		assert.strictEqual(renamedThrough(k('ab'), [{ from: k('a'), to: k('z') }]), undefined);
		assert.strictEqual(renamedThrough(k('c.yaml'), [{ from: k('a.yaml'), to: k('b.yaml') }]), undefined);
	});

	test('renamedThrough: a chain b→c, a→b puts each file at its own new name', () => {
		const chain = [{ from: k('b.yaml'), to: k('c.yaml') }, { from: k('a.yaml'), to: k('b.yaml') }];
		assert.strictEqual(renamedThrough(k('a.yaml'), chain), k('b.yaml'));
		assert.strictEqual(renamedThrough(k('b.yaml'), chain), k('c.yaml'));
		assert.strictEqual(renamedThrough(k('c.yaml'), chain), undefined);
	});

	test('renamedThrough: a swap through a temporary name (a→t, b→a, t→b)', () => {
		const swap = [{ from: k('a.yaml'), to: k('t.yaml') }, { from: k('b.yaml'), to: k('a.yaml') }, { from: k('t.yaml'), to: k('b.yaml') }];
		assert.strictEqual(renamedThrough(k('a.yaml'), swap), k('b.yaml'));
		assert.strictEqual(renamedThrough(k('b.yaml'), swap), k('a.yaml'));
		assert.strictEqual(renamedThrough(k('t.yaml'), swap), k('b.yaml'));
	});

	test('renamedThrough: a rename back to the original name is a rename to the same key', () => {
		const back = [{ from: k('a.yaml'), to: k('t.yaml') }, { from: k('t.yaml'), to: k('a.yaml') }];
		assert.strictEqual(renamedThrough(k('a.yaml'), back), k('a.yaml'));
	});
});

suite('adapters/graphPanel tabs: rename collisions (ticket 17)', () => {
	const r = (from: string, to: string): Rename => ({ from: k(from), to: k(to) });

	test('two movers onto one name (a→x, c→x): c wins, whatever the order of the keys', () => {
		const batch = [r('a.yaml', 'x.yaml'), r('c.yaml', 'x.yaml')];
		const expected = new Map([[k('x.yaml'), k('c.yaml')]]);
		assert.deepStrictEqual(renameWinners([k('a.yaml'), k('c.yaml')], batch), expected);
		assert.deepStrictEqual(renameWinners([k('c.yaml'), k('a.yaml')], batch), expected);
		assert.deepStrictEqual(renameFate(k('a.yaml'), batch), { to: k('x.yaml'), destroyed: true });
		assert.deepStrictEqual(renameFate(k('c.yaml'), batch), { to: k('x.yaml'), destroyed: false });
	});

	test('a later rename of a key not passed lands on the name (a→x, c→x, only a): a wins nowhere', () => {
		assert.deepStrictEqual(renameWinners([k('a.yaml')], [r('a.yaml', 'x.yaml'), r('c.yaml', 'x.yaml')]), new Map());
	});

	test('a→b, b→c: a overwrote b, then moved on to c: a wins at c, b is destroyed', () => {
		const batch = [r('a.yaml', 'b.yaml'), r('b.yaml', 'c.yaml')];
		assert.deepStrictEqual(renameWinners([k('b.yaml'), k('a.yaml')], batch), new Map([[k('c.yaml'), k('a.yaml')]]));
		assert.deepStrictEqual(renameFate(k('b.yaml'), batch), { to: k('c.yaml'), destroyed: true });
		assert.ok(!overwrittenBy(k('b.yaml'), batch), 'b is moved (destroyed, not overwritten in place)');
	});

	test('a chain and a swap destroy nothing', () => {
		const chain = [r('b.yaml', 'c.yaml'), r('a.yaml', 'b.yaml')];
		assert.deepStrictEqual(renameWinners([k('a.yaml'), k('b.yaml')], chain), new Map([[k('b.yaml'), k('a.yaml')], [k('c.yaml'), k('b.yaml')]]));
		const swap = [r('a.yaml', 't.yaml'), r('b.yaml', 'a.yaml'), r('t.yaml', 'b.yaml')];
		assert.deepStrictEqual(renameWinners([k('a.yaml'), k('b.yaml')], swap), new Map([[k('a.yaml'), k('b.yaml')], [k('b.yaml'), k('a.yaml')]]));
		assert.ok(!overwrittenBy(k('a.yaml'), swap) && !overwrittenBy(k('b.yaml'), swap));
	});

	test('a folder overwrite (f→g): g\'s files are overwritten, f\'s win at their new names', () => {
		const batch = [r('f', 'g')];
		assert.ok(overwrittenBy(k('g/b.yaml'), batch));
		assert.ok(overwrittenBy(k('g/other.yaml'), batch), 'the whole folder is replaced');
		assert.ok(!overwrittenBy(k('gh/b.yaml'), batch), 'a near name is no prefix');
		assert.deepStrictEqual(renameWinners([k('f/b.yaml'), k('g/b.yaml')], batch), new Map([[k('g/b.yaml'), k('f/b.yaml')]]));
	});

	test('overwrittenBy: a file a rename lands on, a file moved away, a file left alone', () => {
		const batch = [r('a.yaml', 'b.yaml')];
		assert.ok(overwrittenBy(k('b.yaml'), batch));
		assert.ok(!overwrittenBy(k('a.yaml'), batch), 'moved away');
		assert.ok(!overwrittenBy(k('c.yaml'), batch));
		assert.ok(!overwrittenBy(k('b.yaml'), [r('b.yaml', 'c.yaml'), r('a.yaml', 'b.yaml')]), 'moved away before the other lands');
	});
});

suite('adapters/graphPanel tabs: pending renames (4.13)', () => {
	/** A PendingRenames on a fake clock, with the expired renames it reported. */
	function pending(expiryMs = 1_000) {
		const clock = { now: 0 };
		const expired: Rename[][] = [];
		const renames = new PendingRenames(expiryMs, () => clock.now, (gone) => expired.push([...gone]));
		return { renames, clock, expired };
	}
	const ab = { from: k('a.yaml'), to: k('b.yaml') };
	const cd = { from: k('c'), to: k('d') };

	test('the default time limit is 30 s', () => {
		assert.strictEqual(PENDING_RENAME_MS, 30_000);
	});

	test('RENAME_OK: an announced rename is pending until it is reported; renaming and creating match files and folders', () => {
		const { renames, clock, expired } = pending();
		renames.announce([ab, cd]);
		assert.deepStrictEqual(renames.all, [ab, cd]);
		assert.ok(renames.renaming(k('a.yaml')));
		assert.ok(renames.renaming(k('c/x.yaml')), 'a file in a renamed folder');
		assert.ok(!renames.renaming(k('ab.yaml')));
		assert.ok(renames.creating(k('b.yaml')));
		assert.ok(renames.creating(k('d/x.yaml')));
		assert.ok(!renames.creating(k('a.yaml')));
		clock.now = 999;
		renames.report([ab]);
		assert.deepStrictEqual(renames.all, [cd], 'only the reported one goes');
		assert.deepStrictEqual(expired, []);
	});

	test('a report matches from and to exactly: another rename of the same file stays', () => {
		const { renames } = pending();
		renames.announce([ab]);
		renames.report([{ from: k('a.yaml'), to: k('z.yaml') }]);
		assert.deepStrictEqual(renames.all, [ab]);
	});

	test('RENAME_NEVER: an unreported rename expires at the time limit, once, and is handed to onExpired', () => {
		const { renames, clock, expired } = pending();
		renames.announce([ab]);
		clock.now = 500;
		renames.announce([cd]);
		clock.now = 999;
		assert.deepStrictEqual(renames.all, [ab, cd], 'not yet');
		clock.now = 1_000;
		assert.deepStrictEqual(renames.all, [cd], 'the first expired');
		assert.ok(!renames.renaming(k('a.yaml')));
		assert.ok(!renames.creating(k('b.yaml')));
		assert.deepStrictEqual(expired, [[ab]]);
		clock.now = 1_500;
		renames.prune();
		assert.deepStrictEqual(renames.all, []);
		assert.deepStrictEqual(expired, [[ab], [cd]], 'each once');
		// A late report of an expired rename changes nothing.
		renames.report([ab]);
		assert.deepStrictEqual(expired, [[ab], [cd]]);
	});

	test('a rename announced again after it expired is pending again, from its new announcement', () => {
		const { renames, clock } = pending();
		renames.announce([ab]);
		clock.now = 1_000;
		renames.announce([ab]);
		assert.deepStrictEqual(renames.all, [ab]);
		clock.now = 1_999;
		assert.deepStrictEqual(renames.all, [ab]);
		clock.now = 2_000;
		assert.deepStrictEqual(renames.all, []);
	});
});

suite('adapters/graphPanel tabs: Save As (ticket 12)', () => {
	const now = 100_000;
	const recent = (key: string, created: number | undefined, saved: number | undefined) => new Map([[key, { created, saved }]]);
	const candidate = (from: string, to: string) => ({ from, to, openedAt: now });

	test('SAVED: b created and saved just now, its next tab a.yaml; a\'s tab closes soon after, b still open', () => {
		assert.ok(isSaveAsCandidate(k('b.yaml'), k('a.yaml'), recent(k('b.yaml'), now - 50, now - 20), now));
		assert.ok(confirmsSaveAs(candidate(k('a.yaml'), k('b.yaml')), k('a.yaml'), now + 20, true));
	});

	test('UNTITLED: the next tab is untitled', () => {
		const untitled = 'untitled:Untitled-1';
		assert.ok(isSaveAsCandidate(k('c.yaml'), untitled, recent(k('c.yaml'), now - 10, now - 5), now));
		assert.ok(confirmsSaveAs(candidate(untitled, k('c.yaml')), untitled, now + 8, true));
	});

	test('NOT_SAVE_AS: created but not saved, saved but not created, nothing recorded', () => {
		assert.ok(!isSaveAsCandidate(k('b.yaml'), k('a.yaml'), recent(k('b.yaml'), now - 10, undefined), now));
		assert.ok(!isSaveAsCandidate(k('b.yaml'), k('a.yaml'), recent(k('b.yaml'), undefined, now - 10), now));
		assert.ok(!isSaveAsCandidate(k('b.yaml'), k('a.yaml'), new Map(), now));
	});

	test('NOT_SAVE_AS: no next text tab, or the next tab is the same URI', () => {
		const at = recent(k('b.yaml'), now - 10, now - 5);
		assert.ok(!isSaveAsCandidate(k('b.yaml'), undefined, at, now));
		assert.ok(!isSaveAsCandidate(k('b.yaml'), k('b.yaml'), at, now));
	});

	test('NOT_SAVE_AS: the source stays open, another tab closes, the new tab closed first', () => {
		const c = candidate(k('a.yaml'), k('b.yaml'));
		assert.ok(!confirmsSaveAs(c, k('x.yaml'), now + 10, true), 'another file\'s tab closed');
		assert.ok(!confirmsSaveAs(c, k('a.yaml'), now + 10, false), 'the new tab is gone');
		assert.ok(!confirmsSaveAs(c, k('a.yaml'), now + SAVE_AS_CLOSE_MS + 1, true), 'the source closed too late');
		assert.ok(confirmsSaveAs(c, k('a.yaml'), now + SAVE_AS_CLOSE_MS, true), 'at the edge');
		assert.ok(!saveAsExpired(c, now + SAVE_AS_CLOSE_MS));
		assert.ok(saveAsExpired(c, now + SAVE_AS_CLOSE_MS + 1), 'a source that stays open settles the candidate as no Save As');
	});

	test('STALE: created or saved more than the window before the tab opened', () => {
		assert.ok(isSaveAsCandidate(k('b.yaml'), k('a.yaml'), recent(k('b.yaml'), now - SAVE_AS_WINDOW_MS, now - SAVE_AS_WINDOW_MS), now), 'at the edge');
		assert.ok(!isSaveAsCandidate(k('b.yaml'), k('a.yaml'), recent(k('b.yaml'), now - SAVE_AS_WINDOW_MS - 1, now - 5), now));
		assert.ok(!isSaveAsCandidate(k('b.yaml'), k('a.yaml'), recent(k('b.yaml'), now - 5, now - SAVE_AS_WINDOW_MS - 1), now));
	});
});
