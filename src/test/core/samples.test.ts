import * as assert from 'assert';
import {
	applySampleChange, entryFor, hasLabelEntry, linkOf, parseSamplesFile, relinkAll, relinkSamples, sampleCount, samplesFileName, samplesFor, serializeSamplesFile,
	type SampleChange, type SampleRef, type SamplesFile,
} from '../../core/samples';
import { MAX_SAMPLE_NAME_LENGTH } from '../../shared/bloblangProtocol';

const FIRST: SampleRef = { label: 'first', path: 'pipeline.processors[0]' };
const UNLABELLED: SampleRef = { path: 'pipeline.processors[2]' };

const FILE: SamplesFile = {
	version: 1,
	mappings: [
		{
			label: 'first', selected: 'b', samples: [
				{ name: 'a', content: '{"a":1}', meta: {} },
				{ name: 'b', content: '{"a":2}', meta: { k: 'v' } },
				{ name: 'c', content: '', meta: {} },
			],
		},
		{ path: 'pipeline.processors[2]', selected: null, samples: [{ name: 'x', content: 'hi', meta: {} }] },
	],
};

/** Applies `changes` in turn from `file`, each of which must apply. */
function apply(file: SamplesFile | undefined, ref: SampleRef, ...changes: SampleChange[]): SamplesFile | undefined {
	for (const change of changes) {
		const next = applySampleChange(file, ref, change);
		assert.ok(next, `${JSON.stringify(change)} applies`);
		file = next.file;
	}
	return file;
}

