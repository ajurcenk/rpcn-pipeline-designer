import * as assert from 'assert';
import { bloblangProcessors, type BloblangProcessor } from '../../core/bloblangProcessors';
import { mapOffset, mapRange, matchProcessors, parses, type TextChange, type TrackedProcessor } from '../../core/processorTracking';
import { parseYaml } from '../../core/yamlPath';

const CONFIG = [
	'pipeline:',
	'  processors:',
	'    - label: first',
	'      mapping: root = this',
	'    - mapping: root.b = 1',
	'    - mutation: root.c = 2',
	'',
].join('\n');

const processors = (text: string) => bloblangProcessors(parseYaml(text));

/** The change that turns `before` into `after`: their common prefix and suffix kept. */
function diff(before: string, after: string): TextChange {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) {
		start++;
	}
	let end = 0;
	while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) {
		end++;
	}
	return { offset: start, length: before.length - start - end, text: after.slice(start, after.length - end) };
}

/** The offset of 0-based `line` of `text`. */
const lineStart = (text: string, line: number) => text.split('\n').slice(0, line).reduce((n, l) => n + l.length + 1, 0);

/** Whole lines `from` to `to` (exclusive) of `text` replaced by `lines`, as an editor's line edit: the change and the text after it. */
function lineEdit(text: string, from: number, to: number, lines: readonly string[] = []): { change: TextChange; after: string } {
	const offset = lineStart(text, from);
	const change = { offset, length: lineStart(text, to) - offset, text: lines.map((l) => `${l}\n`).join('') };
	return { change, after: text.slice(0, offset) + change.text + text.slice(offset + change.length) };
}

/** One panel, tracking `p` through `changes` (a mapped range), as the adapter does. */
class Panel {
	private t: TrackedProcessor;
	constructor(p: BloblangProcessor) {
		this.t = { path: p.path, ...(p.label !== undefined ? { label: p.label } : {}), kind: p.kind, source: p.source, range: p.range, removed: false };
	}
	get path(): string | undefined {
		return this.t.removed ? undefined : this.t.path;
	}
	get label(): string | undefined {
		return this.t.label;
	}
	get removed(): boolean {
		return this.t.removed;
	}
	tracked(): TrackedProcessor {
		return this.t;
	}
	map(changes: readonly TextChange[]): void {
		if (this.t.range) {
			this.t = { ...this.t, range: mapRange(this.t.range, changes) };
		}
	}
	follow(p: BloblangProcessor | undefined): void {
		this.t = p
			? { path: p.path, ...(p.label !== undefined ? { label: p.label } : {}), kind: p.kind, source: p.source, range: p.range, removed: false }
			: { ...this.t, removed: true };
	}
	/** The document closed: back to its link. */
	reset(link: { readonly label?: string; readonly path: string }): void {
		const { label: _label, ...rest } = this.t;
		this.t = { ...rest, path: link.path, ...(link.label !== undefined ? { label: link.label } : {}), range: undefined };
	}
}

/** A document with panels, edited as an editor would: each change maps the ranges, then a text that parses matches them. */
class Doc {
	readonly panels: Panel[] = [];
	constructor(public text: string) {}
	open(path: string): Panel {
		const panel = new Panel(processors(this.text).find((p) => p.path === path)!);
		this.panels.push(panel);
		return panel;
	}
	/** Applies `changes` (pre-change coordinates); `undefined`: the diff to `after`. */
	edit(after: string, changes: readonly TextChange[] = [diff(this.text, after)]): void {
		this.text = after;
		this.panels.forEach((p) => p.map(changes));
		this.match();
	}
	match(): void {
		const parsed = parseYaml(this.text);
		if (!parses(parsed)) {
			return;
		}
		const found = matchProcessors(bloblangProcessors(parsed), this.panels.map((p) => p.tracked()));
		this.panels.forEach((p, i) => p.follow(found[i]));
	}
	paths(): (string | undefined)[] {
		return this.panels.map((p) => p.path);
	}
}

const P = (i: number) => `pipeline.processors[${i}]`;

