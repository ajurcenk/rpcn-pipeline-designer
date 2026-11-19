import * as assert from 'assert';
import { componentCatalogue } from '../../core/catalogue';
import { buildPipelineModel, componentPaths } from '../../core/graph';
import {
	componentReadings, figures, hasComponentSeries, metricRows, metricsTypeOf, nodeFiguresOf, pathToNodeId, rate, sortRows, yamlPathOf, type MetricsReading,
} from '../../core/metrics';
import { parsePrometheus } from '../../core/prometheus';
import { parseYaml } from '../../core/yamlPath';
import { connectText } from '../helpers/fakeMetrics';
import { servedSchema } from '../helpers/schemas';

// Ticket 7.2 (AD-25 R3, R4): the figures, the series-to-node mapping and the rows.
const CATALOGUE = componentCatalogue(servedSchema('4.112.0'));
const configOf = (text: string) => {
	const parsed = parseYaml(text);
	return { model: buildPipelineModel(parsed, text, CATALOGUE), paths: componentPaths(parsed, text, CATALOGUE) };
};
const reading = (time: number, text: string): MetricsReading => ({ ...parsePrometheus(text), time });

const HAPPY = [
	'input:',
	'  generate:',
	'    mapping: root = 1',
	'pipeline:',
	'  processors:',
	'    - label: fast',
	'      mapping: root = this',
	'    - sleep:',
	'        duration: 5ms',
	'output:',
	'  drop: {}',
	'',
].join('\n');

const happyText = (n: number, p50 = 7700) => connectText([
	{ family: 'input', path: 'root.input', received: n },
	{ family: 'processor', path: 'root.pipeline.processors.0', label: 'fast', received: n, sent: n, errors: 0, p50, p99: 21_000 },
	{ family: 'processor', path: 'root.pipeline.processors.1', received: n, sent: n, errors: n / 10, p50: 5_170_000, p99: 5_620_000 },
	{ family: 'output', path: 'root.output', sent: n, errors: 0, p50: 87, p99: 4061 },
]) + 'input_latency_ns{label="",path="root.input",quantile="0.5"} 5210000\n';

