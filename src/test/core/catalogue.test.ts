import * as assert from 'assert';
import { componentCatalogue, formatSlot, slotsOf, type ComponentCatalog } from '../../core/catalogue';
import { rawSchema, servedSchema } from '../helpers/schemas';

/** `category:name` -> its slots as `<path> (<kind>) -> <category>`, for every component with any. */
function slotListing(catalogue: ComponentCatalog): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [category, entry] of catalogue.categories) {
		for (const [name, slots] of entry.slots) {
			out[`${category}:${name}`] = slots.map((s) => `${formatSlot(s)} (${s.kind}) -> ${s.category}`);
		}
	}
	return out;
}

suite('core/catalogue (3.3, AD-20)', () => {
	const c112 = componentCatalogue(servedSchema('4.112.0'));
	const c100 = componentCatalogue(servedSchema('4.100.0'));
	const slots = (category: string, name: string) => slotsOf(c112, category, name).map((s) => `${formatSlot(s)} (${s.kind}) -> ${s.category}`);

	test('CATALOGUE: child slots by category and name, from the transformed 4.112.0 schema', () => {
		assert.deepStrictEqual(slots('processor', 'switch'), ['[].processors[] (list) -> processor']);
		assert.deepStrictEqual(slots('output', 'switch'), ['.cases[].output (single) -> output']);
		assert.deepStrictEqual(slots('output', 'broker'), ['.batching.processors[] (list) -> processor', '.outputs[] (list) -> output']);
		// The branch name is a map wildcard; the children are each branch's processor list.
		assert.deepStrictEqual(slots('processor', 'workflow'), ['.branches.<name>.processors[] (list) -> processor']);
		assert.deepStrictEqual(slotsOf(c112, 'processor', 'workflow')[0].steps.map((s) => s.kind), ['field', 'entries', 'field', 'items']);
		assert.deepStrictEqual(slots('processor', 'mapping'), []);
		assert.deepStrictEqual(slots('processor', 'try'), ['[] (list) -> processor']);
		assert.deepStrictEqual(slots('processor', 'branch'), ['.processors[] (list) -> processor']);
		assert.deepStrictEqual(slots('processor', 'try_catch').sort(), ['.catch[] (list) -> processor', '.processors[] (list) -> processor']);
		assert.deepStrictEqual(slots('output', 'fallback'), ['[] (list) -> output']);
		assert.deepStrictEqual(slots('output', 'retry'), ['.output (single) -> output']);
		assert.deepStrictEqual(slots('output', 'reject_errored'), ['<self> (single) -> output']);
		assert.deepStrictEqual(slots('output', 'dynamic'), ['.outputs.<name> (map) -> output']);
		assert.deepStrictEqual(slots('input', 'broker').sort(), ['.batching.processors[] (list) -> processor', '.inputs[] (list) -> input']);
		assert.deepStrictEqual(slots('input', 'read_until'), ['.input (single) -> input']);
		assert.deepStrictEqual(slots('input', 'batched').sort(), ['.child (single) -> input', '.policy.processors[] (list) -> processor']);
		// Scanners and buffers are not slots.
		assert.deepStrictEqual(slots('input', 'stdin'), []);
		assert.deepStrictEqual(slots('input', 'aws_s3'), []);
		assert.deepStrictEqual(slots('nope', 'switch'), []);
	});

	test('CATALOGUE: names per category, keyed by category (switch is a processor and an output)', () => {
		const names = (category: string) => c112.categories.get(category)!.names;
		assert.ok(names('processor').has('switch') && names('output').has('switch') && !names('input').has('switch'));
		assert.ok(names('input').has('broker') && names('output').has('broker'));
		assert.ok(names('processor').has('processors') && !names('output').has('processors'));
		assert.ok(names('cache').has('memory') && names('rate_limit').has('local'));
		assert.ok(!names('processor').has('label'));
	});

	test('CATALOGUE: shared fields; an input\'s and an output\'s own processors are shared slots', () => {
		const entry = (category: string) => c112.categories.get(category)!;
		assert.deepStrictEqual([...entry('input').sharedFields].sort(), ['label', 'meta', 'plugin', 'processors', 'type']);
		assert.deepStrictEqual([...entry('processor').sharedFields].sort(), ['label', 'meta', 'plugin', 'type']);
		assert.deepStrictEqual(entry('input').sharedSlots.map(formatSlot), ['.processors[]']);
		assert.deepStrictEqual(entry('output').sharedSlots.map(formatSlot), ['.processors[]']);
		assert.deepStrictEqual(entry('processor').sharedSlots, []);
	});

	test('SAME_SLOTS: the 4.100.0 and 4.112.0 catalogues have identical slot lists', () => {
		const a = slotListing(c100);
		const b = slotListing(c112);
		assert.deepStrictEqual(a, b);
		// Input, processor and output components with at least one slot (the investigation's count
		// of 98 includes buffers and scanners).
		assert.ok(Object.keys(b).length > 60, `${Object.keys(b).length} components with slots`);
	});

	test('the raw and the transformed schema give the same catalogue', () => {
		assert.deepStrictEqual(slotListing(componentCatalogue(rawSchema('4.112.0'))), slotListing(c112));
	});

	test('NEWER_BINARY: a component the schema adds gets its slots with no code change', () => {
		const raw = rawSchema('4.112.0');
		const definitions = raw.definitions as Record<string, { allOf: Array<{ anyOf: unknown[] }> }>;
		definitions.processor.allOf[0].anyOf.push({
			type: 'object',
			properties: {
				rpcn_test_fan: {
					type: 'object',
					properties: { lanes: { type: 'object', additionalProperties: { type: 'array', items: { $ref: '#/definitions/processor' } } } },
				},
			},
		});
		const catalogue = componentCatalogue(raw);
		assert.deepStrictEqual(slotsOf(catalogue, 'processor', 'rpcn_test_fan').map((s) => `${formatSlot(s)} (${s.kind})`), ['.lanes.<name>[] (list)']);
	});

	test('odd schemas give an empty catalogue, never throw', () => {
		assert.strictEqual(componentCatalogue({}).categories.size, 0);
		assert.strictEqual(componentCatalogue({ definitions: { input: { allOf: 'x' }, output: [] } }).categories.size, 0);
		const c = componentCatalogue({ definitions: { processor: { allOf: [{ anyOf: [null, { properties: { a: { items: [1] } } }] }] } } });
		assert.deepStrictEqual([...c.categories.get('processor')!.names], ['a']);
		assert.deepStrictEqual(slotsOf(c, 'processor', 'a'), []);
	});
});
