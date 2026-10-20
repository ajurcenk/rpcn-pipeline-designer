import * as assert from 'assert';
import { PENDING_RENAME_MS, PendingRenames, renamedKey, renamedThrough, type Rename } from '../../../adapters/graphPanel/tabs';

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
