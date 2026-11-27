import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { approvalDetail, approvalSummary, canUseToolDecision, decide, isInside, isRpcnCheckCall, preToolUseDecision, shellKey } from '../../../adapters/assistant/rules';

// Story 8.1 (AD-26): the assistant's boundaries, ported from spike 65: the one shell rule, reads inside
// the bundled skills, writes outside the workspace denied, the note written without asking, the rest asks.
suite('assistant rules (story 8.1)', () => {
	let root: string;
	let ws: string;
	let skills: string;
	let script: string;
	const ctx = () => ({ workspace: ws, skillsDir: skills, skill: 'rpcn-design', agentConfigDir: path.join(root, 'storage', 'assistant', 'claude-config') });

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
		// Story 8.5 (amended): programs that exist outside the workspace; `root` is the home folder of the key tests.
		for (const bin of [path.join(root, '.local', 'bin', 'rpk'), path.join(root, 'bin', 'grep'), path.join(root, 'bin', 'redpanda-connect')]) {
			fs.mkdirSync(path.dirname(bin), { recursive: true });
			fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
		}
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

	test('the PreToolUse hook: rpcn_check allowed, reads in the skills or the workspace allowed, writes outside denied, the note allowed, every other call asks', () => {
		assert.strictEqual(preToolUseDecision('Bash', { command: `uv run ${script} binary` }, ctx())?.decision, 'allow');
		// Story 8.5: a command that asks is `ask` (Claude Code would run a read-only one unasked).
		assert.strictEqual(preToolUseDecision('Bash', { command: `uv run ${script} binary; echo x` }, ctx())?.decision, 'ask');
		assert.strictEqual(preToolUseDecision('Bash', { command: 'echo x' }, ctx())?.decision, 'ask');
		assert.strictEqual(preToolUseDecision('Read', { file_path: path.join(skills, 'skills', 'rpcn-design', 'SKILL.md') }, ctx())?.decision, 'allow');
		assert.strictEqual(preToolUseDecision('Glob', { path: skills, pattern: '*.md' }, ctx())?.decision, 'allow');
		assert.strictEqual(preToolUseDecision('Read', { file_path: path.join(root, 'secret.txt') }, ctx())?.decision, 'ask');
		assert.strictEqual(preToolUseDecision('Write', { file_path: path.join(root, 'outside.txt'), content: 'x' }, ctx())?.decision, 'deny');
		assert.strictEqual(preToolUseDecision('Edit', { file_path: path.join(ws, 'out-link', 'x.yaml') }, ctx())?.decision, 'deny');
		assert.strictEqual(preToolUseDecision('Write', { content: 'no path' }, ctx())?.decision, 'deny');
		// Story 8.5: the stage's own note, as canUseTool says.
		assert.strictEqual(preToolUseDecision('Write', { file_path: path.join(ws, 'a.design.md'), content: 'x' }, ctx())?.decision, 'allow');
		assert.strictEqual(preToolUseDecision('Write', { file_path: path.join(ws, 'a.yaml'), content: 'x' }, ctx())?.decision, 'ask');
		assert.strictEqual(preToolUseDecision('mcp__rpcn__rpcn_lint', {}, ctx())?.decision, 'allow');
		assert.strictEqual(preToolUseDecision('WebFetch', { url: 'https://example.com' }, ctx())?.decision, 'ask');
		assert.strictEqual(preToolUseDecision('Task', { prompt: 'x' }, ctx())?.decision, 'ask');
		// A question is no hook decision: canUseTool turns it into cards.
		assert.strictEqual(preToolUseDecision('AskUserQuestion', { questions: [] }, ctx()), undefined);
	});

	test('canUseTool: a question, the note written or edited without asking, other writes and commands ask (with their key), writes outside denied', () => {
		const kind = (tool: string, input: Record<string, unknown>) => canUseToolDecision(tool, input, ctx()).kind;
		assert.deepStrictEqual(canUseToolDecision('AskUserQuestion', { questions: [] }, ctx()), { kind: 'question' });
		assert.strictEqual(kind('Write', { file_path: path.join(ws, 'orders.design.md'), content: 'x' }), 'allow');
		assert.strictEqual(kind('Write', { file_path: 'orders.design.md', content: 'x' }), 'allow');
		// Story 8.5 OWN_NOTE: Edit and MultiEdit of the note too; NotebookEdit is no note.
		assert.strictEqual(kind('Edit', { file_path: path.join(ws, 'orders.design.md') }), 'allow');
		assert.strictEqual(kind('MultiEdit', { file_path: path.join(ws, 'sub', 'orders.design.md') }), 'allow');
		assert.deepStrictEqual(canUseToolDecision('NotebookEdit', { notebook_path: path.join(ws, 'x.design.md') }, ctx()), { kind: 'ask', sessionKey: 'NotebookEdit' });
		assert.deepStrictEqual(canUseToolDecision('Write', { file_path: path.join(ws, 'orders.yaml'), content: 'x' }, ctx()), { kind: 'ask', sessionKey: 'Write' });
		assert.deepStrictEqual(canUseToolDecision('Edit', { file_path: path.join(ws, 'orders.yaml') }, ctx()), { kind: 'ask', sessionKey: 'Edit' });
		assert.strictEqual(kind('Write', { file_path: path.join(root, 'x.design.md') }), 'deny');
		assert.strictEqual(kind('Bash', { command: `uv run ${script} binary` }), 'allow');
		assert.deepStrictEqual(canUseToolDecision('Bash', { command: 'rm -rf /' }, ctx()), { kind: 'ask', sessionKey: null });
		assert.deepStrictEqual(canUseToolDecision('Bash', { command: 'rpk connect list | jq .' }, ctx()), { kind: 'ask', sessionKey: 'rpk connect list | jq' });
		assert.strictEqual(kind('Read', { file_path: path.join(skills, 'skills', 'x.md') }), 'allow');
		assert.deepStrictEqual(canUseToolDecision('Read', { file_path: path.join(root, 'secret.txt') }, ctx()), { kind: 'ask', sessionKey: null });
		for (const tool of ['WebFetch', 'WebSearch', 'Task', 'SomethingNew']) {
			assert.deepStrictEqual(canUseToolDecision(tool, {}, ctx()), { kind: 'ask', sessionKey: null }, tool);
		}
		assert.strictEqual(kind('mcp__rpcn__rpcn_lint', {}), 'allow');
		for (const tool of ['Skill', 'TodoWrite', 'ToolSearch']) {
			assert.strictEqual(kind(tool, {}), 'allow', tool);
		}
	});

	test('story 8.5 (amended): reads inside the workspace or the skills copy are allowed; outside they ask', () => {
		const kind = (tool: string, input: Record<string, unknown>) => canUseToolDecision(tool, input, ctx()).kind;
		assert.strictEqual(kind('Read', { file_path: path.join(ws, 'a.yaml') }), 'allow');
		assert.strictEqual(kind('Read', { file_path: 'sub/a.yaml' }), 'allow');
		assert.strictEqual(kind('Glob', { pattern: '**/*.yaml' }), 'allow');
		assert.strictEqual(kind('Grep', { pattern: 'kafka' }), 'allow');
		assert.strictEqual(kind('Grep', { pattern: 'kafka', path: path.join(skills, 'skills') }), 'allow');
		assert.strictEqual(kind('Read', { file_path: path.join(root, 'secret.txt') }), 'ask');
		assert.strictEqual(kind('Read', { file_path: path.join(ws, 'out-link', 'secret.txt') }), 'ask');
		assert.strictEqual(kind('Read', { file_path: '~/.ssh/id_rsa' }), 'ask');
		assert.strictEqual(kind('Glob', { pattern: '/etc/*' }), 'ask');
		assert.strictEqual(kind('Glob', { pattern: '../**/*.yaml' }), 'ask');
		assert.strictEqual(kind('Grep', { pattern: 'x', path: '/etc' }), 'ask');
		assert.strictEqual(kind('Read', {}), 'ask');
		// Manual check 1: tool results Claude Code spilled under the agent's own config folder are read back without a card.
		const config = ctx().agentConfigDir;
		const spilled = path.join(config, 'projects', 'x', 'y', 'tool-results', 'z.txt');
		assert.strictEqual(kind('Read', { file_path: spilled }), 'allow');
		assert.strictEqual(kind('Grep', { pattern: 'x', path: path.join(config, 'projects') }), 'allow');
		assert.strictEqual(kind('Read', { file_path: path.join(root, 'storage', 'other.txt') }), 'ask');
		assert.strictEqual(kind('Read', { file_path: path.join(config, 'settings.json') }), 'ask');
		assert.strictEqual(kind('Read', { file_path: path.join(config, 'projects', '..', 'settings.json') }), 'ask');
		assert.strictEqual(kind('Write', { file_path: spilled, content: 'x' }), 'deny');
	});

	test('story 8.5 (amended): writes under .git/ or .vscode/, and to .envrc or .env*, always ask with no session key', () => {
		for (const p of ['.git/hooks/pre-commit', '.vscode/tasks.json', 'sub/.git/config', '.envrc', '.env', '.env.local', 'sub/.env.production', '.git', '.vscode/x.design.md']) {
			for (const tool of ['Write', 'Edit']) {
				assert.deepStrictEqual(canUseToolDecision(tool, { file_path: path.join(ws, p) }, ctx()), { kind: 'ask', sessionKey: null }, `${tool} ${p}`);
			}
		}
		for (const p of ['.github/workflows/x.yaml', 'git/x', 'environment.yaml', 'a.env.yaml']) {
			assert.deepStrictEqual(canUseToolDecision('Write', { file_path: path.join(ws, p) }, ctx()), { kind: 'ask', sessionKey: 'Write' }, p);
		}
	});

	test('story 8.5: the note is the design stage\'s own: another stage (or none) asks for it', () => {
		const note = { file_path: path.join(ws, 'orders.design.md'), content: 'x' };
		assert.deepStrictEqual(decide('Write', note, { workspace: ws, skillsDir: skills, skill: 'rpcn-author' }), { kind: 'ask', sessionKey: 'Write' });
		assert.deepStrictEqual(decide('Write', note, { workspace: ws, skillsDir: skills }), { kind: 'ask', sessionKey: 'Write' });
	});

	test('story 8.5: the hook and canUseTool give the same answer for the same call', () => {
		const calls: [string, Record<string, unknown>][] = [
			['Bash', { command: `uv run ${script} binary` }], ['Bash', { command: 'ls' }], ['Write', { file_path: path.join(ws, 'a.design.md') }],
			['Edit', { file_path: path.join(ws, 'a.design.md') }], ['Write', { file_path: path.join(ws, 'a.yaml') }], ['Write', { file_path: path.join(root, 'a') }],
			['Read', { file_path: path.join(skills, 'x.md') }], ['Read', { file_path: path.join(root, 'x.md') }], ['Read', { file_path: path.join(ws, 'x.md') }],
			['mcp__rpcn__x', {}], ['WebFetch', {}], ['WebSearch', {}], ['Task', {}], ['Skill', {}], ['Write', { file_path: path.join(ws, '.envrc') }],
			['Read', { file_path: path.join(root, 'storage', 'assistant', 'claude-config', 'projects', 'p', 's', 'tool-results', 'z.txt') }],
			['Read', { file_path: path.join(root, 'storage', 'other.txt') }],
		];
		for (const [tool, input] of calls) {
			const hook = preToolUseDecision(tool, input, ctx());
			const can = canUseToolDecision(tool, input, ctx());
			assert.ok(hook, `a hook decision for ${tool}`);
			assert.strictEqual(hook.decision, can.kind, `${tool} ${JSON.stringify(input)}`);
		}
	});

	test('story 8.5: shellKey: the stages\' programs (rpk with its subcommand), or none', () => {
		const table: [string, string | null][] = [
			// The matrix's shell rows.
			// Manual check (8.3): the skills' check has its key (its plain form never asks: `decide` allows it first).
			[`uv run ${script} list`, 'rpcn_check list'],
			['uv run ws/evil/rpcn_check.py list', null],
			[`uv run ${script} list; rm x`, null],
			['~/.local/bin/rpk connect list --format jsonschema 2>/dev/null | python3 -I -c "import json,sys; print(len(json.load(sys.stdin)))"', 'rpk connect list | python3'],
			[`${path.join(root, '.local', 'bin', 'rpk')} connect list`, 'rpk connect list'],
			['rpk connect list --format json caches | python3 -I -c "other"', 'rpk connect list | python3'],
			['rpk cluster info', 'rpk cluster info'],
			['printf \'input: {}\' | timeout 60 rpk connect run /tmp/x.yaml', null],
			['rpk connect list > out.txt', null],
			['rpk connect list >> out.txt', null],
			// Wrappers, assignments, quotes, the read-only list.
			['timeout 60 rpk connect lint x.yaml', 'rpk connect lint'],
			['timeout -k 5 30s rpk topic list', 'rpk topic list'],
			['env rpk version', 'rpk version'],
			['env -S "rm -rf x" rpk version', null],
			['timeout rpk version', null],
			[`"${path.join(root, 'bin', 'redpanda-connect')}" fields inputs kafka`, 'redpanda-connect fields'],
			[`${path.join(root, 'bin', 'grep')} x a.yaml`, 'grep'],
			['redpanda-connect list --format json | jq -r ".inputs[]" | sort | uniq | wc -l', 'redpanda-connect list | jq | sort | uniq | wc'],
			['grep -rn "a;b|c" x.yaml', 'grep'],
			["grep 'a && b' x.yaml", 'grep'],
			['cat a.yaml 2>&1 | head -n 5', 'cat | head'],
			['ls -la 1>/dev/null 2>&1', 'ls'],
			['echo a\\;b', 'echo'],
			['strings bin | egrep x | cut -d: -f1 | tail -3', 'strings | egrep | cut | tail'],
			['printf "%s\\n" x', 'printf'],
			['rpk topic describe orders -p', 'rpk topic describe'],
			['rpk connect blobl', 'rpk connect blobl'],
			['rpk connect version', 'rpk connect version'],
			// Paths inside the workspace or the skills copy.
			['cat sub/a.yaml ./b.yaml', 'cat'],
			[`head -n 5 ${path.join(ws, 'a.yaml')}`, 'head'],
			[`grep -rn kafka ${path.join(skills, 'skills')}`, 'grep'],
			['grep --include=*.yaml -r x .', 'grep'],
			['jq .inputs a.json', 'jq'],
			// Never a key.
			// Story 8.5 (amended), key hijack: assignments, quoted or missing programs, programs in the workspace.
			['env FOO=1 rpk version', null],
			['FOO=1 BAR="a b" rpk cluster health', null],
			['PATH=./bin grep x', null],
			['LD_PRELOAD=./x.so cat a', null],
			['"~/rpk" connect list', null],
			['\'~/.local/bin/rpk\' connect list', null],
			['~/ws/rpk connect list', null],
			['~other/rpk connect list', null],
			[`${path.join(root, 'nope', 'grep')} x`, null],
			['/tmp/grep x', null],
			['$RPK connect list', null],
			// Story 8.5 (amended), read paths outside: ~, $HOME, /etc and other outside paths.
			['head ~/.ssh/id_rsa', null],
			['cat ~', null],
			['cat /etc/passwd', null],
			['cat ../secret.yaml', null],
			['cat sub/../../secret.yaml', null],
			[`cat ${path.join(ws, 'out-link', 'x')}`, null],
			['cat $HOME/.netrc', null],
			['cat "${HOME}/.netrc"', null],
			['grep -r token --include=x /', null],
			['jq --from-file=/etc/x.jq a.json', null],
			['rpk connect lint /tmp/x.yaml', null],
			// Story 8.5 (amended): options that write, follow, serve or read other files; python3 as the first stage.
			['sort --compress-program=gzip a', null],
			['sort -T /tmp a', null],
			['sort --temporary-directory=t a', null],
			['sort -rT t a', null],
			['tail -f a.log', null],
			['tail -F a.log', null],
			['tail --follow=name a.log', null],
			['tail -fn 5 a.log', null],
			['rpk connect blobl server', null],
			['redpanda-connect blobl server --no-open', null],
			['wc --files0-from=list', null],
			['jq --rawfile x a.txt .', null],
			['jq --slurpfile x a.json .', null],
			['jq -n --args $x a b', null],
			['jq -n --args a b', null],
			['python3 -I -c "print(1)"', null],
			['tail -n 5 a.log', 'tail'],
			['rpk connect lint -w x.yaml', null],
			['rpk connect lint --watch x.yaml', null],
			['redpanda-connect lint -w x.yaml', null],
			['rpk topic produce orders', null],
			['rpk topic delete orders', null],
			['rpk version extra', null],
			['rpk -X brokers=x cluster info', null],
			['redpanda-connect run x.yaml', null],
			['ls && rm x', null],
			['ls || rm x', null],
			['ls & rm x', null],
			['ls\nrm x', null],
			['echo `id`', null],
			['echo $(id)', null],
			['echo "$(id)"', null],
			['cat <(echo x)', null],
			['cat < x.yaml', null],
			['echo x >(cat)', null],
			['echo x > /tmp/y', null],
			['echo x &> out', null],
			['echo x 2> err.log', null],
			['python3 x.py', null],
			['python3 -c "print(1)"', null],
			['python3 -I -c "print(1)" extra', null],
			['sort -o out.txt in.txt', null],
			['uniq in.txt out.txt', null],
			['rm -rf x', null],
			['tee x', null],
			['curl https://example.com | jq', null],
			['./rpk connect list', null],
			['bin/grep x', null],
			[`${path.join(ws, 'grep')} x`, null],
			['echo "unterminated', null],
			['| grep x', null],
			['', null],
		];
		for (const [command, key] of table) {
			assert.strictEqual(shellKey(command, ws, skills, root), key, command);
		}
		// Never the exact text: two different commands, one key.
		assert.strictEqual(shellKey('rpk connect list inputs', ws), shellKey('rpk connect list --format json', ws));
	});

	test('manual check (8.3): the skills\' own rpcn_check, not in its plain form: the key "rpcn_check <subcommand>"; the plain form still allowed with no card', () => {
		const a = path.join(ws, 'a.yaml');
		const table: [string, string | null][] = [
			[`uv run ${script} lint ${a} 2>&1 | head -50`, 'rpcn_check lint'],
			[`uv run ${script} lint ${a} | head`, 'rpcn_check lint'],
			[`uv run ${script} fields inputs kafka 2>/dev/null`, 'rpcn_check fields'],
			[`uv run ${script} lint a.yaml 2>&1 | grep -n error | head -5`, 'rpcn_check lint'],
			[`uv run ${script} lint ${a} 2>&1 | python3 -I -c "import sys; print(sys.stdin.read()[:100])"`, 'rpcn_check lint'],
			[`cd ${ws} && uv run ${script} lint a.yaml`, null],
			['uv run ./rpcn_check.py lint a.yaml', null],
			['uv run skills/rpcn-design/scripts/rpcn_check.py lint a.yaml', null],
			[`uv run ${path.join(ws, 'evil', 'rpcn_check.py')} lint a.yaml`, null],
			[`uv run ${script} lint /tmp/x.yaml`, null],
			[`FOO=1 uv run ${script} lint a.yaml`, null],
			[`uv run ${script} lint $HOME/a.yaml`, null],
			[`uv run ${script} lint a.yaml > out.txt`, null],
			[`uv run ${script} lint a.yaml; rm x`, null],
			[`uv run ${script} lint a.yaml | tee out.txt`, null],
			[`uv run ${script}`, null],
			[`echo x | uv run ${script} lint`, null],
			['uv run other.py lint', null],
		];
		for (const [command, key] of table) {
			assert.strictEqual(shellKey(command, ws, skills, root), key, command);
		}
		// Without the skills copy in use, no rpcn_check key.
		assert.strictEqual(shellKey(`uv run ${script} lint a.yaml | head`, ws), null);
		// The plain form is still allowed with no card; the others ask with their key.
		assert.strictEqual(decide('Bash', { command: `uv run ${script} lint ${a}` }, ctx()).kind, 'allow');
		const asked = decide('Bash', { command: `uv run ${script} lint ${a} 2>&1 | head -50` }, ctx());
		assert.deepStrictEqual(asked, { kind: 'ask', sessionKey: 'rpcn_check lint' });
	});

	test('approvalDetail: the whole command, the URL, the query, or the file', () => {
		const long = `echo ${'x'.repeat(300)}`;
		assert.strictEqual(approvalDetail('Bash', { command: long }), long);
		assert.strictEqual(approvalDetail('Write', { file_path: '/w/a.yaml' }), '/w/a.yaml');
		assert.strictEqual(approvalDetail('WebFetch', { url: 'https://x', prompt: 'y' }), 'https://x');
		assert.strictEqual(approvalDetail('WebSearch', { query: 'redpanda connect' }), 'redpanda connect');
		assert.strictEqual(approvalDetail('WebFetch', {}), undefined);
		assert.strictEqual(approvalDetail('Task', { prompt: 'x' }), undefined);
	});

	test('approvalSummary names the command or the file', () => {
		assert.strictEqual(approvalSummary('Bash', { command: 'ls -la' }), 'run `ls -la`');
		assert.strictEqual(approvalSummary('Write', { file_path: '/w/a.yaml' }), 'write /w/a.yaml');
		assert.strictEqual(approvalSummary('WebFetch', {}), 'use WebFetch');
		assert.strictEqual(approvalSummary('Bash', { command: 'x'.repeat(300) }).length, 'run ``'.length + 200);
	});
});