suite('core/samples (4.9, AD-22)', () => {
	test('samplesFileName: beside the config, without .yaml / .yml', () => {
		assert.strictEqual(samplesFileName('orders.yaml'), 'orders.samples.json');
		assert.strictEqual(samplesFileName('orders.YML'), 'orders.samples.json');
		assert.strictEqual(samplesFileName('a.b.yaml'), 'a.b.samples.json');
		assert.strictEqual(samplesFileName('config'), 'config.samples.json');
	});

	test('parse + serialize: a round trip; 2-space indentation and a trailing newline', () => {
		const text = serializeSamplesFile(FILE);
		assert.ok(text.endsWith('}\n'));
		assert.ok(text.startsWith('{\n  "version": 1,\n  "mappings": [\n    {\n      "label": "first",'), text);
		assert.deepStrictEqual(parseSamplesFile(text), { ok: true, file: FILE });
		assert.deepStrictEqual(parseSamplesFile(`﻿${text}`), { ok: true, file: FILE });
	});

	test('UNREADABLE: invalid JSON and every wrong shape give a reason, never a throw', () => {
		const entry = (patch: Record<string, unknown>) => JSON.stringify({ version: 1, mappings: [{ label: 'l', selected: null, samples: [], ...patch }] });
		const sample = (patch: Record<string, unknown>) => entry({ samples: [{ name: 'n', content: '', meta: {}, ...patch }] });
		const bad: [string, RegExp][] = [
			['{', /JSON/],
			['[]', /JSON object/],
			['{"version": 2, "mappings": []}', /version must be 1/],
			['{"version": 1}', /mappings must be an array/],
			['{"version": 1, "mappings": [1]}', /mappings\[0\] must be an object/],
			[entry({ label: '' }), /label must be a non-empty string/],
			[entry({ label: undefined }), /needs a label or a path/],
			[entry({ path: 3 }), /path must be a non-empty string/],
			[entry({ samples: {} }), /samples must be an array/],
			[entry({ selected: 'nope' }), /selected must be null or the name/],
			[entry({ selected: undefined }), /selected must be null or the name/],
			[sample({ name: '' }), /name must be a string of 1–100/],
			[sample({ name: 'x'.repeat(MAX_SAMPLE_NAME_LENGTH + 1) }), /name must be/],
			[sample({ content: 1 }), /content must be a string/],
			[sample({ meta: { k: 1 } }), /meta must map non-empty keys to strings/],
			[sample({ meta: { '': 'v' } }), /meta must map/],
			[sample({ meta: [] }), /meta must be an object/],
			[entry({ samples: [{ name: 'n', content: '', meta: {} }, { name: 'n', content: '', meta: {} }] }), /two samples named "n"/],
			[JSON.stringify({ version: 1, mappings: [{ label: 'l', selected: null, samples: [] }, { label: 'l', selected: null, samples: [] }] }), /two mappings have the label "l"/],
		];
		for (const [text, reason] of bad) {
			const parsed = parseSamplesFile(text);
			assert.strictEqual(parsed.ok, false, text);
			assert.match(parsed.ok ? '' : parsed.reason, reason, text);
		}
	});

	test('LINK: a label finds its entry wherever the processor is; no label: the unlabelled entry with its path', () => {
		assert.strictEqual(entryFor(FILE, { label: 'first', path: 'pipeline.processors[5]' }), FILE.mappings[0]);
		assert.strictEqual(entryFor(FILE, UNLABELLED), FILE.mappings[1]);
		assert.strictEqual(entryFor(FILE, { label: 'other', path: 'pipeline.processors[2]' }), undefined, 'a label never falls back to the path');
		assert.strictEqual(entryFor(FILE, { path: 'pipeline.processors[0]' }), undefined);
		assert.strictEqual(entryFor(undefined, FIRST), undefined);
		assert.deepStrictEqual(samplesFor(undefined, FIRST), { samples: [], selected: null });
		assert.deepStrictEqual(samplesFor(FILE, FIRST), { samples: FILE.mappings[0].samples, selected: 'b' });
	});

	test('FIRST_SAMPLE + PATH_FALLBACK: a new entry has the label when there is one, else the path; it is selected', () => {
		const first = apply(undefined, FIRST, { type: 'add', sample: { name: 'sample 1', content: '{}', meta: { k: 'v' } } });
		assert.deepStrictEqual(first, { version: 1, mappings: [{ label: 'first', selected: 'sample 1', samples: [{ name: 'sample 1', content: '{}', meta: { k: 'v' } }] }] });
		const both = apply(first, UNLABELLED, { type: 'add', sample: { name: 's', content: '', meta: {} } });
		assert.deepStrictEqual(both?.mappings[1], { path: 'pipeline.processors[2]', selected: 's', samples: [{ name: 's', content: '', meta: {} }] });
	});

	test('SWITCH / RENAME / DUP / EDIT: each changes only its entry; a change that does not apply is undefined', () => {
		const switched = apply(FILE, FIRST, { type: 'select', name: 'a' });
		assert.strictEqual(switched?.mappings[0].selected, 'a');
		assert.strictEqual(switched?.mappings[1], FILE.mappings[1]);
		const renamed = apply(FILE, FIRST, { type: 'rename', from: 'b', to: '  bee ' });
		assert.deepStrictEqual(renamed?.mappings[0].samples.map((s) => s.name), ['a', 'bee', 'c']);
		assert.strictEqual(renamed?.mappings[0].selected, 'bee', 'the selected sample keeps its selection');
		const edited = apply(FILE, FIRST, { type: 'edit', content: '{"a":3}', meta: { z: '1' } });
		assert.deepStrictEqual(edited?.mappings[0].samples[1], { name: 'b', content: '{"a":3}', meta: { z: '1' } });
		const none: SampleChange[] = [
			{ type: 'rename', from: 'b', to: 'a' },
			{ type: 'rename', from: 'b', to: '   ' },
			{ type: 'rename', from: 'b', to: 'b' },
			{ type: 'rename', from: 'b', to: 'x'.repeat(MAX_SAMPLE_NAME_LENGTH + 1) },
			{ type: 'rename', from: 'zz', to: 'q' },
			{ type: 'select', name: 'b' },
			{ type: 'select', name: 'zz' },
			{ type: 'delete', name: 'zz' },
			{ type: 'add', sample: { name: 'a', content: '', meta: {} } },
			{ type: 'edit', content: '{"a":2}', meta: { k: 'v' } },
		];
		for (const change of none) {
			assert.strictEqual(applySampleChange(FILE, FIRST, change), undefined, JSON.stringify(change));
		}
		assert.strictEqual(applySampleChange(FILE, UNLABELLED, { type: 'edit', content: 'x', meta: {} }), undefined, 'nothing selected: an edit saves nothing');
		assert.strictEqual(applySampleChange(undefined, FIRST, { type: 'select', name: 'a' }), undefined);
	});

	test('DELETE: the next sample is selected, else the previous; an empty entry goes, then the file', () => {
		assert.strictEqual(apply(FILE, FIRST, { type: 'delete', name: 'b' })?.mappings[0].selected, 'c');
		assert.strictEqual(apply(FILE, FIRST, { type: 'select', name: 'c' }, { type: 'delete', name: 'c' })?.mappings[0].selected, 'b');
		assert.strictEqual(apply(FILE, FIRST, { type: 'delete', name: 'a' })?.mappings[0].selected, 'b', 'another sample keeps the selection');
		const one = apply(FILE, FIRST, { type: 'delete', name: 'a' }, { type: 'delete', name: 'b' }, { type: 'delete', name: 'c' });
		assert.deepStrictEqual(one, { version: 1, mappings: [FILE.mappings[1]] });
		assert.strictEqual(apply(one, UNLABELLED, { type: 'delete', name: 'x' }), undefined, 'no entry left: no file');
	});

	test('COUNT (4.16): the samples of a ref by the panel\'s rule; none, no entry or no file: 0', () => {
		assert.strictEqual(sampleCount(FILE, FIRST), 3);
		assert.strictEqual(sampleCount(FILE, { label: 'first', path: 'elsewhere' }), 3, 'by label wherever it is');
		assert.strictEqual(sampleCount(FILE, UNLABELLED), 1);
		assert.strictEqual(sampleCount(FILE, { label: 'other', path: UNLABELLED.path }), 0, 'a labelled ref never takes a path entry');
		assert.strictEqual(sampleCount(FILE, { path: 'pipeline.processors[0]' }), 0);
		assert.strictEqual(sampleCount(undefined, FIRST), 0);
		assert.ok(hasLabelEntry(FILE, 'first'));
		assert.ok(!hasLabelEntry(FILE, 'pipeline.processors[2]'));
		assert.ok(!hasLabelEntry(undefined, 'first'));
	});

	test('RELINK (4.16): the path entry becomes a label entry, samples and selected kept; none; taken', () => {
		const file: SamplesFile = { ...FILE, mappings: [FILE.mappings[0], { ...FILE.mappings[1], selected: 'x' }] };
		const relinked = relinkSamples(file, UNLABELLED, { label: 'mapping_1', path: UNLABELLED.path });
		assert.ok(typeof relinked === 'object');
		assert.deepStrictEqual(relinked.file, {
			version: 1, mappings: [FILE.mappings[0], { label: 'mapping_1', selected: 'x', samples: [{ name: 'x', content: 'hi', meta: {} }] }],
		});
		assert.strictEqual(entryFor(relinked.file, { label: 'mapping_1', path: 'pipeline.processors[9]' })?.samples.length, 1, 'found by label after a move');
		assert.ok(serializeSamplesFile(relinked.file).includes('"label": "mapping_1"'));
		assert.ok(!serializeSamplesFile(relinked.file).includes('"path"'));
		assert.strictEqual(relinkSamples(file, { path: 'pipeline.processors[7]' }, { label: 'mapping_1', path: '' }), 'none');
		assert.strictEqual(relinkSamples(undefined, UNLABELLED, { label: 'mapping_1', path: '' }), 'none');
		assert.strictEqual(relinkSamples(file, UNLABELLED, { label: 'first', path: '' }), 'taken', 'two entries are never merged');
	});

	test('RELINK (4.10): label → label, label → path and path → path; the same link is none; a taken target moves nothing', () => {
		const toLabel = relinkSamples(FILE, FIRST, { label: 'renamed', path: FIRST.path });
		assert.ok(typeof toLabel === 'object');
		assert.deepStrictEqual(toLabel.file.mappings[0], { label: 'renamed', selected: 'b', samples: FILE.mappings[0].samples });
		assert.deepStrictEqual(toLabel.file.mappings[1], FILE.mappings[1], 'the other entry is unchanged');

		const toPath = relinkSamples(FILE, FIRST, { path: 'pipeline.processors[0]' });
		assert.ok(typeof toPath === 'object');
		assert.deepStrictEqual(toPath.file.mappings[0], { path: 'pipeline.processors[0]', selected: 'b', samples: FILE.mappings[0].samples });
		assert.ok(!serializeSamplesFile(toPath.file).includes('"label": "first"'));
		assert.deepStrictEqual(parseSamplesFile(serializeSamplesFile(toPath.file)), { ok: true, file: toPath.file }, 'still a valid file');

		const shifted = relinkSamples(FILE, UNLABELLED, { path: 'pipeline.processors[3]' });
		assert.ok(typeof shifted === 'object');
		assert.deepStrictEqual(shifted.file.mappings[1], { path: 'pipeline.processors[3]', selected: null, samples: FILE.mappings[1].samples });

		assert.strictEqual(relinkSamples(FILE, FIRST, { label: 'first', path: 'elsewhere' }), 'none', 'the same label: nothing to move');
		assert.strictEqual(relinkSamples(FILE, UNLABELLED, UNLABELLED), 'none');
		assert.strictEqual(relinkSamples(FILE, FIRST, UNLABELLED), 'taken', 'label → a path that has samples');
		assert.strictEqual(relinkSamples(FILE, UNLABELLED, { label: 'first', path: '' }), 'taken', 'path → a label that has samples');
		assert.strictEqual(relinkSamples(FILE, { label: 'nope', path: '' }, UNLABELLED), 'none', 'no entry: none, even onto a taken link');
		assert.strictEqual(linkOf(FIRST), 'label first');
		assert.strictEqual(linkOf(UNLABELLED), 'path pipeline.processors[2]');
	});

	test('RELINK_ALL (4.10): a save\'s moves in one step: chains and swaps, no entry, taken links', () => {
		const P = (i: number): SampleRef => ({ path: `pipeline.processors[${i}]` });
		const entry = (link: SampleRef, name: string) => ({ ...(link.label !== undefined ? { label: link.label } : { path: link.path }), selected: null, samples: [{ name, content: '', meta: {} }] });
		const file: SamplesFile = { version: 1, mappings: [entry(P(0), 'zero'), entry(P(1), 'one'), entry({ label: 'x', path: '' }, 'x')] };

		// UNLABELLED_SHIFT_SAVE as a chain: [1] → [2] frees [1] for [0] → [1].
		const chain = relinkAll(file, [{ from: P(0), to: P(1) }, { from: P(1), to: P(2) }], []);
		assert.deepStrictEqual(chain.applied, [true, true]);
		assert.deepStrictEqual(chain.file?.mappings, [entry(P(1), 'zero'), entry(P(2), 'one'), file.mappings[2]]);
		// A swap.
		const swap = relinkAll(file, [{ from: P(1), to: P(0) }, { from: P(0), to: P(1) }], []);
		assert.deepStrictEqual(swap.applied, [true, true]);
		assert.deepStrictEqual(swap.file?.mappings, [entry(P(1), 'zero'), entry(P(0), 'one'), file.mappings[2]]);
		// No entry: the link follows, nothing to write.
		assert.deepStrictEqual(relinkAll(file, [{ from: P(5), to: P(6) }, { from: undefined, to: P(7) }], []), { file: undefined, applied: [true, true], hadEntry: [false, false] });
		// RELINK_TAKEN: a target an entry keeps, a live panel holds, a blocked move keeps, or an earlier move takes.
		assert.deepStrictEqual(relinkAll(file, [{ from: P(1), to: { label: 'x', path: '' } }], []), { file: undefined, applied: [false], hadEntry: [true] });
		assert.deepStrictEqual(relinkAll(file, [{ from: P(5), to: P(0) }], []), { file: undefined, applied: [false], hadEntry: [false] }, 'no entry onto an entry: taken, nothing to move');
		assert.deepStrictEqual(relinkAll(file, [{ from: P(5), to: P(6) }], [P(6)]).applied, [false], 'a live panel holds it');
		const blocked = relinkAll(file, [{ from: P(0), to: P(1) }, { from: P(1), to: { label: 'x', path: '' } }], []);
		assert.deepStrictEqual(blocked, { file: undefined, applied: [false, false], hadEntry: [true, true] }, '[1] stays, so [0] can\'t take it');
		const twice = relinkAll(file, [{ from: P(5), to: P(8) }, { from: P(6), to: P(8) }], []);
		assert.deepStrictEqual(twice.applied, [true, false], 'one link, two panels: the first');
		// Label → label, label → path.
		const renamed = relinkAll(file, [{ from: { label: 'x', path: '' }, to: { label: 'y', path: 'pipeline.processors[2]' } }], []);
		assert.deepStrictEqual(renamed.file?.mappings[2], entry({ label: 'y', path: '' }, 'x'));
		const unlabelled = relinkAll(file, [{ from: { label: 'x', path: '' }, to: P(2) }], []);
		assert.deepStrictEqual(unlabelled.file?.mappings[2], entry(P(2), 'x'));
		// The same link: nothing to do.
		assert.deepStrictEqual(relinkAll(file, [{ from: P(0), to: P(0) }], []), { file: undefined, applied: [false], hadEntry: [true] });
	});
});
