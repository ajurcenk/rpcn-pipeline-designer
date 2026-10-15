import * as assert from 'assert';
import {
	applySampleChange, entryFor, hasLabelEntry, parseSamplesFile, relinkSamples, sampleCount, samplesFileName, samplesFor, serializeSamplesFile,
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
		const relinked = relinkSamples(file, 'pipeline.processors[2]', 'mapping_1');
		assert.ok(typeof relinked === 'object');
		assert.deepStrictEqual(relinked.file, {
			version: 1, mappings: [FILE.mappings[0], { label: 'mapping_1', selected: 'x', samples: [{ name: 'x', content: 'hi', meta: {} }] }],
		});
		assert.strictEqual(entryFor(relinked.file, { label: 'mapping_1', path: 'pipeline.processors[9]' })?.samples.length, 1, 'found by label after a move');
		assert.ok(serializeSamplesFile(relinked.file).includes('"label": "mapping_1"'));
		assert.ok(!serializeSamplesFile(relinked.file).includes('"path"'));
		assert.strictEqual(relinkSamples(file, 'pipeline.processors[7]', 'mapping_1'), 'none');
		assert.strictEqual(relinkSamples(undefined, 'pipeline.processors[2]', 'mapping_1'), 'none');
		assert.strictEqual(relinkSamples(file, 'pipeline.processors[2]', 'first'), 'taken', 'two entries are never merged');
	});
});
