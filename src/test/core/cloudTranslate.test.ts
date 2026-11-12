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

	test('DEFAULT: a default is kept, an empty one too; a ${!…} in a default is not rewritten', () => {
		const t = ok(translateForCloud('a: ${TOPIC:orders}\nb: ${OPT:}\nc: ${HOST:${!meta("h")}}\n'));
		assert.strictEqual(t.text, 'a: ${secrets.TOPIC:orders}\nb: ${secrets.OPT:}\nc: ${secrets.HOST:${!meta("h")}}\n');
		assert.deepStrictEqual(t.secrets, [{ name: 'TOPIC', required: false }, { name: 'OPT', required: false }, { name: 'HOST', required: false }]);
	});

	test('NESTED 48: a reference in a default is refused with its line (a default is literal text), in a written ${secrets.…} too', () => {
		assert.deepStrictEqual(refused(translateForCloud('a: 1\nc: ${HOST:${BACKUP}}\nd: ${secrets.A:x${B}y}\ne: ${OK}\n')), [
			{ line: 2, message: 'line 2: ${HOST:${BACKUP}} has a reference in its default, which is never expanded (a default is literal text); use a default without ${…}' },
			{ line: 3, message: 'line 3: ${secrets.A:x${B}y} has a reference in its default, which is never expanded (a default is literal text); use a default without ${…}' },
		]);
	});

	test('NESTED 48: deeper nesting is refused too; a bad name is said with it; a dotted name is sent as written', () => {
		assert.deepStrictEqual(refused(translateForCloud('a: 1\nb: ${A:${B:${C}}}\nc: ${my_x:${B}}\n')), [
			{ line: 2, message: 'line 2: ${A:${B:${C}} has a reference in its default, which is never expanded (a default is literal text); use a default without ${…}' },
			{ line: 3, message: 'line 3: ${my_x:${B}} has a reference in its default, which is never expanded (a default is literal text); use a default without ${…}' },
			{ line: 3, message: 'my_x (line 3): a Redpanda Cloud secret name must match ^[A-Z][A-Z0-9_]*$' },
		]);
		assert.deepStrictEqual(translateForCloud('d: ${a.b:${C}}\n'), { kind: 'ok', text: 'd: ${a.b:${C}}\n', secrets: [] });
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
		assert.deepStrictEqual(t.secrets, [{ name: 'X', required: true }], 'the written ${secrets.X} and $${X}: X, once');
		const plain = 'input:\r\n  generate:\r\n    mapping: root = "$ {X}" # ünïcode\r\n';
		assert.deepStrictEqual(translateForCloud(plain), { kind: 'ok', text: plain, secrets: [] });
	});

	test('SECRETS_REF 48: a written ${secrets.NAME} is a secret use, sent as written; a default makes it optional', () => {
		assert.deepStrictEqual(translateForCloud('t: ${secrets.TOKEN}\nu: ${secrets.USER:admin}\n'),
			{ kind: 'ok', text: 't: ${secrets.TOKEN}\nu: ${secrets.USER:admin}\n', secrets: [{ name: 'TOKEN', required: true }, { name: 'USER', required: false }] });
	});

	test('SAME_SECRET 48: ${TOKEN} and ${secrets.TOKEN} are one secret, required when either use has no default', () => {
		const t = ok(translateForCloud('a: ${TOKEN:x}\nb: ${secrets.TOKEN}\nc: ${secrets.B:y}\nd: ${B:z}\n'));
		assert.strictEqual(t.text, 'a: ${secrets.TOKEN:x}\nb: ${secrets.TOKEN}\nc: ${secrets.B:y}\nd: ${secrets.B:z}\n');
		assert.deepStrictEqual(t.secrets, [{ name: 'TOKEN', required: true }, { name: 'B', required: false }]);
	});

	test('SECRETS_BAD 48: a written ${secrets.NAME} whose NAME is no secret id is refused with its line', () => {
		assert.deepStrictEqual(refused(translateForCloud('a: ${secrets.my_x}\nb: ${secrets.A.B:d}\nc: ${secrets.}\nd: ${secrets.OK}\n')), [
			{ line: 1, message: 'secrets.my_x (line 1): my_x, the secret name, must match ^[A-Z][A-Z0-9_]*$' },
			{ line: 2, message: 'secrets.A.B (line 2): A.B, the secret name, must match ^[A-Z][A-Z0-9_]*$' },
			{ line: 3, message: 'secrets. (line 3): the secret name after secrets. is empty; it must match ^[A-Z][A-Z0-9_]*$' },
		]);
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
		assert.deepStrictEqual(refused(translateForCloud('a: env("my_key")\nb: env("X", no_cache: true)\n')).map((p) => p.message), [
			'line 1: env("my_key") reads an environment variable, which Redpanda Cloud pipelines do not have; use "${MY_KEY}" (a Redpanda Cloud secret name must match ^[A-Z][A-Z0-9_]*$)',
			'line 2: env("X") reads an environment variable, which Redpanda Cloud pipelines do not have; use "${X}"',
		]);
		assert.deepStrictEqual(translateForCloud('root.a = this.env("x")\n'), { kind: 'ok', text: 'root.a = this.env("x")\n', secrets: [] });
	});

	test('ENV_COMMENT 48: env( in a # comment (YAML\'s or a mapping\'s) is not refused; a # in a string or inside a word is no comment', () => {
		const comments = ['# c: env("Y")', 'input:', '  generate: # env(this.x)', '    mapping: |', '      root.a = 1 # was env("A")', '      # root.b = env("B")', ''].join('\n');
		assert.deepStrictEqual(translateForCloud(comments), { kind: 'ok', text: comments, secrets: [] });
		const code = ['    mapping: |', '      root.a = "x # y" + env("A")', '    check: "root = \\"#\\" + env(\\"C\\")"', 'url: a#env("B")', ''].join('\n');
		assert.deepStrictEqual(refused(translateForCloud(code)).map((p) => p.line), [2, 3, 4]);
	});

	test('ENV_COMMENT 48: a # in a string a line carries on is no comment, so the env( after it is refused', () => {
		const lines = (...l: string[]) => [...l, ''].join('\n');
		// A # in a single-quoted scalar (flow and block context), then a real env(.
		assert.deepStrictEqual(refused(translateForCloud(lines('a: { b: \'x # y\', c: env("A") }', 'check: \'root = "#" + env("B")\''))).map((p) => p.line), [1, 2]);
		// A multi-line double-quoted scalar: its continuation line starts with # inside the Bloblang string.
		assert.deepStrictEqual(refused(translateForCloud(lines('check: "root = \\"a', '  # b\\" + env(\\"C\\")"'))).map((p) => p.line), [2]);
		// A Bloblang """…""" string over lines.
		assert.deepStrictEqual(refused(translateForCloud(lines('mapping: |', '  root.a = """x', '  # y""" + env("D")'))).map((p) => p.line), [3]);
		// A YAML comment and a Bloblang comment are comments; a text with YAML errors refuses as before.
		assert.strictEqual(translateForCloud(lines('a: 1 # env("E")', 'mapping: |', '  root = 1 # env("F")', '  # env("G")')).kind, 'ok');
		assert.deepStrictEqual(refused(translateForCloud(lines('a: [1', '# env("H")'))).map((p) => p.line), [2]);
	});

	test('both kinds together, by position', () => {
		assert.deepStrictEqual(refused(translateForCloud('a: env("A")\nb: ${b}\n')).map((p) => p.line), [1, 2]);
	});

	test('idempotent: translating the output changes nothing', () => {
		const once = ok(translateForCloud('a: ${A}\nb: ${B:x}\nc: ${secrets.C}\nd: ${!x}\n'));
		const twice = ok(translateForCloud(once.text));
		assert.strictEqual(twice.text, once.text);
		// Bug 48: a written ${secrets.…} is a secret use too, so the second pass lists the same secrets.
		assert.deepStrictEqual(twice.secrets, once.secrets);
		assert.deepStrictEqual(once.secrets.map((s) => s.name), ['A', 'B', 'C']);
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
