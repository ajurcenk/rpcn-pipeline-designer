import * as assert from 'assert';
import * as path from 'path';
import { displayPath, progressOf, PROGRESS_CHARS, resultEventOf, retryOf } from '../../../adapters/assistant/events';
import { questionsOf } from '../../../adapters/assistant/host';

// Story 8.1 (AD-26): the SDK's stream as the port's events: progress lines, the result or error, and
// `AskUserQuestion`'s input as question data.
suite('assistant event mapping (story 8.1)', () => {
	const ws = path.resolve('/w/project');
	const skills = path.resolve('/ext/assets/rpcn-skills');
	const ctx = { workspace: ws, skillsDir: skills };
	const assistant = (...content: unknown[]) => ({ type: 'assistant', parent_tool_use_id: null, message: { content } });

	test('each tool call and the first line of each text become one progress line', () => {
		const lines = progressOf(assistant(
			{ type: 'text', text: '\n  I will design it.\nMore detail.' },
			{ type: 'tool_use', name: 'Skill', input: { skill: 'rpcn-skills:rpcn-design' } },
			{ type: 'tool_use', name: 'Bash', input: { command: `uv run ${skills}/skills/rpcn-design/scripts/rpcn_check.py fields inputs redpanda` } },
			{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
			{ type: 'tool_use', name: 'Read', input: { file_path: path.join(skills, 'skills', 'rpcn-design', 'references', 'questions.md') } },
			{ type: 'tool_use', name: 'Write', input: { file_path: path.join(ws, 'orders.design.md') } },
			{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{}, {}] } },
			{ type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: path.join(ws, 'n.ipynb') } },
			{ type: 'tool_use', name: 'TodoWrite', input: {} },
		), ctx);
		assert.deepStrictEqual(lines, [
			'I will design it.',
			'Running the rpcn-design skill',
			'Checking with rpcn_check fields',
			'Running a shell command: ls -la',
			'Reading rpcn-skills/skills/rpcn-design/references/questions.md',
			'Writing orders.design.md',
			'Asking 2 questions',
			'Writing n.ipynb',
			'Using TodoWrite',
		]);
	});

	test('init names the model; subagent turns, user turns and other messages give none; long text is clipped', () => {
		assert.deepStrictEqual(progressOf({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }, ctx), ['Started (claude-opus-5-5)']);
		assert.deepStrictEqual(progressOf({ ...assistant({ type: 'text', text: 'x' }), parent_tool_use_id: 'toolu_1' }, ctx), []);
		assert.deepStrictEqual(progressOf({ type: 'user', message: { content: [{ type: 'tool_result' }] } }, ctx), []);
		assert.deepStrictEqual(progressOf({ type: 'stream_event' }, ctx), []);
		assert.deepStrictEqual(progressOf(null, ctx), []);
		const [long] = progressOf(assistant({ type: 'text', text: 'a'.repeat(500) }), ctx);
		assert.strictEqual(long.length, PROGRESS_CHARS);
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
