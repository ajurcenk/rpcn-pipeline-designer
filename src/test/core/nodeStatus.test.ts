import * as assert from 'assert';
import { nodeStatusOf, type StatusDiagnostic } from '../../core/nodeStatus';
import type { PipelineModel } from '../../shared/protocol';
import { fixture } from '../helpers/fixtureModels';

// The switch-processor fixture: a switch with two cases, the first holding a mapping and a log.
const { yaml, model } = fixture('switch-processor');
const SWITCH = 'path:pipeline.processors[0]';
const CASE0 = `${SWITCH}.switch[0]`;
const CASE1 = `${SWITCH}.switch[1]`;
const MAPPING = `${CASE0}.processors[0]`;
const LOG = `${CASE0}.processors[1]`;
const OTHER = `${CASE1}.processors[0]`;

const at = (needle: string, severity: StatusDiagnostic['severity'], message: string): StatusDiagnostic => {
	const offset = yaml.indexOf(needle);
	assert.ok(offset >= 0, needle);
	return { offset, severity, message };
};

suite('core/nodeStatus (3.8, AD-17)', () => {
	test('MAP_LINT: a lint error mapped at its line\'s first non-whitespace character marks that processor, not its parent', () => {
		const status = nodeStatusOf(model, [at("- mapping: 'root.a", 'error', 'field nope not recognised')]);
		assert.deepStrictEqual(status[MAPPING], { severity: 'error', own: 'error', messages: ['field nope not recognised'], ownMessages: ['field nope not recognised'] });
		// The parents get the roll-up only.
		assert.deepStrictEqual(status[CASE0], { severity: 'error', messages: ['field nope not recognised'] });
		assert.deepStrictEqual(Object.keys(status), [SWITCH, CASE0, MAPPING]);
	});

	test('MAP_REDHAT: a precise range maps to the innermost node at its start', () => {
		const status = nodeStatusOf(model, [at('message: an a', 'warning', 'Property message is deprecated')]);
		assert.deepStrictEqual(status[LOG], { severity: 'warning', own: 'warning', messages: ['Property message is deprecated'], ownMessages: ['Property message is deprecated'] });
		assert.strictEqual(status[MAPPING], undefined);
	});

	test('ERROR_WINS: an error and a warning on one node give error, with both messages in document order', () => {
		const status = nodeStatusOf(model, [
			at("'root.other = true'", 'error', 'second'),
			at('- mapping: \'root.other', 'warning', 'first'),
		]);
		assert.deepStrictEqual(status[OTHER], { severity: 'error', own: 'error', messages: ['first', 'second'], ownMessages: ['first', 'second'] });
		const warnOnly = nodeStatusOf(model, [at('- mapping: \'root.other', 'warning', 'w'), at('- mapping: \'root.other', 'warning', 'w')]);
		assert.deepStrictEqual(warnOnly[OTHER], { severity: 'warning', own: 'warning', messages: ['w'], ownMessages: ['w'] }, 'duplicates removed');
	});

	test('ROLL_UP: an error inside a switch case marks the case route and the switch group, with no own', () => {
		const status = nodeStatusOf(model, [at('message: an a', 'error', 'boom')]);
		assert.deepStrictEqual(status[CASE0], { severity: 'error', messages: ['boom'] });
		assert.deepStrictEqual(status[SWITCH], { severity: 'error', messages: ['boom'] });
		assert.strictEqual(status[CASE1], undefined, 'the other case is clean');
		assert.strictEqual(status['path:input'], undefined);
	});

	test('OWN_AND_CHILD: a warning on a group\'s own line and an error inside it', () => {
		const status = nodeStatusOf(model, [
			at('message: an a', 'error', 'inner'),
			at('- switch:', 'warning', 'outer'),
		]);
		// OWN_MESSAGES: the group's own messages apart from its descendants'.
		assert.deepStrictEqual(status[SWITCH], { severity: 'error', own: 'warning', messages: ['outer', 'inner'], ownMessages: ['outer'] });
		assert.deepStrictEqual(status[LOG], { severity: 'error', own: 'error', messages: ['inner'], ownMessages: ['inner'] });
		// A route with no own diagnostics has neither `own` nor `ownMessages`.
		assert.deepStrictEqual(status[CASE0], { severity: 'error', messages: ['inner'] });
	});

	test('UNMAPPED: outside every node, Information and Hint are dropped; nothing throws', () => {
		const blank: PipelineModel = { nodes: [{ id: 'path:input', role: 'input', component: 'stdin', range: [0, 16] }], edges: [] };
		assert.deepStrictEqual(nodeStatusOf(blank, [{ offset: 17, severity: 'error', message: 'blank top-level line' }]), {});
		assert.deepStrictEqual(nodeStatusOf(model, [
			at('message: an a', 'information', 'info'),
			at('message: an a', 'hint', 'hint'),
		]), {});
		assert.deepStrictEqual(nodeStatusOf(null, [{ offset: 0, severity: 'error', message: 'x' }]), {});
		assert.deepStrictEqual(nodeStatusOf(model, []), {});
		const junk = [
			{ offset: Number.NaN, severity: 'error', message: 'x' },
			{ offset: 3, severity: 'fatal', message: 'x' },
			{ offset: 3, severity: 'error', message: 4 },
			null,
		] as unknown as StatusDiagnostic[];
		assert.doesNotThrow(() => nodeStatusOf(model, junk));
		assert.deepStrictEqual(nodeStatusOf(model, junk), {});
		// One bad entry does not wipe the good ones.
		const mixed = [null, 7, 'x', at('message: an a', 'error', 'kept')] as unknown as StatusDiagnostic[];
		assert.deepStrictEqual(nodeStatusOf(model, mixed)[LOG], { severity: 'error', own: 'error', messages: ['kept'], ownMessages: ['kept'] });
		// A parent cycle (never in a built model) does not loop.
		const cyclic: PipelineModel = {
			nodes: [
				{ id: 'a', role: 'processor', component: 'switch', group: true, range: [0, 10], parent: 'b' },
				{ id: 'b', role: 'route', range: [2, 8], parent: 'a' },
			],
			edges: [],
		};
		assert.doesNotThrow(() => nodeStatusOf(cyclic, [{ offset: 3, severity: 'error', message: 'x' }]));
	});

	test('deterministic: equal inputs serialise equally, whatever order the diagnostics come in', () => {
		const ds = [at('message: an a', 'error', 'a'), at('- switch:', 'warning', 'b'), at('stdin', 'warning', 'c')];
		assert.strictEqual(JSON.stringify(nodeStatusOf(model, ds)), JSON.stringify(nodeStatusOf(model, [...ds].reverse())));
	});
});
