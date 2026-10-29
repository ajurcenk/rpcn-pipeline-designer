import * as assert from 'assert';
import { envReferenceAt, envUsage } from '../../core/envUsage';

// Ticket 31: the variables a config uses, for the Environment view's Missing group.
suite('core/envUsage', () => {
	test('MISSING: ${NAME} and env("NAME") are required; ${NAME:default} is not', () => {
		const text = [
			'input:',
			'  kafka:',
			'    addresses: [ "${BROKERS}" ]',
			'    topics: [ ${TOPIC:events} ]',
			'pipeline:',
			'  processors:',
			'    - mapping: |',
			'        root.region = "${REGION}"',
			'        root.zone = env("ZONE")',
			'        root.port = "${PORT:8080}"',
		].join('\n');
		assert.deepStrictEqual(envUsage(text), [
			{ name: 'BROKERS', required: true },
			{ name: 'TOPIC', required: false },
			{ name: 'REGION', required: true },
			{ name: 'ZONE', required: true },
			{ name: 'PORT', required: false },
		]);
	});

	test('a name used both with and without a default is required; each name once', () => {
		assert.deepStrictEqual(envUsage('a: ${X:1}\nb: ${X}\nc: ${X}'), [{ name: 'X', required: true }]);
	});

	test('an empty default is a default; the default\'s own ${…} is not a use', () => {
		assert.deepStrictEqual(envUsage('a: ${B:}\nc: ${C:x${A}y}'), [{ name: 'B', required: false }, { name: 'C', required: false }]);
	});

	test('comments and $${NAME} count, as the binary replaces the raw text', () => {
		assert.deepStrictEqual(envUsage('# ${ZZ}\na: $${A}'), [{ name: 'ZZ', required: true }, { name: 'A', required: true }]);
	});

	test('env() with single quotes, spaces or escaped quotes; a computed name or a method is not read', () => {
		assert.deepStrictEqual(envUsage([
			`m: root = env('S1')`,
			'm: "root = env(\\"S2\\")"',
			'm: root = env( "S3" )',
			'm: root = env("S" + "4")',
			'm: root = getenv("S5")',
			'm: root = env(this.name)',
		].join('\n')), [{ name: 'S1', required: true }, { name: 'S2', required: true }, { name: 'S3', required: true }]);
	});

	test('Bloblang interpolations and names no variable can have are left out', () => {
		assert.deepStrictEqual(envUsage('a: ${! this.x }\nb: ${a.b}\nc: ${1A}\nd: ${OK_1}'), [{ name: 'OK_1', required: true }]);
	});

	test('the order is the first use', () => {
		assert.deepStrictEqual(envUsage('m: env("B")\na: ${A}\nb: ${B}').map((u) => u.name), ['B', 'A']);
	});
	// Ticket 34: the use under the cursor, for the variable hover.
	suite('envReferenceAt', () => {
		const at = (text: string, marker: string, delta = 0) => envReferenceAt(text, text.indexOf(marker) + delta);

		test('${NAME}: the name and the whole use, at its first and last character', () => {
			const text = 'a: "${TOPIC}" # x';
			const start = text.indexOf('${');
			const expected = { name: 'TOPIC', form: 'reference', start, end: start + '${TOPIC}'.length };
			assert.deepStrictEqual(envReferenceAt(text, start), expected);
			assert.deepStrictEqual(envReferenceAt(text, start + 3), expected);
			assert.deepStrictEqual(envReferenceAt(text, expected.end - 1), expected);
			assert.strictEqual(envReferenceAt(text, start - 1), undefined, 'just before');
			assert.strictEqual(envReferenceAt(text, expected.end), undefined, 'just after (the end is exclusive)');
		});

		test('${NAME:default}: the default, also an empty one or one holding ${…}', () => {
			assert.deepStrictEqual(at('p: ${PORT:8080}', 'PORT'), { name: 'PORT', default: '8080', form: 'reference', start: 3, end: 15 });
			assert.strictEqual(at('p: ${B:}', 'B')?.default, '');
			assert.deepStrictEqual(at('c: ${C:x${A}y}', 'A'), { name: 'C', default: 'x${A}y', form: 'reference', start: 3, end: 14 },
				'the default\'s own ${…} is not a use');
		});

		test('env("NAME"), env(\'NAME\'), spaces and escaped quotes', () => {
			const text = 'm: root = env("ZONE")';
			assert.deepStrictEqual(at(text, 'env'), { name: 'ZONE', form: 'call', start: 10, end: 21 });
			assert.deepStrictEqual(at(text, 'ZONE'), { name: 'ZONE', form: 'call', start: 10, end: 21 });
			assert.strictEqual(envReferenceAt(text, 21), undefined);
			assert.strictEqual(envReferenceAt(text, 9), undefined);
			assert.strictEqual(at(`m: env('S1')`, 'S1')?.name, 'S1');
			assert.strictEqual(at('m: env( "S3" )', 'S3')?.name, 'S3');
			assert.strictEqual(at('m: "root = env(\\"S2\\")"', 'S2')?.name, 'S2');
		});

		test('not a use: ${!…}, a name no variable can have, a computed name, a method, plain text', () => {
			assert.strictEqual(at('a: ${! this.x }', 'this'), undefined);
			assert.strictEqual(at('b: ${a.b}', 'a.b'), undefined);
			assert.strictEqual(at('c: ${1A}', '1A'), undefined);
			assert.strictEqual(at('m: env(this.name)', 'this'), undefined);
			assert.strictEqual(at('m: env("S" + "4")', 'S'), undefined);
			assert.strictEqual(at('m: getenv("S5")', 'S5'), undefined);
			assert.strictEqual(at('input: ${A}', 'input'), undefined);
		});

		test('several uses on a line: the one under the cursor', () => {
			const text = 'a: ${A}${B} env("C")';
			assert.strictEqual(at(text, 'A')?.name, 'A');
			assert.strictEqual(at(text, '${B}')?.name, 'B');
			assert.strictEqual(at(text, 'C')?.name, 'C');
		});
	});
});
