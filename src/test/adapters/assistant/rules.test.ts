import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { approvalSummary, canUseToolDecision, isInside, isRpcnCheckCall, preToolUseDecision } from '../../../adapters/assistant/rules';

// Story 8.1 (AD-26): the assistant's boundaries, ported from spike 65: the one shell rule, reads inside
// the bundled skills, writes outside the workspace denied, the note written without asking, the rest asks.
suite('assistant rules (story 8.1)', () => {
	let root: string;
	let ws: string;
	let skills: string;
	let script: string;
	const ctx = () => ({ workspace: ws, skillsDir: skills });

	suiteSetup(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rpcn-assistant-rules-')));
		ws = path.join(root, 'ws');
		skills = path.join(root, 'skills-copy');
		script = path.join(skills, 'skills', 'rpcn-design', 'scripts', 'rpcn_check.py');
		fs.mkdirSync(path.dirname(script), { recursive: true });
		fs.writeFileSync(script, 'print("ok")\n');
		fs.mkdirSync(path.join(ws, 'evil'), { recursive: true });
		fs.writeFileSync(path.join(ws, 'evil', 'rpcn_check.py'), 'print("not the skills")\n');
		fs.symlinkSync(root, path.join(ws, 'out-link'));
	});
	suiteTeardown(() => fs.rmSync(root, { recursive: true, force: true }));

	test('the skills\' own rpcn_check call is allowed; chained, substituted, redirected or another script is not', () => {
		assert.ok(isRpcnCheckCall(`uv run ${script} binary`, ws, skills));
		assert.ok(isRpcnCheckCall(`uv run ${script} fields inputs kafka_franz`, ws, skills));
		assert.ok(isRpcnCheckCall(`  uv run ${script} handoff-check orders.design.md  `, ws, skills));
		for (const bad of [
			`uv run ${script} binary; echo chained`,
			`uv run ${script} binary && rm -rf x`,
			`uv run ${script} binary | tee x`,
			`uv run ${script} binary > /tmp/x`,
			`uv run ${script} $(whoami)`,
			`uv run ${script} \`id\``,
			`uv run ${script} lint ~/x.yaml`,
			`uv run ${script}`,
			`uv run ${path.join(ws, 'evil', 'rpcn_check.py')} binary`,
			`uv run ${path.join(skills, 'skills', 'rpcn-design', 'scripts', 'other.py')} binary`,
			`python3 ${script} binary`,
			`uv run ${path.join(skills, 'skills', 'rpcn-design', 'scripts', 'missing', 'rpcn_check.py')} binary`,
		]) {
			assert.ok(!isRpcnCheckCall(bad, ws, skills), bad);
		}
		assert.ok(!isRpcnCheckCall(undefined, ws, skills));
	});

	test('review 1: a path argument must resolve inside the workspace or the skills copy, else the call asks', () => {
		assert.ok(isRpcnCheckCall(`uv run ${script} lint ${path.join(ws, 'orders.yaml')}`, ws, skills), 'inside the workspace');
		assert.ok(isRpcnCheckCall(`uv run ${script} lint orders.yaml`, ws, skills), 'a bare name');
		assert.ok(isRpcnCheckCall(`uv run ${script} lint sub/orders.yaml`, ws, skills), 'relative, inside');
		assert.ok(isRpcnCheckCall(`uv run ${script} test --samples=${path.join(skills, 'skills', 'x.json')}`, ws, skills), 'an option\'s value inside the skills');
		assert.ok(isRpcnCheckCall(`uv run ${script} fields inputs kafka_franz`, ws, skills), 'plain words');
		for (const bad of [
			`uv run ${script} lint /etc/passwd`,
			`uv run ${script} lint ${path.join(root, 'secret.yaml')}`,
			`uv run ${script} lint ../secret.yaml`,
			`uv run ${script} lint sub/../../secret.yaml`,
			`uv run ${script} lint ..`,
			`uv run ${script} lint --file=/etc/passwd`,
			`uv run ${script} lint ${path.join(ws, 'out-link', 'x.yaml')}`,
		]) {
			assert.ok(!isRpcnCheckCall(bad, ws, skills), bad);
		}
	});

	test('review 18: the script path must be absolute', () => {
		const rel = path.relative(ws, script);
		assert.ok(!isRpcnCheckCall(`uv run ${rel} binary`, ws, skills), rel);
	});

	test('isInside follows symlinks: a link out of the workspace is not inside', () => {
		assert.ok(isInside(ws, path.join(ws, 'a.design.md')));
		assert.ok(isInside(ws, 'sub/new/a.yaml'));
		assert.ok(isInside(ws, ws));
		assert.ok(!isInside(ws, path.join(root, 'outside.txt')));
		assert.ok(!isInside(ws, path.join(ws, '..', 'outside.txt')));
		assert.ok(!isInside(ws, path.join(ws, 'out-link', 'outside.txt')));
		assert.ok(!isInside(ws, `${ws}-sibling/x`));
	});

	test('the PreToolUse hook: rpcn_check allowed, reads in the skills allowed, writes outside denied, the rest undecided', () => {
		assert.strictEqual(preToolUseDecision('Bash', { command: `uv run ${script} binary` }, ctx())?.decision, 'allow');
		assert.strictEqual(preToolUseDecision('Bash', { command: `uv run ${script} binary; echo x` }, ctx()), undefined);
		assert.strictEqual(preToolUseDecision('Read', { file_path: path.join(skills, 'skills', 'rpcn-design', 'SKILL.md') }, ctx())?.decision, 'allow');
		assert.strictEqual(preToolUseDecision('Glob', { path: skills, pattern: '*.md' }, ctx())?.decision, 'allow');
		assert.strictEqual(preToolUseDecision('Read', { file_path: path.join(root, 'secret.txt') }, ctx()), undefined);
		assert.strictEqual(preToolUseDecision('Write', { file_path: path.join(root, 'outside.txt'), content: 'x' }, ctx())?.decision, 'deny');
		assert.strictEqual(preToolUseDecision('Edit', { file_path: path.join(ws, 'out-link', 'x.yaml') }, ctx())?.decision, 'deny');
		assert.strictEqual(preToolUseDecision('Write', { content: 'no path' }, ctx())?.decision, 'deny');
		assert.strictEqual(preToolUseDecision('Write', { file_path: path.join(ws, 'a.design.md'), content: 'x' }, ctx()), undefined);
		assert.strictEqual(preToolUseDecision('mcp__rpcn__rpcn_lint', {}, ctx())?.decision, 'allow');
		assert.strictEqual(preToolUseDecision('WebFetch', { url: 'https://example.com' }, ctx()), undefined);
	});

	test('canUseTool: a question, the note written without asking, other writes and commands ask, writes outside denied', () => {
		assert.deepStrictEqual(canUseToolDecision('AskUserQuestion', { questions: [] }, ctx()), { kind: 'question' });
		assert.deepStrictEqual(canUseToolDecision('Write', { file_path: path.join(ws, 'orders.design.md'), content: 'x' }, ctx()), { kind: 'allow' });
		assert.deepStrictEqual(canUseToolDecision('Write', { file_path: 'orders.design.md', content: 'x' }, ctx()), { kind: 'allow' });
		assert.deepStrictEqual(canUseToolDecision('Write', { file_path: path.join(ws, 'orders.yaml'), content: 'x' }, ctx()), { kind: 'ask' });
		assert.deepStrictEqual(canUseToolDecision('Edit', { file_path: path.join(ws, 'orders.design.md') }, ctx()), { kind: 'ask' });
		assert.strictEqual(canUseToolDecision('Write', { file_path: path.join(root, 'x.design.md') }, ctx()).kind, 'deny');
		assert.deepStrictEqual(canUseToolDecision('Bash', { command: `uv run ${script} binary` }, ctx()), { kind: 'allow' });
		assert.deepStrictEqual(canUseToolDecision('Bash', { command: 'rm -rf /' }, ctx()), { kind: 'ask' });
		assert.deepStrictEqual(canUseToolDecision('Read', { file_path: path.join(skills, 'skills', 'x.md') }, ctx()), { kind: 'allow' });
		assert.deepStrictEqual(canUseToolDecision('WebFetch', {}, ctx()), { kind: 'ask' });
	});

	test('approvalSummary names the command or the file', () => {
		assert.strictEqual(approvalSummary('Bash', { command: 'ls -la' }), 'run `ls -la`');
		assert.strictEqual(approvalSummary('Write', { file_path: '/w/a.yaml' }), 'write /w/a.yaml');
		assert.strictEqual(approvalSummary('WebFetch', {}), 'use WebFetch');
		assert.strictEqual(approvalSummary('Bash', { command: 'x'.repeat(300) }).length, 'run ``'.length + 200);
	});
});
