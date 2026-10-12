import * as assert from 'assert';
import { renamedKey, renamedThrough } from '../../../adapters/graphPanel/tabs';

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
