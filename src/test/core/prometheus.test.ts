import * as assert from 'assert';
import { familyOf, parsePrometheus } from '../../core/prometheus';

// Ticket 7.2 (AD-25 R3): the Prometheus text parser.
suite('core/prometheus', () => {
	test('reads families, types, samples with labels, exponents and special values', () => {
		const text = [
			'# HELP processor_latency_ns Benthos Timing metric',
			'# TYPE processor_latency_ns summary',
			'processor_latency_ns{label="fast",path="root.pipeline.processors.0",quantile="0.5"} 2426',
			'processor_latency_ns_sum{label="fast",path="root.pipeline.processors.0"} 5.709848e+06',
			'processor_latency_ns_count{label="fast",path="root.pipeline.processors.0"} 197',
			'# TYPE input_received counter',
			'input_received{label="",path="root.input"} 197',
			'up +Inf',
			'down -Inf',
			'nothing NaN',
			'',
		].join('\n');
		const parsed = parsePrometheus(text);
		assert.deepStrictEqual([...parsed.types], [['processor_latency_ns', 'summary'], ['input_received', 'counter']]);
		assert.strictEqual(parsed.samples.length, 7);
		assert.deepStrictEqual(parsed.samples[0], {
			name: 'processor_latency_ns', labels: { label: 'fast', path: 'root.pipeline.processors.0', quantile: '0.5' }, value: 2426,
		});
		assert.strictEqual(parsed.samples[1].value, 5_709_848);
		assert.deepStrictEqual(parsed.samples[3], { name: 'input_received', labels: { label: '', path: 'root.input' }, value: 197 });
		assert.strictEqual(parsed.samples[4].value, Infinity);
		assert.strictEqual(parsed.samples[5].value, -Infinity);
		assert.ok(Number.isNaN(parsed.samples[6].value));
	});

	test('label escapes, spaces, a trailing comma, CRLF and a timestamp', () => {
		const parsed = parsePrometheus('m{a="x\\"y",b="back\\\\slash",c="new\\nline", d = "spaced" ,} 1 1700000000000\r\nn 2\r\n');
		assert.deepStrictEqual(parsed.samples, [
			{ name: 'm', labels: { a: 'x"y', b: 'back\\slash', c: 'new\nline', d: 'spaced' }, value: 1 },
			{ name: 'n', labels: {}, value: 2 },
		]);
	});

	test('bad lines and comments are skipped, never thrown on', () => {
		const parsed = parsePrometheus([
			'# a comment',
			'# TYPE odd notatype',
			'9bad 1',
			'm{a="unterminated} 1',
			'm{a=1} 1',
			'm{a="x"}1',
			'm abc',
			'm 1 2 3',
			'ok{a="1"} 3',
		].join('\n'));
		assert.deepStrictEqual(parsed.types.size, 0);
		assert.deepStrictEqual(parsed.samples, [{ name: 'ok', labels: { a: '1' }, value: 3 }]);
	});

	test('familyOf: the # TYPE type, else from the name', () => {
		const types = new Map([['processor_latency_ns', 'summary' as const], ['x_count', 'counter' as const]]);
		assert.deepStrictEqual(familyOf('processor_latency_ns_sum', types), { family: 'processor_latency_ns', type: 'summary' });
		assert.deepStrictEqual(familyOf('x_count', types), { family: 'x_count', type: 'counter' });
		assert.deepStrictEqual(familyOf('output_latency_ns_count', new Map()), { family: 'output_latency_ns', type: 'summary' });
		assert.deepStrictEqual(familyOf('output_latency_ns', new Map()), { family: 'output_latency_ns', type: 'summary' });
		assert.deepStrictEqual(familyOf('processor_received', new Map()), { family: 'processor_received', type: 'counter' });
	});
});
