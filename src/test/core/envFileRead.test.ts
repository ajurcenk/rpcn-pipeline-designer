import * as assert from 'assert';
import { readEnvFile } from '../../core/envFileRead';

const vars = (content: string) => readEnvFile(content).variables.map((v) => [v.name, v.value]);

// Ticket 31: an env file read as the binary reads it (probed 2026-10-28 on 4.100.0 and 4.112.0).
suite('core/envFileRead', () => {
	test('NAME=value lines, comments and blank lines; the line of each', () => {
		assert.deepStrictEqual(readEnvFile('# c\nA=1\n\n  # indented comment\n   \nB=two\n'), {
			variables: [{ name: 'A', value: '1', line: 2 }, { name: 'B', value: 'two', line: 6 }],
		});
	});

	test('CRLF endings, spaces around =, a trailing comment, an empty value', () => {
		assert.deepStrictEqual(vars('A=1\r\nB = 2\r\nC =3\nD= 4\nE=5   # c\nF=\nG=a#b\n'), [
			['A', '1'], ['B', '2'], ['C', '3'], ['D', '4'], ['E', '5'], ['F', ''], ['G', 'a'],
		]);
	});

	test('double-quoted values with the escapes ticket 29 writes; single quotes are kept', () => {
		assert.deepStrictEqual(vars('A="x\\ny"\nB="a\\"b"\nC="\\t\\r\\\\"\nD=\'s\'\nE="x" # c\nF="${B}"\nG=${B}\n'), [
			['A', 'x\ny'], ['B', 'a"b'], ['C', '\t\r\\'], ['D', "'s'"], ['E', 'x'], ['F', '${B}'], ['G', '${B}'],
		]);
	});

	test('the last value of a name set twice wins', () => {
		assert.deepStrictEqual(readEnvFile('A=1\nB=2\nA=3\n').variables, [{ name: 'B', value: '2', line: 2 }, { name: 'A', value: '3', line: 3 }]);
	});

	test('BAD_ENV_FILE: export, a colon, a bare name: the file is rejected at that line', () => {
		for (const [content, line] of [['export A=1\nB=2\n', 1], ['B=2\nA: 1\n', 2], ['garbage\n', 1], ['B=2\nA', 2]] as const) {
			const read = readEnvFile(content);
			assert.strictEqual(read.problem?.kind, 'rejected', content);
			assert.strictEqual(read.problem.line, line, content);
		}
	});

	test('BAD_ENV_FILE: a quote left open or an escape Go refuses rejects the file', () => {
		assert.deepStrictEqual(readEnvFile('B=2\nA="open\nC=3\n').problem, { kind: 'rejected', line: 2, reason: 'a quoted value without its closing quote' });
		assert.deepStrictEqual(readEnvFile('A="\\$x"\n').problem, { kind: 'rejected', line: 1, reason: 'an invalid escape in a quoted value' });
	});

	test('a line starting with a space: the binary stops there (that line and the rest apply nothing)', () => {
		assert.deepStrictEqual(readEnvFile('A=1\n B=2\nC=3\n'), { variables: [{ name: 'A', value: '1', line: 1 }], problem: { kind: 'stops', line: 2, keepsLine: false } });
		assert.deepStrictEqual(readEnvFile(' A=1\nB=2\n'), { variables: [], problem: { kind: 'stops', line: 1, keepsLine: false } });
	});

	test('more after the value: the binary keeps it and stops after that line', () => {
		assert.deepStrictEqual(readEnvFile('A=1 2\nB=2\n'), { variables: [{ name: 'A', value: '1', line: 1 }], problem: { kind: 'stops', line: 1, keepsLine: true } });
		assert.deepStrictEqual(vars('A="x" y\nB=2\n'), [['A', 'x']]);
	});

	test('a key no variable can have (a digit first, a dot, a tab) is left out and the rest is read', () => {
		assert.deepStrictEqual(readEnvFile('1A=1\nA.b=1\n\tC=1\nD\t=1\nB=2\n'), { variables: [{ name: 'B', value: '2', line: 5 }] });
	});

	test('an empty file', () => {
		assert.deepStrictEqual(readEnvFile(''), { variables: [] });
	});
});
