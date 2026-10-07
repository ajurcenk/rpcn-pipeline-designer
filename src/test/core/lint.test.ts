import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { LintFinding, parseLintOutput, suppressFlaggedLines } from '../../core/lint';
import { REPO_ROOT } from '../helpers/fakeBinary';

const CAPTURES = path.join(REPO_ROOT, '_bmad-output', 'initiative-rpcn-vscode-designer', 'epic-foundation',
	'spike-1-1-findings', 'captures');
const FLAVORS = ['standalone-4.100.0', 'standalone-4.112.0', 'rpk-4.112.0'];

const capture = (flavor: string, scenario: string) => fs.readFileSync(path.join(CAPTURES, flavor, `${scenario}.stderr`), 'utf8');
const brief = (f: LintFinding) => [f.path, f.line, f.severity, f.message];

suite('core/lint parseLintOutput (spike captures, all three flavors)', () => {
	const expected: Record<string, unknown[][]> = {
		'lint-invalid-field': [
			['invalid_field.yaml', 6, 'error', 'field nope not recognised'],
			['invalid_field.yaml', 9, 'error', 'field codex not recognised'],
		],
		'lint-nested-invalid-field': [
			['nested_invalid_field.yaml', 8, 'error', 'field bogus is invalid when the component type is mapping (processor)'],
		],
		'lint-missing-required': [['missing_required.yaml', 4, 'error', 'field mapping is required']],
		'deprecated-flag': [['deprecated.yaml', 5, 'warning', 'field codec is deprecated']],
		'lint-yaml-syntax': [['yaml_syntax_error.yaml', 6, 'error', 'yaml: line 6: did not find expected node content']],
		'lint-missing-file': [['does_not_exist.yaml', 1, 'error', 'open does_not_exist.yaml: no such file or directory']],
		'env-plus-field-error': [
			['env_plus_field_error.yaml', 1, 'error', 'required environment variables were not set: [SPIKE_GREETING]'],
			['env_plus_field_error.yaml', 6, 'error', 'field nope not recognised'],
		],
		'lint-absolute-path': [
			['<ROOT>/test/corpus/fixtures/invalid_field.yaml', 6, 'error', 'field nope not recognised'],
			['<ROOT>/test/corpus/fixtures/invalid_field.yaml', 9, 'error', 'field codex not recognised'],
		],
		'lint-clean': [],
	};
	for (const flavor of FLAVORS) {
		for (const [scenario, findings] of Object.entries(expected)) {
			test(`${flavor} ${scenario}`, () => {
				const parsed = parseLintOutput(capture(flavor, scenario));
				assert.deepStrictEqual(parsed.unparsed, []);
				assert.deepStrictEqual(parsed.findings.map(brief).sort(), [...findings].sort());
			});
		}
	}
});

suite('core/lint parseLintOutput edge cases', () => {
	test('CRLF, blank lines and trailing spaces', () => {
		const parsed = parseLintOutput('\r\n/a/b.yaml(3,1) field x not recognised  \r\n\r\n');
		assert.deepStrictEqual(parsed.findings.map(brief), [['/a/b.yaml', 3, 'error', 'field x not recognised']]);
		assert.deepStrictEqual(parsed.unparsed, []);
	});

	test('UNPARSED: other lines are returned, parsed lines kept', () => {
		const parsed = parseLintOutput('panic: boom\n/a.yaml(2,1) field x not recognised\nlevel=info msg=x\n');
		assert.deepStrictEqual(parsed.unparsed, ['panic: boom', 'level=info msg=x']);
		assert.strictEqual(parsed.findings.length, 1);
	});

	test('a path with parentheses and spaces; a message with (n,m)', () => {
		const parsed = parseLintOutput('/tmp/a (copy)/x.yaml(7,1) field y (3,4) odd\n');
		assert.deepStrictEqual(parsed.findings.map(brief), [['/tmp/a (copy)/x.yaml', 7, 'error', 'field y (3,4) odd']]);
	});

	test('line 0 is not a finding', () => {
		assert.deepStrictEqual(parseLintOutput('/a.yaml(0,1) x\n').unparsed, ['/a.yaml(0,1) x']);
	});

	test('the yaml: line N remap only applies at (1,1) and to N >= 1', () => {
		assert.strictEqual(parseLintOutput('/a.yaml(1,1) yaml: line 12: mapping values are not allowed\n').findings[0].line, 12);
		assert.strictEqual(parseLintOutput('/a.yaml(4,1) yaml: line 12: x\n').findings[0].line, 4);
		assert.strictEqual(parseLintOutput('/a.yaml(1,1) yaml: line 0: x\n').findings[0].line, 1);
	});

	test('only `field <name> is deprecated` is a warning', () => {
		const parsed = parseLintOutput('/a.yaml(2,1) field codec is deprecated\n/a.yaml(3,1) field codec is deprecated, use scanner\n');
		assert.deepStrictEqual(parsed.findings.map((f) => f.severity), ['warning', 'error']);
	});
});

suite('core/lint suppressFlaggedLines', () => {
	test('DEDUPE: findings on flagged lines are dropped, order kept', () => {
		const findings = parseLintOutput('/a.yaml(9,1) b\n/a.yaml(4,1) a\n/a.yaml(5,1) c\n').findings;
		assert.deepStrictEqual(suppressFlaggedLines(findings, new Set([4])).map((f) => f.line), [9, 5]);
		assert.deepStrictEqual(suppressFlaggedLines(findings, new Set()).length, 3);
	});

	test('a known path containing (n,m)  is split at the path, not inside it', () => {
		const file = '/tmp/p(1,1) x.yaml';
		const stderr = `${file}(4,1) field nope not recognised\n`;
		assert.deepStrictEqual(parseLintOutput(stderr, [file]).findings.map(brief), [[file, 4, 'error', 'field nope not recognised']]);
		assert.strictEqual(parseLintOutput(stderr).findings[0].path, '/tmp/p', 'without the hint the lazy match splits early');
	});

	test('a Bloblang finding with a real column is still a whole-line finding', () => {
		assert.deepStrictEqual(parseLintOutput('/a.yaml(3,29) required: expected query, but reached end of input\n').findings.map(brief),
			[['/a.yaml', 3, 'error', 'required: expected query, but reached end of input']]);
	});

	test('syntax findings are marked, and hidden only while Red Hat reports a syntax error', () => {
		const parsed = parseLintOutput('/a.yaml(1,1) yaml: line 1: did not find expected key\n/a.yaml(6,1) field nope not recognised\n');
		assert.deepStrictEqual(parsed.findings.map((f) => f.syntax), [true, false]);
		assert.deepStrictEqual(suppressFlaggedLines(parsed.findings, new Set([4]), true).map((f) => f.line), [6]);
		assert.deepStrictEqual(suppressFlaggedLines(parsed.findings, new Set(), false).map((f) => f.line), [1, 6]);
	});
});
