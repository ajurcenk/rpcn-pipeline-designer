import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { translateForCloud, type CloudTranslation } from '../../core/cloudTranslate';
import { REFERENCE } from '../../core/envUsage';
import { REPO_ROOT } from '../helpers/fakeBinary';

const ok = (t: CloudTranslation) => {
	assert.strictEqual(t.kind, 'ok', t.kind === 'refused' ? t.problems.map((p) => p.message).join('\n') : '');
	return t as Extract<CloudTranslation, { kind: 'ok' }>;
};
const refused = (t: CloudTranslation) => {
	assert.strictEqual(t.kind, 'refused');
	return (t as Extract<CloudTranslation, { kind: 'refused' }>).problems;
};

// Ticket 5.6: the config text a Redpanda Cloud pipeline is sent.
suite('core/cloudTranslate', () => {
	test('PLAIN: ${BROKER} becomes ${secrets.BROKER}; the secret listed', () => {
		assert.deepStrictEqual(translateForCloud('url: ${BROKER}\n'), { kind: 'ok', text: 'url: ${secrets.BROKER}\n', secrets: [{ name: 'BROKER', required: true }] });
	});

	test('DEFAULT: a default is kept, an empty one too; a default\'s own ${…} is not rewritten', () => {
		const t = ok(translateForCloud('a: ${TOPIC:orders}\nb: ${OPT:}\nc: ${HOST:${HOST}}\n'));
		assert.strictEqual(t.text, 'a: ${secrets.TOPIC:orders}\nb: ${secrets.OPT:}\nc: ${secrets.HOST:${HOST}}\n');
		assert.deepStrictEqual(t.secrets, [{ name: 'TOPIC', required: false }, { name: 'OPT', required: false }, { name: 'HOST', required: false }]);
	});

	test('MANY: every use rewritten, comments included; each name once, by first use', () => {
		const t = ok(translateForCloud('# uses ${B} and ${A}\na: ${A}\nb: "${B}-${A:x}"\n'));
		assert.strictEqual(t.text, '# uses ${secrets.B} and ${secrets.A}\na: ${secrets.A}\nb: "${secrets.B}-${secrets.A:x}"\n');
		assert.deepStrictEqual(t.secrets, [{ name: 'B', required: true }, { name: 'A', required: true }]);
		// required: some use has no default, whichever comes first.
		assert.deepStrictEqual(ok(translateForCloud('a: ${A:x}\nb: ${A}\nc: ${C:y}\n')).secrets, [{ name: 'A', required: true }, { name: 'C', required: false }]);
	});

	test('UNTOUCHED: ${!…} and dotted names as written; $${X} is a reference (no escape); no reference: byte for byte', () => {
		const t = ok(translateForCloud('k: ${!meta("k")}\ns: ${secrets.X}\nd: ${a.b}\ne: $${X}\n'));
		assert.strictEqual(t.text, 'k: ${!meta("k")}\ns: ${secrets.X}\nd: ${a.b}\ne: $${secrets.X}\n');
		assert.deepStrictEqual(t.secrets, [{ name: 'X', required: true }]);
		const plain = 'input:\r\n  generate:\r\n    mapping: root = "$ {X}" # ünïcode\r\n';
		assert.deepStrictEqual(translateForCloud(plain), { kind: 'ok', text: plain, secrets: [] });
	});

	test('BAD_NAME: lowercase, a leading _ or digit is refused with its line, each use', () => {
		const problems = refused(translateForCloud('input:\n  a: 1\n  b: 2\n  token: ${my_token}\nx: ${_X} ${1X:d}\ny: ${OK}\n'));
		assert.deepStrictEqual(problems, [
			{ line: 4, message: 'my_token (line 4): a Redpanda Cloud secret name must match ^[A-Z][A-Z0-9_]*$' },
			{ line: 5, message: '_X (line 5): a Redpanda Cloud secret name must match ^[A-Z][A-Z0-9_]*$' },
			{ line: 5, message: '1X (line 5): a Redpanda Cloud secret name must match ^[A-Z][A-Z0-9_]*$' },
		]);
	});

	test('ENV_CALL: a literal env("KEY") (any quotes) and a computed env(…) are refused with their lines', () => {
		const text = ['pipeline:', '  processors:', '    - mapping: |', '        root.a = 1', '        root.b = 2', '        root.c = 3',
			'        root.k = env("KEY")', "        root.l = env( 'L' )", '        root.m = env(this.name)', '        root.n = getenv("N") + my_env("M")',
			'    - mapping: "root.o = env(\\"O\\")"', ''].join('\n');
		assert.deepStrictEqual(refused(translateForCloud(text)).map((p) => p.message), [
			'line 7: env("KEY") reads an environment variable, which Redpanda Cloud pipelines do not have; use "${KEY}"',
			'line 8: env("L") reads an environment variable, which Redpanda Cloud pipelines do not have; use "${L}"',
			'line 9: env(…) reads an environment variable, which Redpanda Cloud pipelines do not have; use "${NAME}" with the variable\'s name',
			'line 11: env("O") reads an environment variable, which Redpanda Cloud pipelines do not have; use "${O}"',
		]);
	});

	test('ENV_CALL: a name that is no secret id gets the rule in its hint; more arguments after a literal name; a method this.env( is no call', () => {
		assert.deepStrictEqual(refused(translateForCloud('a: env("my_key")\nb: env("X", no_cache: true)\n# c: env("Y")\n')).map((p) => p.message), [
			'line 1: env("my_key") reads an environment variable, which Redpanda Cloud pipelines do not have; use "${MY_KEY}" (a Redpanda Cloud secret name must match ^[A-Z][A-Z0-9_]*$)',
			'line 2: env("X") reads an environment variable, which Redpanda Cloud pipelines do not have; use "${X}"',
			'line 3: env("Y") reads an environment variable, which Redpanda Cloud pipelines do not have; use "${Y}"',
		]);
		assert.deepStrictEqual(translateForCloud('root.a = this.env("x")\n'), { kind: 'ok', text: 'root.a = this.env("x")\n', secrets: [] });
	});

	test('both kinds together, by position', () => {
		assert.deepStrictEqual(refused(translateForCloud('a: env("A")\nb: ${b}\n')).map((p) => p.line), [1, 2]);
	});

	test('idempotent: translating the output changes nothing', () => {
		const once = ok(translateForCloud('a: ${A}\nb: ${B:x}\nc: ${secrets.C}\nd: ${!x}\n'));
		const twice = ok(translateForCloud(once.text));
		assert.strictEqual(twice.text, once.text);
		assert.deepStrictEqual(twice.secrets, []);
	});

	suite('the corpus', () => {
		const dir = path.join(REPO_ROOT, 'test', 'corpus');
		const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
		test('there are corpus configs', () => assert.ok(files.length > 0));
		for (const file of files) {
			test(file, () => {
				const text = fs.readFileSync(path.join(dir, file), 'utf8');
				const t = translateForCloud(text);
				if (t.kind === 'refused') {
					assert.ok(t.problems.length > 0);
					return;
				}
				// No ${NAME} with a valid name is left.
				for (const m of t.text.matchAll(REFERENCE)) {
					assert.ok(m[1].includes('.'), `${file}: \${${m[1]}} left`);
				}
				// Idempotent.
				assert.strictEqual(ok(translateForCloud(t.text)).text, t.text);
				// Outside the reference spans the text is unchanged.
				let expected = '';
				let at = 0;
				for (const m of text.matchAll(REFERENCE)) {
					const start = m.index ?? 0;
					expected += text.slice(at, start) + (m[1].includes('.') ? m[0] : `\${secrets.${m[0].slice(2)}`);
					at = start + m[0].length;
				}
				assert.strictEqual(t.text, expected + text.slice(at));
				assert.strictEqual(t.text.split('${!').length, text.split('${!').length, `${file}: \${!…} kept`);
			});
		}
	});
});
