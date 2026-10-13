import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseBloblParseOutput } from '../../core/bloblangParse';
import { REPO_ROOT } from '../helpers/fakeBinary';

const CAPTURES = path.join(REPO_ROOT, '_bmad-output', 'initiative-rpcn-vscode-designer', 'epic-bloblang-check-and-test',
	'spike-4-1-findings', 'captures', 'standalone-4.112.0', 'B');

function capture(scenario: string): { exit: number; stderr: string } {
	const read = (ext: string) => fs.readFileSync(path.join(CAPTURES, `${scenario}.${ext}`), 'utf8');
	return { exit: Number(read('exit').trim()), stderr: read('stderr') };
}

suite('core/bloblangParse (4.5, AD-21)', () => {
	test('the spike\'s captured parse error: message without the prefix, line, char, the caret excerpt', () => {
		const { exit, stderr } = capture('parse-error.parse-only');
		assert.strictEqual(exit, 1);
		assert.deepStrictEqual(parseBloblParseOutput(exit, stderr), {
			kind: 'parseError',
			message: 'required: expected comma or closing bracket',
			line: 3,
			char: 8,
			excerpt: '  |\n3 | root.c = 3\n  |        ^---',
		});
	});

	test('the spike\'s parse-only ok and map-error runs parse (exit 0)', () => {
		for (const scenario of ['ok.parse-only', 'map-error.parse-only']) {
			const { exit, stderr } = capture(scenario);
			assert.deepStrictEqual(parseBloblParseOutput(exit, stderr), { kind: 'ok' }, scenario);
		}
	});

	test('a parse error at a line end (4.100.0, by hand): `line 2 char 1: expected query`', () => {
		assert.deepStrictEqual(parseBloblParseOutput(1, 'failed to parse mapping: line 2 char 1: expected query\n  |\n2 | \n  | ^---\n'), {
			kind: 'parseError', message: 'expected query', line: 2, char: 1, excerpt: '  |\n2 | \n  | ^---',
		});
	});

	test('CRLF output and no excerpt', () => {
		assert.deepStrictEqual(parseBloblParseOutput(1, 'failed to parse mapping: line 1 char 4: oops\r\n'), {
			kind: 'parseError', message: 'oops', line: 1, char: 4, excerpt: '',
		});
	});

	test('ENV_VAR: an unset ${VAR} is not a parse error', () => {
		const stderr = 'failed to replace env vars: required environment variables were not set: [SPIKE_X]\n';
		assert.deepStrictEqual(parseBloblParseOutput(1, stderr),
			{ kind: 'other', message: 'failed to replace env vars: required environment variables were not set: [SPIKE_X]' });
	});

	test('other failures: the stderr, or the exit code or signal when there is none', () => {
		assert.deepStrictEqual(parseBloblParseOutput(2, 'unexpected args\nmore\n'), { kind: 'other', message: 'unexpected args\nmore' });
		assert.deepStrictEqual(parseBloblParseOutput(3, ''), { kind: 'other', message: 'blobl exited with code 3.' });
		assert.deepStrictEqual(parseBloblParseOutput(null, ''), { kind: 'other', message: 'blobl was stopped by a signal.' });
		// The parse-error text not on the first line is not a parse error.
		assert.strictEqual(parseBloblParseOutput(1, 'panic\nfailed to parse mapping: line 1 char 1: x').kind, 'other');
	});
});