suite('core/processorTracking (4.10, AD-1)', () => {
	test('mapOffset: before shifts, after stays, a containing change moves it to its start (left) or new end (right)', () => {
		assert.strictEqual(mapOffset(10, [{ offset: 2, length: 0, text: 'abc' }]), 13);
		assert.strictEqual(mapOffset(10, [{ offset: 2, length: 5, text: '' }]), 5);
		assert.strictEqual(mapOffset(10, [{ offset: 2, length: 8, text: 'x' }]), 3, 'a change ending at it is before it');
		assert.strictEqual(mapOffset(10, [{ offset: 10, length: 0, text: 'label: a\n  ' }]), 10, 'an insertion at it: left stays');
		assert.strictEqual(mapOffset(10, [{ offset: 10, length: 0, text: 'abc' }], false), 10, 'an insertion at it: a boundary, never containing it');
		assert.deepStrictEqual(mapRange([5, 10], [{ offset: 10, length: 0, text: 'abc' }]), [5, 10], 'an insertion at the end does not extend it');
		assert.strictEqual(mapOffset(10, [{ offset: 10, length: 4, text: 'zz' }]), 10, 'a change starting at it');
		assert.strictEqual(mapOffset(10, [{ offset: 10, length: 4, text: 'zz' }], false), 10);
		assert.strictEqual(mapOffset(10, [{ offset: 12, length: 3, text: 'abc' }]), 10, 'after it');
		assert.strictEqual(mapOffset(10, [{ offset: 5, length: 10, text: 'abc' }]), 5, 'contained, left: the change\'s start');
		assert.strictEqual(mapOffset(10, [{ offset: 5, length: 10, text: 'abc' }], false), 8, 'contained, right: the change\'s new end');
		// Several changes, all in pre-change coordinates (multi-cursor), in any order.
		const many: TextChange[] = [{ offset: 20, length: 1, text: '' }, { offset: 1, length: 0, text: 'xx' }, { offset: 4, length: 2, text: 'y' }];
		assert.strictEqual(mapOffset(10, many), 11);
		assert.strictEqual(mapOffset(5, many), 6, 'contained in the second: its start, after the first\'s shift');
		assert.deepStrictEqual(mapRange([5, 10], [{ offset: 0, length: 20, text: 'abc' }]), [0, 3], 'a change over all of it');
		assert.deepStrictEqual(mapRange([5, 10], [{ offset: 4, length: 7, text: '' }]), [4, 4], 'deleted: empty');
	});

	test('parses: only a text with no YAML error', () => {
		assert.ok(parses(parseYaml(CONFIG)));
		assert.ok(!parses(parseYaml('a: [')));
		assert.ok(!parses(undefined));
	});

	test('EDIT_ABOVE + INSERT_BEFORE: the same processor; its path follows an insert above', () => {
		const doc = new Doc(CONFIG);
		[0, 1, 2].forEach((i) => doc.open(P(i)));
		doc.edit(`# a comment\n${CONFIG}`);
		assert.deepStrictEqual(doc.paths(), [P(0), P(1), P(2)]);
		const inserted = lineEdit(doc.text, 5, 5, ['    - mapping: root.new = 0']);
		doc.edit(inserted.after, [inserted.change]);
		assert.deepStrictEqual(doc.paths(), [P(0), P(2), P(3)]);
		const top = lineEdit(doc.text, 3, 3, ['    - mutation: root.new = 0']);
		doc.edit(top.after, [top.change]);
		assert.deepStrictEqual(doc.paths(), [P(1), P(3), P(4)], 'a mutation inserted at the top');
	});

	test('INSERT_AT_NEXT_LINE: a processor inserted at the start of the next item\'s line (where the map range ends) is not taken', () => {
		const one = new Doc(CONFIG);
		const panel = one.open(P(0));
		const at = lineEdit(CONFIG, 4, 4, ['    - mapping: root.pasted = 0']);
		one.edit(at.after, [at.change]);
		assert.deepStrictEqual([panel.path, panel.label], [P(0), 'first']);
		const two = new Doc(CONFIG);
		two.open(P(0));
		two.open(P(1));
		two.edit(at.after, [at.change]);
		assert.deepStrictEqual(two.paths(), [P(0), P(2)], 'each on its own; the pasted one has no panel');
	});

	test('overlap relative to the union: a range that spans the end of a big processor and all of a small one takes the small one', () => {
		const text = ['pipeline:', '  processors:', '    - mapping: |', ...Array.from({ length: 8 }, (_, i) => `        root.f${i} = ${i}`), '    - mapping: root.b = 1', ''].join('\n');
		const [big, small] = processors(text);
		const range = [small.range[0] - 30, small.range[1]] as const;
		assert.ok(30 > small.range[1] - small.range[0], 'more of the big one overlaps');
		const found = matchProcessors(processors(text), [{ path: small.path, kind: 'mapping', source: small.source, range, removed: false }]);
		assert.strictEqual(found[0]?.path, small.path);
		assert.notStrictEqual(big.path, small.path);
	});

	test('REORDER_LABELLED: removed by the cut, found by its label after the paste elsewhere', () => {
		const doc = new Doc(CONFIG);
		const first = doc.open(P(0));
		const lines = CONFIG.split('\n');
		const cut = lineEdit(CONFIG, 2, 4);
		doc.edit(cut.after, [cut.change]);
		assert.ok(first.removed, 'cut: removed');
		const pasted = lineEdit(doc.text, 4, 4, lines.slice(2, 4));
		doc.edit(pasted.after, [pasted.change]);
		assert.deepStrictEqual([first.path, first.label], [P(2), 'first']);
		// Moved in one edit (a line move): the overlap follows it.
		const moved = new Doc(CONFIG);
		const b = moved.open(P(1));
		const swap = lineEdit(CONFIG, 2, 5, [lines[4], lines[2], lines[3]]);
		moved.edit(swap.after, [swap.change]);
		assert.ok(!b.removed);
	});

	test('LABEL_TYPED + WHOLE_LINE + LABEL_REMOVED: the label edited, the line replaced, the label deleted: the same processor', () => {
		const doc = new Doc(CONFIG);
		const panel = doc.open(P(0));
		for (const ch of ['s', 'se', 'sec']) {
			doc.edit(CONFIG.replace('label: first', `label: ${ch}`));
		}
		assert.deepStrictEqual([panel.path, panel.label], [P(0), 'sec']);
		// WHOLE_LINE: `    - label: sec` replaced by `    - label: b` in one edit from the line's start.
		const line = lineEdit(doc.text, 2, 3, ['    - label: b']);
		doc.edit(line.after, [line.change]);
		assert.deepStrictEqual([panel.path, panel.label], [P(0), 'b']);
		doc.edit(doc.text.replace('    - label: b\n      mapping', '    - mapping'));
		assert.deepStrictEqual([panel.path, panel.label], [P(0), undefined]);
		// The label added as the processor's first key (4.16's insertion at the map start).
		const labelled = new Doc(CONFIG);
		const added = labelled.open(P(1));
		labelled.edit(CONFIG.replace('    - mapping: root.b = 1', '    - label: mapping_1\n      mapping: root.b = 1'));
		assert.deepStrictEqual([added.path, added.label], [P(1), 'mapping_1']);
	});

	test('LABEL_PREFIX: `label: xy` typed on an unlabelled processor does not take the one labelled `x` from its panel', () => {
		const text = CONFIG.replace('label: first', 'label: x');
		const doc = new Doc(text);
		const b = doc.open(P(0));
		const a = doc.open(P(1));
		const at = text.indexOf('mapping: root.b');
		for (const typed of ['l', 'label: ', 'label: x', 'label: xy']) {
			doc.edit(text.slice(0, at) + `${typed}\n      ` + text.slice(at));
		}
		assert.deepStrictEqual([a.path, a.label, b.path, b.label], [P(1), 'xy', P(0), 'x']);
	});

	test('DELETED + UNDO: removed; back by the same kind and Bloblang nearest its last path, or by its last label', () => {
		const doc = new Doc(CONFIG);
		const panel = doc.open(P(1));
		const del = lineEdit(CONFIG, 4, 5);
		doc.edit(del.after, [del.change]);
		assert.ok(panel.removed);
		doc.edit(`${doc.text}# more\n`);
		assert.ok(panel.removed, 'still gone');
		doc.edit(`${CONFIG}# more\n`);
		assert.deepStrictEqual([panel.removed, panel.path], [false, P(1)], 'undone');
		// Another source or kind does not bring it back.
		const other = new Doc(CONFIG);
		const gone = other.open(P(1));
		other.edit(del.after, [del.change]);
		other.edit(CONFIG.replace('root.b = 1', 'root.b = 2'));
		assert.ok(gone.removed, 'another source');
		other.edit(del.after);
		other.edit(CONFIG.replace('mapping: root.b = 1', 'mutation: root.b = 1'));
		assert.ok(gone.removed, 'another kind');
		// Labelled: by its last label, anywhere.
		const labelled = new Doc(CONFIG);
		const first = labelled.open(P(0));
		labelled.edit(CONFIG.replace('    - label: first\n      mapping: root = this\n', ''));
		assert.ok(first.removed);
		labelled.edit(`${labelled.text}output:\n  processors:\n    - label: first\n      mapping: root = 2\n`);
		assert.deepStrictEqual([first.removed, first.path], [false, 'output.processors[0]']);
	});

	test('the same Bloblang twice: back to the one nearest its last path', () => {
		const text = ['pipeline:', '  processors:', '    - mapping: root = 0', '    - mapping: root = 2', '    - mapping: root = 1', ''].join('\n');
		const doc = new Doc(text);
		const panel = doc.open(P(2));
		const del = lineEdit(text, 4, 5);
		doc.edit(del.after, [del.change]);
		assert.ok(panel.removed);
		doc.edit(['pipeline:', '  processors:', '    - mapping: root = 1', '    - mapping: root = 2', '    - mapping: root = 3', '    - mapping: root = 1', ''].join('\n'));
		assert.strictEqual(panel.path, P(3), 'the nearest of [0] and [3]');
	});

	test('TWO_PANELS: one processor deleted; the other panel is unaffected and nothing converges', () => {
		const doc = new Doc(CONFIG);
		doc.open(P(1));
		doc.open(P(2));
		const del = lineEdit(CONFIG, 4, 5);
		doc.edit(del.after, [del.change]);
		assert.deepStrictEqual(doc.paths(), [undefined, P(1)]);
		// A deletion from the dash of one processor to the dash of the next.
		const dashes = new Doc(CONFIG);
		dashes.open(P(1));
		dashes.open(P(2));
		const from = CONFIG.indexOf('- mapping: root.b');
		const to = CONFIG.indexOf('- mutation');
		dashes.edit(CONFIG.slice(0, from) + CONFIG.slice(to), [{ offset: from, length: to - from, text: '' }]);
		assert.deepStrictEqual(dashes.paths(), [undefined, P(1)]);
		// Two panels with the same label (a duplicate): one processor each.
		const dup = new Doc(CONFIG.replace('    - mapping: root.b = 1', '    - label: first\n      mapping: root.b = 1'));
		dup.open(P(0));
		dup.open(P(1));
		dup.edit(`# x\n${dup.text}`);
		assert.deepStrictEqual(dup.paths(), [P(0), P(1)]);
	});

	test('BROKEN_YAML: nothing is matched while it does not parse; after the fix each panel is on its processor', () => {
		const doc = new Doc(CONFIG);
		[0, 1, 2].forEach((i) => doc.open(P(i)));
		// A stray line in the processors list, then fixed by indenting it into a new processor.
		const at = lineStart(CONFIG, 4);
		const stray = `${CONFIG.slice(0, at)}  mapping: root.z = 9\n${CONFIG.slice(at)}`;
		assert.ok(!parses(parseYaml(stray)), 'the stray line breaks the YAML');
		doc.edit(stray);
		assert.deepStrictEqual(doc.paths(), [P(0), P(1), P(2)], 'nothing matched while broken');
		doc.edit(`${CONFIG.slice(0, at)}    - mapping: root.z = 9\n${CONFIG.slice(at)}`);
		assert.deepStrictEqual(doc.paths(), [P(0), P(2), P(3)], 'the shifted paths');
	});

	test('CLOSE_UNSAVED: reset to the samples link, matched by it on reopen', () => {
		const doc = new Doc(CONFIG);
		const unlabelled = doc.open(P(1));
		const labelled = doc.open(P(0));
		const inserted = lineEdit(CONFIG, 2, 2, ['    - mapping: root.new = 0']);
		doc.edit(inserted.after, [inserted.change]);
		assert.deepStrictEqual(doc.paths(), [P(2), P(1)]);
		unlabelled.reset({ path: P(1) });
		labelled.reset({ label: 'first', path: P(0) });
		doc.text = CONFIG;
		doc.match();
		assert.deepStrictEqual(doc.paths(), [P(1), P(0)]);
		// A reset panel whose link is gone: by its Bloblang, else removed.
		const gone = new Doc(CONFIG);
		const panel = gone.open(P(2));
		panel.reset({ path: P(7) });
		gone.match();
		assert.strictEqual(panel.path, P(2), 'the same Bloblang');
		panel.reset({ path: P(7) });
		gone.text = CONFIG.replace('root.c = 2', 'root.c = 5');
		gone.match();
		assert.ok(panel.removed);
	});

	test('a changed kind is not followed by overlap; a labelled one is followed by its label', () => {
		const doc = new Doc(CONFIG);
		const b = doc.open(P(1));
		doc.edit(CONFIG.replace('mapping: root.b = 1', 'mutation: root.b = 1'));
		assert.ok(b.removed);
		const labelled = new Doc(CONFIG);
		const first = labelled.open(P(0));
		labelled.edit(CONFIG.replace('mapping: root = this', 'mutation: root = this'));
		assert.deepStrictEqual([first.removed, first.path], [false, P(0)]);
	});
});
