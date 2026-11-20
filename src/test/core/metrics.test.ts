import * as assert from 'assert';
import { componentCatalogue } from '../../core/catalogue';
import { buildPipelineModel, componentPaths } from '../../core/graph';
import {
	bottleneck, compactReading, componentReadings, figures, gapOf, hasComponentSeries, increase, keepReading, MAX_WINDOW_MS, metricRows, metricsSummary, metricsTypeOf,
	nodeFiguresOf, pathToNodeId, sortRows, yamlPathOf, type CompactReading, type MetricsReading,
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
/** The figures of `readings` (oldest first) over the whole of them. */
const fig = (...readings: MetricsReading[]) => figures(readings.map(compactReading), MAX_WINDOW_MS);

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
	test('HAPPY: four rows in config order, rates over two readings (one interval), the latencies as served', () => {
		const { model, paths } = configOf(HAPPY);
		const first = reading(1_000, happyText(100));
		const second = reading(3_000, happyText(500, 8000));
		const rows = metricRows(model, paths, fig(first, second));
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
		const rows = metricRows(model, paths, fig(reading(1_000, happyText(100))));
		assert.deepStrictEqual(rows.map((r) => [r.inRate, r.outRate, r.errorRate, r.errorShare, r.mean]), Array(4).fill([null, null, null, null, null]));
		assert.deepStrictEqual(rows.map((r) => r.p50), [null, 7700, 5_170_000, 87]);
		assert.deepStrictEqual(rows.map((r) => r.trend), [[], [], [], []]);
	});

	test('RESET (7.6): a counter that goes back counts its new value as the increase (as rate()), never a negative rate', () => {
		assert.strictEqual(increase(10, 30), 20);
		assert.strictEqual(increase(30, 10), 10);
		assert.strictEqual(increase(undefined, 10), 10);
		assert.strictEqual(increase(10, undefined), undefined);
		const a = reading(0, happyText(1000));
		const b = reading(2000, happyText(1200));
		const c = reading(4000, happyText(40));
		const d = reading(6000, happyText(240));
		const reset = fig(b, c);
		for (const f of reset.values()) {
			assert.strictEqual(f.outRate, 20, f.path);
		}
		const all = [...fig(a, b, c, d).values()];
		for (const f of all) {
			assert.ok((f.outRate ?? -1) >= 0, `${f.path}: ${f.outRate}`);
			assert.strictEqual(f.outRate, (200 + 40 + 200) / 6, f.path);
			assert.deepStrictEqual(f.trend, [100, 20, 100], f.path);
		}
	});

	const podText = (pods: Record<string, number>) => connectText(Object.entries(pods).map(([pod, n]) => (
		{ family: 'processor' as const, path: 'root.pipeline.processors.0', pod, received: n, sent: n })));

	test('NEW_POD (7.6): a pod the reading before did not have is a restart for that pod; the pods are summed', () => {
		const f = fig(
			reading(0, podText({ a: 1000 })),
			reading(2000, podText({ a: 1200 })),
			reading(4000, podText({ b: 50 })),
			reading(6000, podText({ b: 250 })),
		).get('root.pipeline.processors.0\u0000')!;
		assert.strictEqual(f.outRate, (200 + 50 + 200) / 6);
		assert.deepStrictEqual(f.trend, [100, 25, 100]);
		const two = fig(reading(0, podText({ a: 100, b: 100 })), reading(2000, podText({ a: 300, b: 500 }))).get('root.pipeline.processors.0\u0000')!;
		assert.strictEqual(two.inRate, 300, 'both pods\' increases');
	});

	test('MISSING (7.6): a component missing from a reading adds nothing for the intervals around it; its running total is not counted', () => {
		const other = connectText([{ family: 'output', path: 'root.output', sent: 1 }]);
		const f = fig(
			reading(0, podText({ a: 100 })),
			reading(2000, other),
			reading(4000, podText({ a: 300 })),
			reading(6000, podText({ a: 400 })),
		).get('root.pipeline.processors.0\u0000')!;
		assert.strictEqual(f.outRate, 100 / 6, 'only the 4 s → 6 s interval counts');
		assert.deepStrictEqual(f.trend, [50]);
	});

	test('WINDOWS (7.6): 100/s for 10 min then 300/s: 1 and 5 min show 300/s, 15 min the mean of both; each its own trend', () => {
		let kept: CompactReading[] = [];
		let n = 0;
		for (let t = 0; t <= 15 * 60_000; t += 2000) {
			if (t > 0) {
				n += t <= 10 * 60_000 ? 200 : 600;
			}
			kept = keepReading(kept, compactReading(reading(t, happyText(n))));
		}
		assert.strictEqual(kept.length, 451);
		const out = (minutes: number) => figures(kept, minutes * 60_000).get('root.output\u0000')!;
		assert.strictEqual(out(1).outRate, 300);
		assert.strictEqual(out(5).outRate, 300);
		assert.ok(Math.abs(out(15).outRate! - (100 * 600 + 300 * 300) / 900) < 1e-9, String(out(15).outRate));
		assert.strictEqual(out(1).trend.length, 30);
		assert.ok(out(1).trend.every((p) => p === 300));
		assert.strictEqual(out(5).trend.length, 150);
		assert.strictEqual(out(15).trend.length, 450);
		assert.deepStrictEqual([out(15).trend[0], out(15).trend.at(-1)], [100, 300]);
		// WINDOW CHANGE: the same readings over another window, no new reading needed.
		assert.notStrictEqual(out(15).outRate, out(1).outRate);
	});

	test('OLDER_THAN_15_MIN (7.6): readings more than 15 minutes older than the last are dropped; an older reading is not added', () => {
		const r = (t: number) => compactReading(reading(t, happyText(t / 1000)));
		let kept = keepReading([], r(0));
		kept = keepReading(kept, r(60_000));
		kept = keepReading(kept, r(MAX_WINDOW_MS));
		assert.deepStrictEqual(kept.map((x) => x.time), [0, 60_000, MAX_WINDOW_MS]);
		kept = keepReading(kept, r(MAX_WINDOW_MS + 1));
		assert.deepStrictEqual(kept.map((x) => x.time), [60_000, MAX_WINDOW_MS, MAX_WINDOW_MS + 1]);
		assert.deepStrictEqual(keepReading(kept, r(30_000)).map((x) => x.time), [60_000, MAX_WINDOW_MS, MAX_WINDOW_MS + 1]);
		assert.deepStrictEqual(figures([], 60_000).size, 0);
	});

	const fullText = (n: number, extra: { received?: number; sum?: number; count?: number; p90?: number; pod?: string } = {}) => connectText([
		{
			family: 'processor', path: 'root.pipeline.processors.0', pod: extra.pod, received: extra.received ?? n, sent: n, errors: n / 20,
			batchesIn: n / 10, batchesOut: n / 10, p50: 100, p90: extra.p90 ?? 900, p99: 990, sum: extra.sum ?? n * 1000, count: extra.count ?? n,
		},
		{ family: 'output', path: 'root.output', sent: n, batchesOut: n / 5, errors: 0, p50: 10, p90: 50, p99: 99, sum: n * 20, count: n },
	]);

	test('BATCHES / ERRORS / MEAN / P90 (7.6): batches in and out per second, errors per second and as a share of received, mean over the window', () => {
		const all = fig(reading(0, fullText(100)), reading(2000, fullText(300)), reading(4000, fullText(500)));
		const p = all.get('root.pipeline.processors.0\u0000')!;
		assert.deepStrictEqual([p.inRate, p.outRate, p.batchInRate, p.batchOutRate, p.errorRate, p.errorShare, p.p50, p.p90, p.p99, p.mean],
			[100, 100, 10, 10, 5, 0.05, 100, 900, 990, 1000]);
		const o = all.get('root.output\u0000')!;
		assert.deepStrictEqual([o.inRate, o.outRate, o.batchInRate, o.batchOutRate, o.errorRate, o.errorShare, o.p90, o.mean],
			[null, 100, null, 20, 0, null, 50, 20], 'an output: no In/s, no batches in, no error share');
		// Nothing received over the window: no error share; no count: no mean.
		const idle = fig(reading(0, fullText(100)), reading(2000, fullText(100))).get('root.pipeline.processors.0\u0000')!;
		assert.deepStrictEqual([idle.errorRate, idle.errorShare, idle.mean], [0, null, null]);
		// The mean is Δsum / Δcount over the window, not the process's whole sum / count.
		const mean = fig(reading(0, fullText(100, { sum: 1_000_000, count: 100 })), reading(2000, fullText(300, { sum: 1_000_000 + 200 * 50, count: 300 })));
		assert.strictEqual(mean.get('root.pipeline.processors.0\u0000')!.mean, 50);
		// p90: the latest reading's, the highest across pods.
		const pods = reading(0, fullText(1, { pod: 'a', p90: 300 }) + fullText(1, { pod: 'b', p90: 700 }));
		assert.strictEqual(fig(pods).get('root.pipeline.processors.0\u0000')!.p90, 700);
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
		assert.deepStrictEqual([...readings[0].pods].map(([pod, c]) => [pod, c.received]), [['a', 10], ['b', 5]], 'kept per pod');
		assert.strictEqual(readings[0].p50, 300);
		assert.strictEqual(readings[0].p90, 900);
		assert.strictEqual(readings[0].p99, undefined);
		assert.strictEqual(fig(reading(0, text), reading(1000, text.replace('pod="a"} 10', 'pod="a"} 20'))).get('root.pipeline.processors.0\u0000')!.inRate, 10,
			'summed across pods');
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
		const rows = metricRows(model, paths, fig(reading(0, text)));
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
		const all = fig(reading(0, series(100)), reading(2000, series(500)));
		const byId = nodeFiguresOf(model, paths, all);
		assert.deepStrictEqual(Object.keys(byId), [
			'path:input', 'label:dup', 'path:pipeline.processors[1].branch.processors[0]', 'res:processor:res_one',
		]);
		assert.deepStrictEqual(byId['path:input'], { kind: 'input', outRate: 200 });
		assert.deepStrictEqual(byId['label:dup'], { kind: 'component', inRate: 200, outRate: 200, errorRate: 0, p50: 7700, p99: 21_000, share: null });
		// Ticket 7.7: a component with errors is marked (no `_sum` here, so no share and no slowest).
		assert.deepStrictEqual(byId['path:pipeline.processors[1].branch.processors[0]'],
			{ kind: 'component', inRate: 200, outRate: 200, errorRate: 200, p50: 100, p99: 200, share: null, hasErrors: true });
		// The same numbers as the tab's rows.
		for (const row of metricRows(model, paths, all)) {
			const f = row.nodeId === null ? undefined : byId[row.nodeId];
			if (f?.kind === 'component') {
				assert.deepStrictEqual([f.inRate, f.outRate, f.errorRate, f.p50, f.p99], [row.inRate, row.outRate, row.errorRate, row.p50, row.p99], row.id);
			}
		}
		// The first reading: latencies, no rates.
		assert.deepStrictEqual(nodeFiguresOf(model, paths, fig(reading(0, series(1))))['label:dup'],
			{ kind: 'component', inRate: null, outRate: null, errorRate: null, p50: 7700, p99: 21_000, share: null });
	});

	// Ticket 7.7 (E7 R6): the bottleneck. Each component spends its p50 per message (`_sum` grows by it).
	const timedText = (n: number, opts: { readonly out?: number; readonly fastErrors?: number; readonly fastNs?: number } = {}) => connectText([
		{ family: 'input', path: 'root.input', received: n },
		{ family: 'processor', path: 'root.pipeline.processors.0', label: 'fast', received: n, sent: n, errors: opts.fastErrors ?? 0, p50: 7700, sum: n * (opts.fastNs ?? 7700), count: n },
		{ family: 'processor', path: 'root.pipeline.processors.1', received: n, sent: n, errors: 0, p50: 5_170_000, sum: n * 5_170_000, count: n },
		{ family: 'output', path: 'root.output', sent: opts.out ?? n, errors: 0, p50: 87, sum: n * 87, count: n },
	]);
	const TOTAL = 7700 + 5_170_000 + 87;

	test('SLEEP (7.7): the sleep is the slowest, with its share of the pipeline\'s time; the tab, the graph and the summary agree', () => {
		const { model, paths } = configOf(HAPPY);
		const all = fig(reading(0, timedText(100)), reading(2000, timedText(500)));
		const rows = metricRows(model, paths, all);
		assert.deepStrictEqual(rows.map((r) => [r.name, r.share, r.slowest, r.hasErrors]), [
			['generate', null, false, false],
			['fast', 7700 / TOTAL, false, false],
			['sleep', 5_170_000 / TOTAL, true, false],
			['drop', 87 / TOTAL, false, false],
		]);
		const byId = nodeFiguresOf(model, paths, all);
		assert.deepStrictEqual(byId['path:pipeline.processors[1]'], {
			kind: 'component', inRate: 200, outRate: 200, errorRate: 0, p50: 5_170_000, p99: 0, share: 5_170_000 / TOTAL, slowest: true,
		});
		assert.deepStrictEqual(Object.entries(byId).filter(([, f]) => f.kind === 'component' && f.slowest).map(([id]) => id), ['path:pipeline.processors[1]']);
		assert.deepStrictEqual(byId['path:input'], { kind: 'input', outRate: 200 });
		assert.strictEqual(bottleneck(model, paths, all).slowest, 'root.pipeline.processors.1\u0000');
		assert.deepStrictEqual(metricsSummary(rows), {
			slowest: { name: 'sleep', path: 'pipeline.processors[1]', share: 5_170_000 / TOTAL, p50: 5_170_000 },
			inputRate: 200, outputRate: 200, gap: null, errors: [],
		});
	});

	test('NESTED (7.7): a sleep inside a branch is marked, not the branch; every component\'s share is of the same total', () => {
		const config = [
			'input:', '  generate:', '    mapping: root = 1',
			'pipeline:', '  processors:', '    - mapping: root = this', '    - branch:', '        processors:', '          - sleep:', '              duration: 5ms',
			'output:', '  drop: {}', '',
		].join('\n');
		const { model, paths } = configOf(config);
		const text = (n: number) => connectText([
			{ family: 'input', path: 'root.input', received: n },
			{ family: 'processor', path: 'root.pipeline.processors.0', received: n, sent: n, sum: n * 1000, count: n },
			{ family: 'processor', path: 'root.pipeline.processors.1', received: n, sent: n, sum: n * 6000, count: n },
			{ family: 'processor', path: 'root.pipeline.processors.1.branch.processors.0', received: n, sent: n, sum: n * 5000, count: n },
			{ family: 'output', path: 'root.output', sent: n, sum: n * 3000, count: n },
		]);
		const all = fig(reading(0, text(10)), reading(1000, text(20)));
		const rows = metricRows(model, paths, all);
		assert.deepStrictEqual(rows.map((r) => [r.path, r.share, r.slowest]), [
			['input', null, false],
			['pipeline.processors[0]', 0.1, false],
			['pipeline.processors[1]', 0.6, false],
			['pipeline.processors[1].branch.processors[0]', 0.5, true],
			['output', 0.3, false],
		]);
		const sleep = nodeFiguresOf(model, paths, all)['path:pipeline.processors[1].branch.processors[0]'];
		assert.ok(sleep?.kind === 'component' && sleep.slowest === true && sleep.share === 0.5);
		// The top-level shares make the whole.
		assert.ok(Math.abs(0.1 + 0.6 + 0.3 - 1) < 1e-9);
	});

	// The shapes a real binary (4.100.0) reports: a `resource:` processor has no series of its own; the
	// resource's are at `root.processor_resources` (with its label), its children's under it with no label.
	test('RESOURCE (7.7): the resource\'s time is in the total (its `resource:` user reports none); shares sum to at most 1; the sleeping resource is the slowest', () => {
		const config = [
			'input:', '  generate:', '    mapping: root = 1',
			'pipeline:', '  processors:', '    - mapping: root = this', '    - resource: res_one',
			'output:', '  drop: {}',
			'processor_resources:', '  - label: res_one', '    sleep:', '      duration: 5ms', '',
		].join('\n');
		const { model, paths } = configOf(config);
		const text = (n: number) => connectText([
			{ family: 'input', path: 'root.input', received: n },
			{ family: 'processor', path: 'root.pipeline.processors.0', received: n, sent: n, sum: n * 1000, count: n },
			{ family: 'processor', path: 'root.processor_resources', label: 'res_one', received: n, sent: n, sum: n * 5000, count: n },
			{ family: 'output', path: 'root.output', sent: n, sum: n * 100, count: n },
		]);
		const all = fig(reading(0, text(10)), reading(1000, text(20)));
		const rows = metricRows(model, paths, all);
		const shares = rows.map((r) => r.share ?? 0);
		assert.ok(shares.reduce((a, b) => a + b, 0) <= 1 + 1e-9, String(shares));
		assert.ok(shares.every((x) => x <= 1));
		assert.deepStrictEqual(rows.filter((r) => r.slowest).map((r) => r.id), ['res:processor:res_one']);
		assert.ok(Math.abs(rows.find((r) => r.id === 'res:processor:res_one')!.share! - 5000 / 6100) < 1e-12);
		const node = nodeFiguresOf(model, paths, all)['res:processor:res_one'];
		assert.ok(node?.kind === 'component' && node.slowest === true, JSON.stringify(node));
	});

	test('RESOURCE LEAF (7.7): a resource is a leaf by its config node, not by the series under `root.processor_resources.`; with no config, every resource is', () => {
		const config = [
			'input:', '  generate:', '    mapping: root = 1',
			'pipeline:', '  processors:', '    - resource: res_a', '    - resource: res_b',
			'output:', '  drop: {}',
			'processor_resources:',
			'  - label: res_a', '    branch:', '      processors:', '        - mapping: root = this',
			'  - label: res_b', '    mapping: root = this', '',
		].join('\n');
		const { model, paths } = configOf(config);
		const text = (n: number) => connectText([
			{ family: 'processor', path: 'root.processor_resources', label: 'res_a', received: n, sent: n, sum: n * 6000, count: n },
			{ family: 'processor', path: 'root.processor_resources.branch.processors.0', received: n, sent: n, sum: n * 500, count: n },
			{ family: 'processor', path: 'root.processor_resources', label: 'res_b', received: n, sent: n, sum: n * 3000, count: n },
			{ family: 'output', path: 'root.output', sent: n, sum: n * 100, count: n },
		]);
		const all = fig(reading(0, text(10)), reading(1000, text(20)));
		assert.ok(model.nodes.some((n) => n.parent === 'res:processor:res_a'), 'res_a has a child component');
		// res_a has a child component: not a leaf; the childless res_b is the slowest (the child is smaller).
		assert.strictEqual(bottleneck(model, paths, all).slowest, 'root.processor_resources\u0000res_b');
		assert.deepStrictEqual(metricRows(model, paths, all).filter((r) => r.slowest).map((r) => r.id), ['res:processor:res_b']);
		// The child is nested in a resource by path: not added to the total.
		assert.strictEqual(all.get('root.processor_resources\u0000res_a')!.share, 6000 / 9100);
		// No config (an unmapped Cloud pipeline): every resource is a leaf.
		assert.strictEqual(bottleneck({ nodes: [], edges: [] }, new Map(), all).slowest, 'root.processor_resources\u0000res_a');
	});

	test('BROKER OUTPUT (7.7): no `root.output` series: the flow names the input\'s rate only, and no gap', () => {
		const config = [
			'input:', '  generate:', '    mapping: root = 1',
			'pipeline:', '  processors:', '    - mapping: root = this',
			'output:', '  broker:', '    pattern: fan_out', '    outputs:', '      - drop: {}', '      - drop: {}', '',
		].join('\n');
		const { model, paths } = configOf(config);
		const text = (n: number) => connectText([
			{ family: 'input', path: 'root.input', received: n },
			{ family: 'processor', path: 'root.pipeline.processors.0', received: n, sent: n, sum: n * 1000, count: n },
			{ family: 'output', path: 'root.output.broker.outputs.0', sent: n, sum: n * 100, count: n },
			{ family: 'output', path: 'root.output.broker.outputs.1', sent: n / 2, sum: n * 100, count: n },
		]);
		const all = fig(reading(0, text(0)), reading(2000, text(400)));
		const summary = metricsSummary(metricRows(model, paths, all))!;
		assert.deepStrictEqual([summary.inputRate, summary.outputRate, summary.gap], [200, null, null]);
		assert.strictEqual(metricsSummary(metricRows({ nodes: [], edges: [] }, new Map(), all))!.outputRate, null, 'no config either');
		// Both broker outputs are top-level outputs in the total.
		assert.ok(Math.abs(all.get('root.output.broker.outputs.0\u0000')!.share! - 100 / 1200) < 1e-12);
	});

	test('ERRORS (7.7): a processor with errors over the window is marked on its row and node and named in the summary; none: "none", no marks', () => {
		const { model, paths } = configOf(HAPPY);
		const all = fig(reading(0, timedText(100)), reading(2000, timedText(500, { fastErrors: 10 })));
		const rows = metricRows(model, paths, all);
		assert.deepStrictEqual(rows.filter((r) => r.hasErrors).map((r) => r.name), ['fast']);
		const fast = nodeFiguresOf(model, paths, all)['label:fast'];
		assert.ok(fast?.kind === 'component' && fast.hasErrors === true && fast.slowest === undefined);
		assert.deepStrictEqual(metricsSummary(rows)?.errors, [{ name: 'fast', rate: 5 }]);
		// None: no row or node marked.
		const clean = fig(reading(0, timedText(100)), reading(2000, timedText(500)));
		const cleanRows = metricRows(model, paths, clean);
		assert.ok(cleanRows.every((r) => !r.hasErrors));
		assert.ok(Object.values(nodeFiguresOf(model, paths, clean)).every((f) => f.kind === 'input' || f.hasErrors === undefined));
		assert.deepStrictEqual(metricsSummary(cleanRows)?.errors, []);
	});

	test('GAP (7.7): named when the output\'s rate differs from the input\'s by more than 5%; else none', () => {
		const { model, paths } = configOf(HAPPY);
		const gap = metricsSummary(metricRows(model, paths, fig(reading(0, timedText(0)), reading(2000, timedText(400, { out: 300 })))))!;
		assert.deepStrictEqual([gap.inputRate, gap.outputRate, gap.gap], [200, 150, { rate: 50, share: 0.25 }]);
		const close = metricsSummary(metricRows(model, paths, fig(reading(0, timedText(0)), reading(2000, timedText(400, { out: 390 })))))!;
		assert.deepStrictEqual([close.inputRate, close.outputRate, close.gap], [200, 195, null]);
		assert.strictEqual(gapOf(200, 200), null);
		assert.strictEqual(gapOf(200, 190), null, 'exactly 5%: no gap');
		assert.deepStrictEqual(gapOf(200, 189), { rate: 11, share: 0.055 });
		assert.deepStrictEqual(gapOf(200, 250), { rate: -50, share: -0.25 });
		assert.strictEqual(gapOf(0, 0), null);
		assert.deepStrictEqual(gapOf(0, 5), { rate: -5, share: null });
		assert.strictEqual(gapOf(null, 5), null);
		assert.strictEqual(gapOf(5, null), null);
	});

	test('FIRST_READING (7.7): no rates: no share, no slowest, no summary', () => {
		const { model, paths } = configOf(HAPPY);
		const all = fig(reading(0, timedText(100)));
		const rows = metricRows(model, paths, all);
		assert.ok(rows.every((r) => r.share === null && !r.slowest && !r.hasErrors));
		assert.strictEqual(metricsSummary(rows), null);
		assert.ok(Object.values(nodeFiguresOf(model, paths, all)).every((f) => f.kind === 'input' || (f.share === null && f.slowest === undefined)));
		// No messages in the window (rates 0, no time spent): no share either, but a summary.
		const idle = metricRows(model, paths, fig(reading(0, timedText(100)), reading(2000, timedText(100))));
		assert.ok(idle.every((r) => r.share === null && !r.slowest));
		assert.deepStrictEqual(metricsSummary(idle), { slowest: null, inputRate: 0, outputRate: 0, gap: null, errors: [] });
	});

	test('TIE (7.7): the first in config order is the slowest', () => {
		const { model, paths } = configOf(HAPPY);
		const tie = (n: number) => connectText([
			{ family: 'processor', path: 'root.pipeline.processors.1', received: n, sent: n, sum: n * 10, count: n },
			{ family: 'processor', path: 'root.pipeline.processors.0', label: 'fast', received: n, sent: n, sum: n * 10, count: n },
		]);
		const rows = metricRows(model, paths, fig(reading(0, tie(0)), reading(1000, tie(10))));
		assert.deepStrictEqual(rows.filter((r) => r.slowest).map((r) => r.name), ['fast']);
	});

	test('SORT (7.7): by Share, the input last', () => {
		const { model, paths } = configOf(HAPPY);
		const rows = metricRows(model, paths, fig(reading(0, timedText(100)), reading(2000, timedText(500))));
		assert.deepStrictEqual(sortRows(rows, { column: 'share', dir: 'desc' }).map((r) => r.name), ['sleep', 'fast', 'drop', 'generate']);
		assert.deepStrictEqual(sortRows(rows, { column: 'share', dir: 'asc' }).map((r) => r.name), ['drop', 'fast', 'sleep', 'generate']);
	});

	test('NO_MODEL: without a model every series is listed, by path', () => {
		const rows = metricRows({ nodes: [], edges: [] }, new Map(), fig(reading(0, happyText(1))));
		assert.deepStrictEqual(rows.map((r) => r.path), ['input', 'output', 'pipeline.processors[0]', 'pipeline.processors[1]']);
	});

	test('sortRows: ascending, descending, rows with no figure last, stable; null keeps the order', () => {
		const { model, paths } = configOf(HAPPY);
		const rows = metricRows(model, paths, fig(reading(0, happyText(100)), reading(2000, happyText(300))));
		assert.deepStrictEqual(sortRows(rows, { column: 'p50', dir: 'desc' }).map((r) => r.name), ['sleep', 'fast', 'drop', 'generate']);
		assert.deepStrictEqual(sortRows(rows, { column: 'p50', dir: 'asc' }).map((r) => r.name), ['drop', 'fast', 'sleep', 'generate']);
		assert.deepStrictEqual(sortRows(rows, { column: 'in', dir: 'asc' }).map((r) => r.name), ['fast', 'sleep', 'generate', 'drop']);
		assert.deepStrictEqual(sortRows(rows, { column: 'name', dir: 'asc' }).map((r) => r.name), ['drop', 'fast', 'generate', 'sleep']);
		assert.deepStrictEqual(sortRows(rows, null).map((r) => r.name), ['generate', 'fast', 'sleep', 'drop']);
		// Ticket 7.6: every figure column sorts.
		assert.deepStrictEqual(sortRows(rows, { column: 'errorShare', dir: 'desc' }).map((r) => r.name), ['sleep', 'fast', 'generate', 'drop']);
		assert.deepStrictEqual(sortRows(rows, { column: 'errors', dir: 'desc' }).map((r) => r.name), ['sleep', 'fast', 'drop', 'generate']);
		for (const column of ['batchesIn', 'batchesOut', 'p90', 'mean'] as const) {
			assert.strictEqual(sortRows(rows, { column, dir: 'asc' }).length, 4, column);
		}
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
