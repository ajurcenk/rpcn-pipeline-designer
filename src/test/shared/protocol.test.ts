import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	EMPTY_MODEL,
	isPipelineModel,
	parseHostMessage,
	parseWebviewMessage,
	type HostMessage,
	type PipelineModel,
	type PipelineNode,
	type WebviewMessage,
} from '../../shared/protocol';
import { REPO_ROOT } from '../helpers/fakeBinary';

const FIXTURES = path.join(REPO_ROOT, 'src', 'test', 'fixtures', 'models');
const FIXTURE_NAMES = [
	'flat', 'labels', 'switch-processor', 'switch-output', 'broker-output',
	'branch', 'try-catch', 'workflow', 'nested', 'resources',
];

interface Fixture {
	readonly name: string;
	readonly yaml: string;
	readonly model: PipelineModel;
}

/** Reads a fixture pair; the JSON must pass the protocol's own model check to be typed. */
function fixture(name: string): Fixture {
	const yaml = fs.readFileSync(path.join(FIXTURES, `${name}.yaml`), 'utf8');
	const json: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.model.json`), 'utf8'));
	assert.ok(isPipelineModel(json), `${name}.model.json is a PipelineModel`);
	return { name, yaml, model: json };
}

const SAMPLE_MODEL: PipelineModel = {
	nodes: [
		{ id: 'label:in', role: 'input', component: 'stdin', label: 'in', range: [0, 18] },
		{ id: 'path:output', role: 'output', component: 'switch', range: [19, 80], group: true },
		{ id: 'path:output.switch.cases[0]', role: 'route', caption: 'case 0', range: [40, 80], parent: 'path:output' },
		{ id: 'path:output.switch.cases[0].output', role: 'output', component: 'drop', range: [50, 80], parent: 'path:output.switch.cases[0]' },
		{ id: 'path:pipeline.processors[1]', role: 'processor', component: 'log', label: 'in', range: [81, 90], duplicateLabel: true },
		{ id: 'res:cache:seen', role: 'resource', component: 'memory', label: 'seen', range: [91, 120] },
	],
	edges: [{ id: 'label:in->path:output', source: 'label:in', target: 'path:output', label: 'all' }],
};

const HOST_MESSAGES: readonly HostMessage[] = [
	{
		type: 'snapshot',
		model: SAMPLE_MODEL,
		parseError: { message: 'bad indentation', range: [3, 4] },
		nodeStatus: { 'label:in': { severity: 'error', messages: ['field foo not recognised'] } },
		selection: 'label:in',
		hostStatus: { binary: 'ok', schema: 'loading' },
	},
	{ type: 'snapshot', model: null, nodeStatus: {}, selection: null, hostStatus: { binary: 'missing', schema: 'none' } },
	{ type: 'snapshot', model: EMPTY_MODEL, nodeStatus: {}, selection: null, hostStatus: { binary: 'unresolved', schema: 'none' } },
	{ type: 'model', model: SAMPLE_MODEL },
	{ type: 'model', model: EMPTY_MODEL },
	{ type: 'parseError', message: 'unexpected end', range: [10, 10] },
	{ type: 'nodeStatus', byId: { 'path:output': { severity: 'warning', messages: ['deprecated', 'twice'] } } },
	{ type: 'nodeStatus', byId: {} },
	{ type: 'selection', nodeId: 'path:output' },
	{ type: 'selection', nodeId: null },
	{ type: 'hostStatus', binary: 'invalid', schema: 'ok' },
];

const WEBVIEW_MESSAGES: readonly WebviewMessage[] = [
	{ type: 'ready' },
	{ type: 'nodeActivated', nodeId: 'path:pipeline.processors[2]', via: 'click' },
	{ type: 'nodeActivated', nodeId: 'label:enrich', via: 'keyboard' },
	{ type: 'bannerClicked' },
	{ type: 'installGuideRequested' },
	{ type: 'setPathRequested' },
	{ type: 'retryRequested' },
];

/** Every message, as the other side receives it: a structured-clone-like copy. */
const roundTrip = (m: unknown): unknown => JSON.parse(JSON.stringify(m));

suite('shared/protocol (3.2)', () => {
	test('HOST_SHAPES: parseHostMessage returns each host message unchanged', () => {
		for (const message of HOST_MESSAGES) {
			assert.deepStrictEqual(parseHostMessage(roundTrip(message)), message, message.type);
		}
	});

	test('WEBVIEW_SHAPES: parseWebviewMessage returns each webview message', () => {
		for (const message of WEBVIEW_MESSAGES) {
			assert.deepStrictEqual(parseWebviewMessage(roundTrip(message)), message, message.type);
		}
		// Only the message's own fields are kept.
		assert.deepStrictEqual(parseWebviewMessage({ type: 'ready', extra: 1 }), { type: 'ready' });
	});

	test('MALFORMED: anything else is undefined, and nothing throws', () => {
		const node = SAMPLE_MODEL.nodes[0];
		const modelWith = (n: unknown): unknown => ({ nodes: [n], edges: [] });
		const snapshot = HOST_MESSAGES[1] as Record<string, unknown>;
		const hostBad: unknown[] = [
			null, undefined, 'snapshot', 42, [], [{ type: 'model', model: EMPTY_MODEL }],
			{}, { type: 'unknown' }, { type: 'ready' },
			{ type: 'model' }, { type: 'model', model: null }, { type: 'model', model: { nodes: [] } },
			{ type: 'model', model: { nodes: {}, edges: [] } },
			{ type: 'model', model: modelWith({ ...node, role: 'cache' }) },
			{ type: 'model', model: modelWith({ ...node, id: 7 }) },
			{ type: 'model', model: modelWith({ ...node, range: [5, 2] }) },
			{ type: 'model', model: modelWith({ ...node, range: [0] }) },
			{ type: 'model', model: modelWith({ ...node, range: [-1, 2] }) },
			{ type: 'model', model: modelWith({ ...node, range: [0.5, 2] }) },
			{ type: 'model', model: modelWith({ ...node, range: '0,18' }) },
			{ type: 'model', model: modelWith({ ...node, group: false }) },
			{ type: 'model', model: modelWith({ ...node, parent: null }) },
			{ type: 'model', model: modelWith(null) },
			{ type: 'model', model: { nodes: [], edges: [{ id: 'e', source: 'a' }] } },
			{ type: 'model', model: { nodes: [], edges: [{ id: 'e', source: 'a', target: 'b', label: 3 }] } },
			{ ...snapshot, model: undefined },
			{ ...snapshot, nodeStatus: undefined },
			{ ...snapshot, nodeStatus: { a: { severity: 'info', messages: [] } } },
			{ ...snapshot, nodeStatus: { a: { severity: 'error', messages: [1] } } },
			{ ...snapshot, nodeStatus: { a: null } },
			{ ...snapshot, selection: undefined },
			{ ...snapshot, selection: 3 },
			{ ...snapshot, hostStatus: { binary: 'ok' } },
			{ ...snapshot, hostStatus: { binary: 'gone', schema: 'ok' } },
			{ ...snapshot, parseError: { message: 'x' } },
			{ type: 'parseError', message: 'x' },
			{ type: 'parseError', range: [0, 1] },
			{ type: 'nodeStatus' },
			{ type: 'nodeStatus', byId: [] },
			{ type: 'selection' },
			{ type: 'selection', nodeId: 1 },
			{ type: 'hostStatus', binary: 'ok', schema: 'stale' },
		];
		for (const message of hostBad) {
			assert.strictEqual(parseHostMessage(message), undefined, JSON.stringify(message));
		}
		const webviewBad: unknown[] = [
			null, undefined, 'ready', 0, [], [{ type: 'ready' }], {}, { type: 'unknown' }, { type: 'snapshot' },
			{ type: 'nodeActivated' },
			{ type: 'nodeActivated', nodeId: 'a' },
			{ type: 'nodeActivated', nodeId: 'a', via: 'mouse' },
			{ type: 'nodeActivated', nodeId: 42, via: 'click' },
			{ type: 'nodeActivated', via: 'keyboard' },
			{ type: 'Ready' },
		];
		for (const message of webviewBad) {
			assert.strictEqual(parseWebviewMessage(message), undefined, JSON.stringify(message));
		}
		// A getter that throws is malformed too, not an exception.
		const hostile = Object.defineProperty({}, 'type', { get: () => { throw new Error('boom'); }, enumerable: true });
		assert.strictEqual(parseHostMessage(hostile), undefined);
		assert.strictEqual(parseWebviewMessage(hostile), undefined);
	});

	test('fixture set: every listed pair exists, and nothing else is in the folder', () => {
		const files = fs.readdirSync(FIXTURES).filter((f) => f !== 'README.md').sort();
		assert.deepStrictEqual(files, FIXTURE_NAMES.flatMap((n) => [`${n}.model.json`, `${n}.yaml`]).sort());
	});

	test('FIXTURES_TYPED: ids are unique; every parent and edge endpoint names a node of the same model', () => {
		for (const { name, model } of FIXTURE_NAMES.map(fixture)) {
			const ids = new Set(model.nodes.map((n) => n.id));
			assert.strictEqual(ids.size, model.nodes.length, `${name}: unique node ids`);
			assert.strictEqual(new Set(model.edges.map((e) => e.id)).size, model.edges.length, `${name}: unique edge ids`);
			for (const n of model.nodes) {
				if (n.parent !== undefined) {
					assert.ok(ids.has(n.parent), `${name}: parent of ${n.id}`);
					const parent = model.nodes.find((p) => p.id === n.parent)!;
					assert.ok(parent.group === true || parent.role === 'route', `${name}: ${n.parent} is a group or a route`);
				}
				assert.strictEqual(n.role === 'route', n.component === undefined, `${name}: ${n.id} has a component unless it is a route`);
				if (n.role === 'route') {
					assert.ok(n.parent !== undefined, `${name}: route ${n.id} is inside a group`);
				}
				if (n.id.startsWith('label:')) {
					assert.strictEqual(n.id, `label:${n.label}`, `${name}: ${n.id}`);
				} else if (n.id.startsWith('res:')) {
					assert.strictEqual(n.role, 'resource', `${name}: ${n.id}`);
					assert.ok(n.id.endsWith(`:${n.label}`), `${name}: ${n.id}`);
				} else {
					assert.ok(n.id.startsWith('path:'), `${name}: ${n.id}`);
				}
			}
			for (const e of model.edges) {
				assert.ok(ids.has(e.source), `${name}: edge source ${e.source}`);
				assert.ok(ids.has(e.target), `${name}: edge target ${e.target}`);
			}
		}
	});

	test('FIXTURE_RANGES: each range starts at its key or `- ` item and ends at its value\'s end', () => {
		for (const { name, yaml, model } of FIXTURE_NAMES.map(fixture)) {
			const byId = new Map<string, PipelineNode>(model.nodes.map((n) => [n.id, n]));
			for (const n of model.nodes) {
				const [start, end] = n.range;
				const text = yaml.slice(start, end);
				const where = `${name}: ${n.id} ${JSON.stringify(text)}`;
				assert.ok(end <= yaml.length && start < end, where);
				// The start: an item's `- `, or the node's own key.
				const lastSegment = /\.([^.[\]]+)$/.exec(n.id)?.[1] ?? (/^path:([^.[\]]+)$/.exec(n.id)?.[1]);
				if (text.startsWith('- ')) {
					assert.ok(!n.id.startsWith('path:') || n.id.endsWith(']'), `${where}: an item has an indexed path`);
				} else {
					const key = /^([\w-]+):/.exec(text)?.[1];
					assert.ok(key, `${where}: starts with a key`);
					if (n.id.startsWith('path:')) {
						assert.strictEqual(key, lastSegment, `${where}: starts with its own key`);
					}
				}
				const lineStart = yaml.lastIndexOf('\n', start - 1) + 1;
				// Only indentation precedes it on its line, or the `- ` of the item whose first key it is.
				assert.ok(/^ *(- )?$/.test(yaml.slice(lineStart, start)), `${where}: starts its line's content`);
				// The end: no trailing whitespace, nothing after it on its line, and the next
				// line with content is not indented under the node.
				assert.ok(/\S/.test(yaml[end - 1]), `${where}: ends on a value character`);
				const lineEnd = yaml.indexOf('\n', end);
				assert.ok(/^\s*$/.test(yaml.slice(end, lineEnd < 0 ? undefined : lineEnd)), `${where}: ends its line`);
				const next = lineEnd < 0 ? undefined : /^( *)\S/m.exec(yaml.slice(lineEnd + 1));
				if (next) {
					assert.ok(next[1].length <= start - lineStart, `${where}: the next line is outside the value`);
				}
				// Nesting: a child lies inside its parent.
				if (n.parent) {
					const p = byId.get(n.parent)!;
					assert.ok(p.range[0] <= start && end <= p.range[1], `${where}: inside ${n.parent}`);
				}
			}
		}
	});

	test('AD7_IDS: labels fixture: label ids, and a path id with duplicateLabel for the repeat', () => {
		const { model } = fixture('labels');
		assert.deepStrictEqual(model.nodes.map((n) => [n.id, n.label, n.duplicateLabel]), [
			['label:ticks', 'ticks', undefined],
			['label:enrich', 'enrich', undefined],
			['path:pipeline.processors[1]', undefined, undefined],
			['path:pipeline.processors[2]', 'enrich', true],
			['label:sink', 'sink', undefined],
		]);
	});
});