suite('core/metrics', () => {
	test('HAPPY: four rows in config order, rates over the last two readings, the latencies as served', () => {
		const { model, paths } = configOf(HAPPY);
		const first = reading(1_000, happyText(100));
		const second = reading(3_000, happyText(500, 8000));
		const rows = metricRows(model, paths, figures(first, second));
		assert.deepStrictEqual(rows.map((r) => [r.kind, r.name, r.path, r.depth, r.inRate, r.outRate, r.errorRate, r.p50, r.p99]), [
			['input', 'generate', 'input', 0, null, 200, null, null, null],
			['processor', 'fast', 'pipeline.processors[0]', 0, 200, 200, 0, 8000, 21_000],
			['processor', 'sleep', 'pipeline.processors[1]', 0, 200, 200, 20, 5_170_000, 5_620_000],
			['output', 'drop', 'output', 0, null, 200, 0, 87, 4061],
		]);
		assert.deepStrictEqual(rows.map((r) => r.nodeId), ['path:input', 'label:fast', 'path:pipeline.processors[1]', 'path:output']);
	});

	test('FIRST_READING: latencies shown, rates none', () => {
		const { model, paths } = configOf(HAPPY);
		const rows = metricRows(model, paths, figures(undefined, reading(1_000, happyText(100))));
		assert.deepStrictEqual(rows.map((r) => [r.inRate, r.outRate, r.errorRate]), [[null, null, null], [null, null, null], [null, null, null], [null, null, null]]);
		assert.deepStrictEqual(rows.map((r) => r.p50), [null, 7700, 5_170_000, 87]);
	});

	test('COUNTER_RESET: a counter lower than before gives no rate, never a negative one; the next reading counts from it', () => {
		assert.strictEqual(rate(10, 30, 2000), 10);
		assert.strictEqual(rate(30, 10, 2000), null);
		assert.strictEqual(rate(undefined, 10, 2000), null);
		assert.strictEqual(rate(10, 10, 0), null);
		const a = reading(0, happyText(1000));
		const b = reading(2000, happyText(40));
		const c = reading(4000, happyText(240));
		const reset = figures(a, b);
		for (const f of reset.values()) {
			assert.ok(f.outRate === null, `${f.path}: ${f.outRate}`);
		}
		const after = [...figures(b, c).values()];
		assert.deepStrictEqual(after.map((f) => f.outRate), [100, 100, 100, 100]);
	});

	test('componentReadings: summed across label sets per path + label, the highest quantile kept, series without path ignored', () => {
		const text = [
			'processor_received{label="",path="root.pipeline.processors.0",pod="a"} 10',
			'processor_received{label="",path="root.pipeline.processors.0",pod="b"} 5',
			'processor_latency_ns{label="",path="root.pipeline.processors.0",pod="a",quantile="0.5"} 100',
			'processor_latency_ns{label="",path="root.pipeline.processors.0",pod="b",quantile="0.5"} 300',
			'processor_latency_ns{label="",path="root.pipeline.processors.0",pod="b",quantile="0.9"} 900',
			'processor_latency_ns{label="",path="root.pipeline.processors.0",pod="b",quantile="0.99"} NaN',
			'redpanda_cluster_features_enterprise_license_expiry_sec{pipeline_id="x"} 1',
			'processor_received{label="x"} 3',
		].join('\n');
		const parsed = parsePrometheus(text);
		const readings = [...componentReadings(parsed).values()];
		assert.strictEqual(readings.length, 1);
		assert.strictEqual(readings[0].received, 15);
		assert.strictEqual(readings[0].p50, 300);
		assert.strictEqual(readings[0].p99, undefined);
		assert.ok(hasComponentSeries(parsed));
		assert.ok(!hasComponentSeries(parsePrometheus('go_goroutines 3\nprocessor_received{label="x"} 3\n')));
	});

	test('yamlPathOf: root. dropped, .N written [N]', () => {
		assert.strictEqual(yamlPathOf('root.input'), 'input');
		assert.strictEqual(yamlPathOf('root.pipeline.processors.0'), 'pipeline.processors[0]');
		assert.strictEqual(yamlPathOf('root.pipeline.processors.1.branch.processors.0'), 'pipeline.processors[1].branch.processors[0]');
		assert.strictEqual(yamlPathOf('root.output.broker.outputs.2'), 'output.broker.outputs[2]');
		assert.strictEqual(yamlPathOf('root.processor_resources'), 'processor_resources');
	});

	const NESTED = [
		'input:',
		'  generate:',
		'    mapping: root = 1',
		'pipeline:',
		'  processors:',
		'    - label: dup',
		'      mapping: root = this',
		'    - branch:',
		'        processors:',
		'          - mapping: root = this',
		'          - resource: res_one',
		'    - label: dup',
		'      mapping: root = this',
		'output:',
		'  drop: {}',
		'processor_resources:',
		'  - label: res_one',
		'    mapping: root = this',
		'',
	].join('\n');

	test('MAPPING: a unique label, a resource label, a nested path, a duplicate label by path, an unknown series', () => {
		const { model, paths } = configOf(NESTED);
		assert.strictEqual(pathToNodeId(model, paths, 'root.pipeline.processors.0', 'dup'), 'label:dup');
		assert.strictEqual(pathToNodeId(model, paths, 'root.pipeline.processors.2', 'dup'), 'path:pipeline.processors[2]');
		assert.strictEqual(pathToNodeId(model, paths, 'root.pipeline.processors.1.branch.processors.0', ''), 'path:pipeline.processors[1].branch.processors[0]');
		assert.strictEqual(pathToNodeId(model, paths, 'root.processor_resources', 'res_one'), 'res:processor:res_one');
		assert.strictEqual(pathToNodeId(model, paths, 'root.input', ''), 'path:input');
		assert.strictEqual(pathToNodeId(model, paths, 'root.pipeline.processors.9', ''), undefined);
		assert.strictEqual(pathToNodeId(model, paths, 'root.pipeline.processors.9', 'nope'), undefined);
	});

	test('ORDER: rows in config order, nested ones indented under their parent, unmatched series last', () => {
		const { model, paths } = configOf(NESTED);
		const text = connectText([
			{ family: 'processor', path: 'root.zzz', label: 'ghost', received: 1 },
			{ family: 'processor', path: 'root.processor_resources', label: 'res_one', received: 1 },
			{ family: 'processor', path: 'root.pipeline.processors.1.branch.processors.0', received: 1 },
			{ family: 'processor', path: 'root.pipeline.processors.0', label: 'dup', received: 1 },
			{ family: 'processor', path: 'root.pipeline.processors.2', label: 'dup', received: 1 },
			{ family: 'input', path: 'root.input', received: 1 },
			{ family: 'processor', path: 'root.aaa', received: 1 },
		]);
		const rows = metricRows(model, paths, figures(undefined, reading(0, text)));
		assert.deepStrictEqual(rows.map((r) => [r.id, r.kind, r.name, r.path, r.depth]), [
			['path:input', 'input', 'generate', 'input', 0],
			['label:dup', 'processor', 'dup', 'pipeline.processors[0]', 0],
			['path:pipeline.processors[1]', 'processor', 'branch', 'pipeline.processors[1]', 0],
			['path:pipeline.processors[1].branch.processors[0]', 'processor', 'mapping', 'pipeline.processors[1].branch.processors[0]', 1],
			['path:pipeline.processors[1].branch.processors[1]', 'processor', 'resource', 'pipeline.processors[1].branch.processors[1]', 1],
			['path:pipeline.processors[2]', 'processor', 'dup', 'pipeline.processors[2]', 0],
			['path:output', 'output', 'drop', 'output', 0],
			['res:processor:res_one', 'resource', 'res_one', 'processor_resources[0]', 0],
			['series:root.aaa:', 'processor', 'aaa', 'aaa', 0],
			['series:root.zzz:ghost', 'processor', 'ghost', 'zzz', 0],
		]);
		assert.deepStrictEqual(rows.filter((r) => r.nodeId === null).map((r) => r.id), ['series:root.aaa:', 'series:root.zzz:ghost']);
	});

	test('NODE_FIGURES (7.3): the rows\' mapping by node id; the input\'s Out/s only; no group, route or unmatched series', () => {
		const { model, paths } = configOf(NESTED);
		const series = (n: number) => connectText([
			{ family: 'input', path: 'root.input', received: n },
			{ family: 'processor', path: 'root.pipeline.processors.0', label: 'dup', received: n, sent: n, errors: 0, p50: 7700, p99: 21_000 },
			{ family: 'processor', path: 'root.pipeline.processors.1', received: n, sent: n, p50: 9000, p99: 9000 },
			{ family: 'processor', path: 'root.pipeline.processors.1.branch.processors.0', received: n, sent: n, errors: n, p50: 100, p99: 200 },
			{ family: 'processor', path: 'root.processor_resources', label: 'res_one', received: n, sent: n, p50: 5, p99: 6 },
			{ family: 'processor', path: 'root.zzz', label: 'ghost', received: n },
		]);
		const all = figures(reading(0, series(100)), reading(2000, series(500)));
		const byId = nodeFiguresOf(model, paths, all);
		assert.deepStrictEqual(Object.keys(byId), [
			'path:input', 'label:dup', 'path:pipeline.processors[1].branch.processors[0]', 'res:processor:res_one',
		]);
		assert.deepStrictEqual(byId['path:input'], { kind: 'input', outRate: 200 });
		assert.deepStrictEqual(byId['label:dup'], { kind: 'component', inRate: 200, outRate: 200, errorRate: 0, p50: 7700, p99: 21_000 });
		// The same numbers as the tab's rows.
		for (const row of metricRows(model, paths, all)) {
			const f = row.nodeId === null ? undefined : byId[row.nodeId];
			if (f?.kind === 'component') {
				assert.deepStrictEqual([f.inRate, f.outRate, f.errorRate, f.p50, f.p99], [row.inRate, row.outRate, row.errorRate, row.p50, row.p99], row.id);
			}
		}
		// The first reading: latencies, no rates.
		assert.deepStrictEqual(nodeFiguresOf(model, paths, figures(undefined, reading(0, series(1))))['label:dup'],
			{ kind: 'component', inRate: null, outRate: null, errorRate: null, p50: 7700, p99: 21_000 });
	});

	test('NO_MODEL: without a model every series is listed, by path', () => {
		const rows = metricRows({ nodes: [], edges: [] }, new Map(), figures(undefined, reading(0, happyText(1))));
		assert.deepStrictEqual(rows.map((r) => r.path), ['input', 'output', 'pipeline.processors[0]', 'pipeline.processors[1]']);
	});

	test('sortRows: ascending, descending, rows with no figure last, stable; null keeps the order', () => {
		const { model, paths } = configOf(HAPPY);
		const rows = metricRows(model, paths, figures(reading(0, happyText(100)), reading(2000, happyText(300))));
		assert.deepStrictEqual(sortRows(rows, { column: 'p50', dir: 'desc' }).map((r) => r.name), ['sleep', 'fast', 'drop', 'generate']);
		assert.deepStrictEqual(sortRows(rows, { column: 'p50', dir: 'asc' }).map((r) => r.name), ['drop', 'fast', 'sleep', 'generate']);
		assert.deepStrictEqual(sortRows(rows, { column: 'in', dir: 'asc' }).map((r) => r.name), ['fast', 'sleep', 'generate', 'drop']);
		assert.deepStrictEqual(sortRows(rows, { column: 'name', dir: 'asc' }).map((r) => r.name), ['drop', 'fast', 'generate', 'sleep']);
		assert.deepStrictEqual(sortRows(rows, null).map((r) => r.name), ['generate', 'fast', 'sleep', 'drop']);
	});

	test('metricsTypeOf: the metrics section type, none by default, mapping not a type', () => {
		const type = (text: string) => metricsTypeOf(parseYaml(text));
		assert.strictEqual(type(HAPPY), undefined);
		assert.strictEqual(type(`${HAPPY}metrics:\n  prometheus: {}\n`), 'prometheus');
		assert.strictEqual(type(`${HAPPY}metrics:\n  none: {}\n`), 'none');
		assert.strictEqual(type(`${HAPPY}metrics:\n  mapping: root = this\n  json_api: {}\n`), 'json_api');
		assert.strictEqual(type(`${HAPPY}metrics:\n  mapping: root = this\n`), undefined);
		assert.strictEqual(type('input: [\n'), undefined);
	});
});
