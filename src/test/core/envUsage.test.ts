import * as assert from 'assert';
import { envUsage } from '../../core/envUsage';

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
});
