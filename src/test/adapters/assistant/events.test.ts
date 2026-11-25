import * as assert from 'assert';
import * as path from 'path';
import { displayPath, resultEventOf, retryOf, stepResult, StreamMapper } from '../../../adapters/assistant/events';
import { questionsOf } from '../../../adapters/assistant/host';

// Story 8.1 (AD-26): the SDK's stream as the port's events (story 8.12: steps, their ends and the reply), the result or error, and
// `AskUserQuestion`'s input as question data.
suite('assistant event mapping (story 8.1)', () => {
	const ws = path.resolve('/w/project');
	const skills = path.resolve('/ext/assets/rpcn-skills');
	const ctx = { workspace: ws, skillsDir: skills };
	const assistant = (...content: unknown[]) => ({ type: 'assistant', parent_tool_use_id: null, message: { content } });

	let n = 0;
	const use = (name: string, input: unknown) => ({ type: 'tool_use', id: `toolu_${++n}`, name, input });
	const result = (id: string, content: unknown, isError = false) => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
	const labels = (events: unknown[]) => events.map((e) => (e as { label?: string }).label);

	test('story 8.12: each top-level tool call is a step with its label; each text block a reply, in full', () => {
		const mapper = new StreamMapper(ctx);
		const events = mapper.map(assistant(
			{ type: 'text', text: '\n  I will design it.\nMore detail.' },
			use('Skill', { skill: 'rpcn-skills:rpcn-design' }),
			use('Bash', { command: `uv run ${skills}/skills/rpcn-design/scripts/rpcn_check.py fields inputs redpanda` }),
			use('Bash', { command: 'ls -la' }),
			use('Read', { file_path: path.join(skills, 'skills', 'rpcn-design', 'references', 'questions.md') }),
			use('Write', { file_path: path.join(ws, 'orders.design.md') }),
			use('AskUserQuestion', { questions: [{}, {}] }),
			use('NotebookEdit', { notebook_path: path.join(ws, 'n.ipynb') }),
			use('TodoWrite', {}),
		));
		assert.deepStrictEqual(events[0], { type: 'reply', text: '\n  I will design it.\nMore detail.' });
		assert.ok(events.slice(1).every((e) => e.type === 'step'));
		// Manual check 2: a shell command is the step's detail, not its label (an rpcn_check call has none).
		assert.deepStrictEqual(events.slice(1).map((e) => (e as { detail?: string }).detail), [undefined, undefined, 'ls -la', undefined, undefined, undefined, undefined, undefined]);
		assert.deepStrictEqual(labels(events.slice(1)), [
			'Running the rpcn-design skill',
			'Checking with rpcn_check fields',
			'Ran a shell command',
			'Reading a skill reference',
			'Writing orders.design.md',
			'Asking 2 questions',
			'Writing n.ipynb',
			'Using TodoWrite',
		]);
	});

	test('story 8.12: a tool_result ends its step (by tool_use_id): ok with the summary, failed with the error\'s first line', () => {
		const mapper = new StreamMapper(ctx);
		const [read] = mapper.map(assistant(use('Read', { file_path: path.join(ws, 'a.yaml') }))) as { id: string }[];
		const [bash] = mapper.map(assistant(use('Bash', { command: 'ls' }))) as { id: string }[];
		assert.deepStrictEqual(mapper.map(result(read.id, [{ type: 'text', text: '1\tinput:\n2\t  x: 1\n' }])), [{ type: 'stepDone', id: read.id, ok: true, result: '2 lines' }]);
		assert.deepStrictEqual(mapper.map(result(bash.id, '<tool_use_error>The user denied this.\nmore</tool_use_error>', true)),
			[{ type: 'stepDone', id: bash.id, ok: false, result: 'The user denied this.' }]);
		assert.deepStrictEqual(mapper.map(result(bash.id, 'again')), [], 'only once');
		assert.deepStrictEqual(mapper.map(result('toolu_unknown', 'x')), [], 'no step, no end');
	});

	test('manual check 1: reads and searches inside the skills copy share one label; the workspace\'s keep their paths', () => {
		const mapper = new StreamMapper(ctx);
		const events = mapper.map(assistant(
			use('Read', { file_path: path.join(skills, 'skills', 'rpcn-design', 'references', 'a.md') }),
			use('Glob', { pattern: `${skills}/skills/**/*.md` }),
			use('Grep', { path: path.join(skills, 'skills'), pattern: 'x' }),
			use('Read', { file_path: path.join(ws, 'a.yaml') }),
			use('Glob', { pattern: '**/*.yaml' }),
		));
		assert.deepStrictEqual(labels(events), ['Reading a skill reference', 'Reading a skill reference', 'Reading a skill reference', 'Reading a.yaml', 'Searching the workspace']);
	});

	test('story 8.12: short results: at most 60 characters; no summariser: empty', () => {
		assert.strictEqual(stepResult('Bash', {}, 'lots of output', true), '');
		assert.strictEqual(stepResult('Bash', {}, `Error: ${'x'.repeat(100)}`, false).length, 60);
		assert.strictEqual(stepResult('Glob', {}, 'No files found', true), '0 files');
		assert.strictEqual(stepResult('Glob', {}, 'a.yaml\nb.yaml', true), '2 files');
	});

	test('init names the model; subagent turns (SUBAGENT) and other messages give none', () => {
		const mapper = new StreamMapper(ctx);
		assert.deepStrictEqual(mapper.map({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }), [{ type: 'progress', text: 'Started (claude-opus-5-5)' }]);
		assert.deepStrictEqual(mapper.map({ ...assistant({ type: 'text', text: 'x' }, use('Read', {})), parent_tool_use_id: 'toolu_1' }), []);
		assert.deepStrictEqual(mapper.map({ type: 'user', message: { content: [{ type: 'tool_result' }] } }), []);
		assert.deepStrictEqual(mapper.map(assistant({ type: 'text', text: '   ' })), [], 'blank text');
		assert.deepStrictEqual(mapper.map({ type: 'stream_event' }), []);
		assert.deepStrictEqual(mapper.map(null), []);
	});

	test('a path outside the workspace and the skills shows only its name', () => {
		assert.strictEqual(displayPath('/home/someone/secret/notes.txt', ctx), 'notes.txt');
		assert.strictEqual(displayPath('sub/a.yaml', ctx), 'sub/a.yaml');
	});

	test('the result message: success is a result, an error result an error with its text', () => {
		assert.deepStrictEqual(resultEventOf({ type: 'result', subtype: 'success', is_error: false, result: 'Done.' }), { type: 'result', stopped: false, text: 'Done.' });
		assert.deepStrictEqual(resultEventOf({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 401 invalid api key' }),
			{ type: 'error', message: 'API Error: 401 invalid api key' });
		assert.deepStrictEqual(resultEventOf({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many turns'] }), { type: 'error', message: 'too many turns' });
		assert.deepStrictEqual(resultEventOf({ type: 'result', subtype: 'error_during_execution', is_error: true }), { type: 'error', message: 'The assistant stopped (error_during_execution).' });
		assert.strictEqual(resultEventOf({ type: 'assistant' }), undefined);
	});

	test('api_retry: a 401 or 403 is a refusal that ends the run; another failure a progress line', () => {
		assert.deepStrictEqual(retryOf({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: 401, error: 'authentication_failed' }),
			{ refused: true, text: 'The endpoint refused the request (HTTP 401, authentication_failed).' });
		assert.strictEqual(retryOf({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: 403, error: 'unknown' })?.refused, true);
		assert.deepStrictEqual(retryOf({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, error_status: 529, error: 'server_error' }),
			{ refused: false, text: 'The endpoint answered HTTP 529; retrying (attempt 2 of 10)' });
		assert.deepStrictEqual(retryOf({ type: 'system', subtype: 'api_retry', error_status: null }), { refused: false, text: 'The endpoint did not answer; retrying' });
		assert.strictEqual(retryOf({ type: 'system', subtype: 'init' }), undefined);
	});

	test('AskUserQuestion input becomes question data; a malformed one none', () => {
		assert.deepStrictEqual(questionsOf({
			questions: [{ question: 'Ordering?', header: 'Ordering', multiSelect: false, options: [{ label: 'No ordering (My pick)', description: 'Fastest' }, { label: 'Overall' }, { bad: 1 }] }],
		}), [{ question: 'Ordering?', header: 'Ordering', multiSelect: false, options: [{ label: 'No ordering (My pick)', description: 'Fastest' }, { label: 'Overall', description: '' }] }]);
		assert.strictEqual(questionsOf({ questions: [] }), undefined);
		assert.strictEqual(questionsOf({ questions: [{ question: 1, options: [] }] }), undefined);
		assert.strictEqual(questionsOf(undefined), undefined);
	});
});
