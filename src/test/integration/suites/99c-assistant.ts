// The RPCN AI Assistant's tracer bullet (story 8.1, AD-26), end to end in the stable run, with no model
// call: the assistant view through its test seams (`receive`, as the webview posts; its approval prompt
// replaced), against the scripted in-memory host (`helpers/fakeAssistantHost.ts`) and against the
// embedded Agent SDK talking to a local fake Messages API (`helpers/fakeMessagesApi.ts`). The stable run
// opens no folder: the seam holds a temporary folder as the workspace, and an `ok` binary state on a fake
// binary. The key goes through Set up assistant access… into the secret storage. Every row of the plan's
// matrix has a test (HAPPY_HOST, HAPPY_MODEL, NO_KEY, NO_BINARY, AGENT_ERROR, STOP, NO_LEAK). Story 8.12:
// every state test reads the chat's turns; the chat's own rows are in "the chat (story 8.12)".
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ASSISTANT_KEY_SECRET, ASSISTANT_KEY_URL_SECRET, SET_UP_ASSISTANT_ACCESS_COMMAND, type AssistantAccessUi } from '../../../adapters/vscode/assistantAccess';
import { ASSISTANT_VIEW_ID, BEFORE_SCHEME, bundledSkillsDir, RUN_ASSISTANT_COMMAND, type AssistantRunOutcome, type AssistantViewUi } from '../../../adapters/vscode/assistantView';
import { CREDENTIAL_MASK } from '../../../adapters/cloud/errors';
import type { BinaryState } from '../../../adapters/redpandaConnect/binary';
import { RUNTIME_MISSING_TEXT, unavailableText, type AssistantStateMessage, type AssistantTurnView } from '../../../shared/assistantProtocol';
import { agentSdkHost } from '../../../adapters/assistant/agentSdkHost';
import { hostPlatform } from '../../../adapters/assistant/platform';
import {
	AGREE_AND_INSTALL, INSTALL_RUNTIME_COMMAND, READ_TERMS, REMOVE_RUNTIME_COMMAND, RUNTIME_BUSY_TEXT, RUNTIME_TERMS_URL, UPDATE_RUNTIME_COMMAND,
	type AssistantRuntimeUi, type RuntimeInstallOutcome,
} from '../../../adapters/vscode/assistantRuntime';
import { type ExtensionApi } from '../../../extension';
import { FakeAssistantHosts, happyScript, readyNote, reply, RUN_2_QUESTIONS, step, stepDone, type FakeAssistantStep } from '../../helpers/fakeAssistantHost';
import { makeTempDir, REPO_ROOT, VERSION_4_112_SCRIPT, writeFakeBinary } from '../../helpers/fakeBinary';
import { ADP_401, FakeMessagesApi, toolUseId, type FakeTurn } from '../../helpers/fakeMessagesApi';
import { FakeProxy, FakeRegistry, fakeRuntime, SDK, tarball, tarballPath } from '../../helpers/fakeRegistry';
import { EXTENSION_ID, userFilesHolding, waitFor } from '../helpers';

// Not sk-, so only the key mask itself can catch it. Random-looking throughout: the leak scan looks for any
// 12 of its characters, and none of them may be ordinary words of the suite's paths (`rpcn-assistant-…`).
const KEY = 'Qz7wXkLp3mVt9rQs2NbHc8YdFg4JxWe6';
const REQUEST = 'Design a Redpanda Connect pipeline: read orders from a topic and post them to an API; failures to a dead-letter topic.';

suite('RPCN AI assistant (integration, story 8.1)', function () {
	this.timeout(120_000);
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const assistant = () => api().assistant!;
	const view = () => assistant().view;
	const state = (): AssistantStateMessage => view().state();
	/** Story 8.12: the conversation's last turn (the current or last run's). */
	const turn = (): AssistantTurnView => {
		const t = state().turns.at(-1);
		assert.ok(t, `a turn: ${JSON.stringify(state())}`);
		return t;
	};
	/** Story 8.12: the last turn's step labels. */
	const labels = (): string[] => turn().steps.map((x) => x.label);
	let root: string;
	let ws: string;
	let binary: BinaryState;
	let originalViewUi: AssistantViewUi;
	let originalAccessUi: AssistantAccessUi;
	const approvals: string[] = [];
	const shown: string[] = [];
	/** Story 8.12: Undo's questions, its answer, the info messages, the links opened outside. */
	const undoAsked: string[] = [];
	let undoWith = true;
	const infos: string[] = [];
	const externals: string[] = [];
	/** Manual check 3: what went to the clipboard seam. */
	const copied: string[] = [];
	/** The approval prompt's answer (default: Deny). */
	let approveWith: (summary: string) => Promise<boolean> = async () => false;

	/**
	 * Starts a run and waits until it has started (or ended without starting); resolves with a promise of
	 * its outcome, so the caller can act on the run while it goes.
	 */
	const startRun = async (request = REQUEST): Promise<{ readonly done: Promise<AssistantRunOutcome> }> => {
		const before = view().runsStarted;
		let settled = false;
		const done = view().run(request).finally(() => {
			settled = true;
		});
		await waitFor(() => view().runsStarted > before || settled, 10_000);
		return { done };
	};
	/** The posted answers for the open cards: each card's first option (the pick). */
	const answerPicks = async () => {
		const q = state().questions!;
		await view().receive({ type: 'answered', id: q.id, answers: q.questions.map((x) => x.options[0].label) });
	};
	/**
	 * NO_LEAK (review 11): neither the key nor any 12-character slice of it (its first and last 16 among
	 * them) is in a setting, a global storage file, a posted message or the output channel.
	 */
	const assertNoLeak = () => {
		const pieces = new Set([KEY, KEY.slice(0, 16), KEY.slice(-16)]);
		for (let i = 0; i + 12 <= KEY.length; i++) {
			pieces.add(KEY.slice(i, i + 12));
		}
		const posted = JSON.stringify(view().posted);
		const lines = api().outputLines().join('\n');
		for (const piece of pieces) {
			assert.deepStrictEqual(userFilesHolding(piece), [], `settings or global storage hold ${piece.length} characters of the key`);
			assert.ok(!posted.includes(piece), 'posted messages');
			assert.ok(!lines.includes(piece), 'output channel');
		}
	};
	/** Story 8.2: `redpandaConnect.assistant.skillsPath` in the user settings (`undefined`: removed). */
	const setSkillsPath = async (value: string | undefined) => {
		await vscode.workspace.getConfiguration('redpandaConnect.assistant').update('skillsPath', value, vscode.ConfigurationTarget.Global);
	};
	/** Story 8.2: a local copy of the bundled skills (a checkout's layout: `.claude-plugin/` and `skills/`). */
	const localSkills = (): string => {
		const dir = path.join(root, 'local-rpcn-skills');
		fs.rmSync(dir, { recursive: true, force: true });
		fs.cpSync(bundledSkillsDir(vscode.extensions.getExtension(EXTENSION_ID)!.extensionUri), dir, { recursive: true });
		return dir;
	};
	const resetWorkspace = () => {
		fs.rmSync(ws, { recursive: true, force: true });
		fs.mkdirSync(ws, { recursive: true });
	};

	suiteSetup(async () => {
		await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
		root = fs.realpathSync(makeTempDir('rpcn-assistant-'));
		ws = path.join(root, 'ws');
		fs.mkdirSync(ws);
		const bin = writeFakeBinary(root, 'redpanda-connect', VERSION_4_112_SCRIPT);
		binary = { kind: 'ok', path: bin, version: '4.112.0', invocation: [bin] };
		originalViewUi = view().ui;
		originalAccessUi = assistant().access.ui;
		view().ui = {
			approve: async (summary) => {
				approvals.push(summary);
				return approveWith(summary);
			},
			confirmUndo: async (message) => {
				undoAsked.push(message);
				return undoWith;
			},
			info: async (message) => infos.push(message),
			writeClipboard: async (text) => {
				copied.push(text);
			},
			openExternal: async (uri) => {
				externals.push(uri.toString());
				return true;
			},
		};
		assistant().access.ui = {
			input: async () => KEY,
			showInfo: async (m) => shown.push(m),
			showError: async (m) => shown.push(m),
		};
		await assistant().setAccessForTest({ key: null, binary, workspace: ws, uv: true });
		await vscode.commands.executeCommand(`${ASSISTANT_VIEW_ID}.focus`);
		await waitFor(() => view().visible, 10_000);
	});

	suiteTeardown(async () => {
		if (!root) {
			return;
		}
		view().stop();
		await waitFor(() => !view().running, 10_000);
		assistant().setHostFactory(undefined);
		await setSkillsPath(undefined);
		await assistant().setAccessForTest({ key: null, model: null, baseUrl: null, auth: null, binary: null, workspace: null, uv: null });
		view().idleTimeoutMs = undefined;
		view().ui = originalViewUi;
		assistant().access.ui = originalAccessUi;
		fs.rmSync(root, { recursive: true, force: true });
	});

	teardown(async () => {
		// A failed test may leave its run waiting: stopped, so the next one is not busy.
		view().stop();
		assert.ok(await waitFor(() => !view().running, 30_000), 'the run ended after Stop');
	});

	setup(async () => {
		approveWith = async () => false;
		approvals.length = 0;
		shown.length = 0;
		undoAsked.length = 0;
		undoWith = true;
		infos.length = 0;
		externals.length = 0;
		copied.length = 0;
		// Story 8.12: each test starts a new conversation (the previous one's turns and snapshots go).
		await view().newConversation();
		resetWorkspace();
	});

	test('package.json: the view in its own activity-bar container, the set-up command in the palette, run hidden, the three settings', () => {
		const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as {
			contributes: {
				viewsContainers: { activitybar: { id: string; icon: string }[] }; views: Record<string, { id: string; type?: string }[]>;
				commands: { command: string; title: string }[]; menus: { commandPalette: { command: string; when?: string }[] };
				configuration: { properties: Record<string, { default?: unknown; enum?: unknown[]; scope?: string; markdownDescription?: string }> };
			};
		};
		const c = pkg.contributes;
		assert.deepStrictEqual(c.viewsContainers.activitybar.find((x) => x.id === 'redpandaConnectAssistant')?.icon, '$(sparkle)');
		assert.deepStrictEqual(c.views.redpandaConnectAssistant, [{ type: 'webview', id: ASSISTANT_VIEW_ID, name: 'Assistant', contextualTitle: 'RPCN AI Assistant' }]);
		assert.strictEqual(c.commands.find((x) => x.command === SET_UP_ASSISTANT_ACCESS_COMMAND)?.title, 'Set up assistant access…');
		assert.ok(!c.menus.commandPalette.some((m) => m.command === SET_UP_ASSISTANT_ACCESS_COMMAND), 'set-up stays in the palette');
		assert.deepStrictEqual(c.menus.commandPalette.filter((m) => m.command === RUN_ASSISTANT_COMMAND), [{ command: RUN_ASSISTANT_COMMAND, when: 'false' }]);
		const props = c.configuration.properties;
		assert.strictEqual(props['redpandaConnect.assistant.model'].default, 'claude-opus-5-5');
		assert.deepStrictEqual(props['redpandaConnect.assistant.auth'].enum, ['bearer', 'x-api-key']);
		assert.strictEqual(props['redpandaConnect.assistant.auth'].default, 'bearer');
		assert.ok('redpandaConnect.assistant.baseUrl' in props);
		assert.ok(Object.keys(props).filter((k) => k.startsWith('redpandaConnect.assistant.')).every((k) => props[k].scope === 'application'), 'user settings only');
		assert.ok(!Object.keys(props).some((k) => /apiKey|key$/i.test(k)), 'no setting holds the key');
		assert.ok(fs.existsSync(path.join(bundledSkillsDir(vscode.extensions.getExtension(EXTENSION_ID)!.extensionUri), '.claude-plugin', 'plugin.json')), 'the bundled skills copy');
		// Story 8.2: the runtime commands, and the skills path (empty by default; its scripts run without asking).
		assert.deepStrictEqual([INSTALL_RUNTIME_COMMAND, UPDATE_RUNTIME_COMMAND, REMOVE_RUNTIME_COMMAND].map((id) => c.commands.find((x) => x.command === id)?.title),
			['Install assistant runtime…', 'Update assistant runtime…', 'Remove assistant runtime']);
		const skillsPath = props['redpandaConnect.assistant.skillsPath'] as { default?: unknown; markdownDescription?: string };
		assert.strictEqual(skillsPath.default, '');
		assert.ok(skillsPath.markdownDescription?.includes('run without asking'), skillsPath.markdownDescription);
	});

	test('NO_KEY: no key: the view says access isn\'t set up and offers the set-up; nothing starts. Escape stores nothing; the set-up stores the key', async () => {
		const hosts = new FakeAssistantHosts(happyScript());
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: null });
		const before = view().runsStarted;
		assert.strictEqual(await view().run(REQUEST), 'noAccess');
		assert.strictEqual(view().runsStarted, before, 'nothing starts');
		assert.strictEqual(hosts.made.length, 0);
		assert.strictEqual(state().access, 'noAccess');
		assert.strictEqual(view().posted.at(-1)?.access, 'noAccess');

		assistant().access.ui = { ...assistant().access.ui, input: async () => undefined };
		assert.strictEqual(await vscode.commands.executeCommand(SET_UP_ASSISTANT_ACCESS_COMMAND), 'cancelled');
		assert.ok(!assistant().access.hasKey, 'Escape stores nothing');
		assistant().access.ui = { ...assistant().access.ui, input: async () => KEY };
		// The view's button posts setUpAccessRequested, which runs the command.
		await view().receive({ type: 'setUpAccessRequested' });
		assert.ok(await waitFor(() => assistant().access.hasKey, 5_000), 'the set-up stored the key');
		assert.strictEqual(state().access, 'ready');
	});

	test('NO_BINARY: the binary state isn\'t ok: the view says the assistant needs Redpanda Connect; nothing starts', async () => {
		const hosts = new FakeAssistantHosts(happyScript());
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY, binary: { kind: 'missing' } });
		try {
			const before = view().runsStarted;
			assert.strictEqual(await view().run(REQUEST), 'noBinary');
			assert.strictEqual(view().runsStarted, before);
			assert.strictEqual(hosts.made.length, 0);
			assert.strictEqual(state().access, 'noBinary');
		} finally {
			await assistant().setAccessForTest({ binary });
		}
	});

	test('HAPPY_HOST: progress lines, then 2 question cards (pick first); the answers go back; the note shows with status ready', async () => {
		const hosts = new FakeAssistantHosts(happyScript());
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY });
		const { done } = await startRun();
		assert.ok(await waitFor(() => state().status === 'question', 10_000), JSON.stringify(state()));
		const s = state();
		assert.deepStrictEqual(labels(), ['Running the rpcn-design skill', 'Checking with rpcn_check binary', 'Asking 2 questions']);
		assert.deepStrictEqual(turn().steps.map((x) => x.mark), ['ok', 'ok', 'running']);
		assert.strictEqual(turn().text, REQUEST);
		assert.strictEqual(turn().skill, 'rpcn-design');
		assert.deepStrictEqual(s.questions?.questions.map((q) => q.header), ['Ordering', 'Duplicates']);
		assert.deepStrictEqual(s.questions?.questions.map((q) => q.options.map((o) => o.label)), [
			['No ordering (My pick)', 'Per customer_id', 'Overall'],
			['No dedupe (My pick)', 'Dedupe on order id', 'API dedupes on id'],
		], 'the pick first, then the skill\'s order');
		assert.deepStrictEqual(s.questions?.questions.map((q) => q.options.map((o) => o.pick)), [[true, false, false], [true, false, false]]);
		assert.strictEqual(turn().note, null);
		// A malformed answer (a missing question) changes nothing.
		await view().receive({ type: 'answered', id: s.questions!.id, answers: ['Overall'] });
		assert.strictEqual(state().status, 'question');
		await answerPicks();
		assert.strictEqual(await done, 'done');
		assert.deepStrictEqual(hosts.last?.answers.get('q1'), {
			[RUN_2_QUESTIONS[0].question]: 'No ordering (My pick)', [RUN_2_QUESTIONS[1].question]: 'No dedupe (My pick)',
		});
		assert.strictEqual(hosts.last?.requests[0].skill, 'rpcn-design');
		assert.strictEqual(hosts.last?.requests[0].prompt, REQUEST);
		assert.strictEqual(hosts.last?.config.workspace, ws);
		assert.strictEqual(hosts.last?.config.rpcnBinary, (binary as { path: string }).path);
		const end = state();
		assert.strictEqual(end.status, 'done');
		assert.strictEqual(end.questions, null);
		assert.deepStrictEqual(turn().note, { file: 'orders_to_api.design.md', status: 'ready' });
		// Manual check 1: the question's own row says what came of it; no second "Answered" row.
		assert.ok(labels().includes('Asked 2 questions · you kept 2 picks'), JSON.stringify(labels()));
		assert.ok(!labels().some((l) => l.startsWith('Answered') || l.startsWith('Asking')), JSON.stringify(labels()));
		assert.ok(end.designReady, 'Design ✓');
	});

	test('HAPPY_HOST: the note\'s status is the file\'s on disk (a draft note shows draft)', async () => {
		const script = happyScript('clicks').map((step) => ('write' in step ? { write: { ...step.write, content: readyNote('clicks', 'draft') } } : step));
		assistant().setHostFactory(new FakeAssistantHosts(script).factory);
		const { done } = await startRun();
		assert.ok(await waitFor(() => state().status === 'question', 10_000));
		await answerPicks();
		assert.strictEqual(await done, 'done');
		assert.deepStrictEqual(turn().note, { file: 'clicks.design.md', status: 'draft' });
		assert.strictEqual(state().designReady, false);
	});

	test('AGENT_ERROR (fake host): the error line is masked; the run ends; a new request works', async () => {
		const hosts = new FakeAssistantHosts([
			{ emit: { type: 'progress', text: 'Running the rpcn-design skill' } },
			{ emit: { type: 'error', message: `API Error: 401 {"error":"invalid key ${KEY}"} Authorization: Bearer ${KEY}` } },
		]);
		assistant().setHostFactory(hosts.factory);
		assert.strictEqual(await view().run(REQUEST), 'error');
		const s = state();
		assert.strictEqual(s.status, 'error');
		assert.ok(s.error?.includes('API Error: 401'), s.error ?? '');
		assert.ok(!s.error?.includes(KEY) && s.error?.includes(CREDENTIAL_MASK), s.error ?? '');
		assert.ok(!api().outputLines().some((l) => l.includes(KEY)), 'logged masked');
		assert.ok(api().outputLines().some((l) => l.startsWith('Assistant: the run failed: API Error: 401')));
		hosts.script = happyScript();
		const { done } = await startRun();
		assert.ok(await waitFor(() => state().status === 'question', 10_000));
		assert.strictEqual(state().error, null, 'a new run clears the error');
		await answerPicks();
		assert.strictEqual(await done, 'done');
	});

	test('STOP (fake host): Stop while the run waits on a question: aborted, shown stopped, nothing more written', async () => {
		const hosts = new FakeAssistantHosts(happyScript());
		assistant().setHostFactory(hosts.factory);
		const { done } = await startRun();
		assert.ok(await waitFor(() => state().status === 'question', 10_000));
		await view().receive({ type: 'stopRequested' });
		assert.strictEqual(await done, 'stopped');
		assert.ok(hosts.last?.cancelled);
		assert.strictEqual(state().status, 'stopped');
		assert.strictEqual(state().questions, null);
		assert.strictEqual(turn().note, null);
		assert.strictEqual(turn().outcome, 'stopped');
		assert.deepStrictEqual(turn().files, []);
		assert.deepStrictEqual(fs.readdirSync(ws), [], 'nothing was written');
		assert.ok(!view().running);
	});

	test('the run command focuses the view and runs; a second request while one runs is busy', async () => {
		assistant().setHostFactory(new FakeAssistantHosts(happyScript()).factory);
		const done = vscode.commands.executeCommand<AssistantRunOutcome>(RUN_ASSISTANT_COMMAND, REQUEST);
		assert.ok(await waitFor(() => state().status === 'question', 10_000));
		assert.ok(view().visible);
		assert.strictEqual(await view().run('another'), 'busy');
		await answerPicks();
		assert.strictEqual(await done, 'done');
	});

	test('review 2: two requests at once: the second is busy, and only one run starts', async () => {
		const hosts = new FakeAssistantHosts(happyScript());
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY });
		const before = view().runsStarted;
		const first = view().run(REQUEST);
		const second = view().run(REQUEST);
		assert.strictEqual(await second, 'busy');
		assert.ok(await waitFor(() => state().status === 'question', 10_000));
		assert.strictEqual(view().runsStarted, before + 1);
		assert.strictEqual(hosts.made.length, 1);
		await answerPicks();
		assert.strictEqual(await first, 'done');
	});

	test('review 3, 15: an http base URL off loopback is not usable; a key set up for another base URL sends nothing', async () => {
		const hosts = new FakeAssistantHosts(happyScript());
		assistant().setHostFactory(hosts.factory);
		try {
			await assistant().setAccessForTest({ key: KEY, baseUrl: 'http://adp.example.com' });
			assert.strictEqual(state().access, 'badBaseUrl');
			assert.strictEqual(await view().run(REQUEST), 'badBaseUrl');
			await assistant().setAccessForTest({ key: KEY, baseUrl: 'https://adp.example.com', keyBaseUrl: 'https://api.anthropic.com' });
			assert.strictEqual(state().access, 'baseUrlChanged');
			assert.strictEqual(await view().run(REQUEST), 'baseUrlChanged');
			assert.strictEqual(hosts.made.length, 0, 'nothing started, nothing sent');
			// Set up again for the new URL: ready.
			assert.strictEqual(await vscode.commands.executeCommand(SET_UP_ASSISTANT_ACCESS_COMMAND), 'stored');
			assert.strictEqual(state().access, 'ready');
		} finally {
			await assistant().setAccessForTest({ baseUrl: null, key: KEY });
		}
	});

	test('review 7: no uv on the PATH: the view says so; nothing starts', async () => {
		const hosts = new FakeAssistantHosts(happyScript());
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY, uv: false });
		try {
			assert.strictEqual(await view().run(REQUEST), 'noUv');
			assert.strictEqual(state().access, 'noUv');
			assert.strictEqual(hosts.made.length, 0);
		} finally {
			await assistant().setAccessForTest({ uv: true });
		}
	});

	test('review 22: NO_WORKSPACE: no folder open: the view says so; nothing starts', async () => {
		const hosts = new FakeAssistantHosts(happyScript());
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY, workspace: null });
		try {
			assert.strictEqual(vscode.workspace.workspaceFolders, undefined, 'the stable run opens no folder');
			assert.strictEqual(await view().run(REQUEST), 'noWorkspace');
			assert.strictEqual(state().access, 'noWorkspace');
			assert.strictEqual(hosts.made.length, 0);
		} finally {
			await assistant().setAccessForTest({ workspace: ws });
		}
	});

	test('review 5: two approvals open at once: approval until both are decided, each by its id', async () => {
		const pending: ((allow: boolean) => void)[] = [];
		approveWith = () => new Promise((resolve) => pending.push(resolve));
		const hosts = new FakeAssistantHosts([
			{ emit: { type: 'approval', id: 'a1', tool: 'Bash', summary: 'run `ls`' } },
			{ emit: { type: 'approval', id: 'a2', tool: 'WebFetch', summary: 'use WebFetch' } },
			{ waitApproval: 'a1' },
			{ waitApproval: 'a2' },
		]);
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY });
		const { done } = await startRun();
		assert.ok(await waitFor(() => pending.length === 2, 10_000));
		assert.strictEqual(state().status, 'approval');
		pending[1](true);
		assert.ok(await waitFor(() => hosts.last!.approvals.has('a2'), 5_000));
		assert.strictEqual(state().status, 'approval', 'a1 is still open');
		pending[0](false);
		assert.strictEqual(await done, 'done');
		assert.deepStrictEqual([...hosts.last!.approvals], [['a2', true], ['a1', false]]);
	});

	test('review 5: two questions open: the oldest cards first, then the next; a withdrawn question\'s cards go', async () => {
		const one = [RUN_2_QUESTIONS[0]];
		const two = [RUN_2_QUESTIONS[1]];
		const hosts = new FakeAssistantHosts([
			{ emit: { type: 'question', id: 'q1', questions: one } },
			{ emit: { type: 'question', id: 'q2', questions: two } },
			{ emit: { type: 'question', id: 'q3', questions: two } },
			{ emit: { type: 'withdrawn', id: 'q3' } },
			{ waitAnswer: 'q1' },
			{ waitAnswer: 'q2' },
		]);
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY });
		const { done } = await startRun();
		assert.ok(await waitFor(() => state().questions?.id === 'q1', 10_000));
		assert.strictEqual(state().status, 'question');
		await answerPicks();
		assert.ok(await waitFor(() => state().questions?.id === 'q2', 5_000), JSON.stringify(state().questions));
		await answerPicks();
		assert.strictEqual(await done, 'done');
		assert.ok(!hosts.last!.answers.has('q3'), 'the withdrawn one was never answered');
		assert.deepStrictEqual(hosts.last!.answers.get('q2'), { [RUN_2_QUESTIONS[1].question]: 'No dedupe (My pick)' });
	});

	test('review 13, 20: the home folder arrives as ~; an answer goes back under its question\'s own text, by index', async () => {
		const home = os.homedir();
		const asked = [
			{ question: `Write the note to ${home}/notes?`, header: 'Where', multiSelect: false, options: [{ label: 'Yes (My pick)', description: `${home}/notes` }, { label: 'No', description: '' }] },
			{ question: `Write the note to ${home}/notes?`, header: 'Again', multiSelect: false, options: [{ label: 'Yes (My pick)', description: '' }, { label: 'No', description: '' }] },
		];
		const hosts = new FakeAssistantHosts([
			{ emit: { type: 'progress', text: `Reading ${home}/x.yaml` } },
			{ emit: { type: 'question', id: 'q1', questions: asked } },
			{ waitAnswer: 'q1' },
			{ emit: { type: 'error', message: `failed in ${home}/y` } },
		]);
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY });
		const { done } = await startRun();
		assert.ok(await waitFor(() => state().status === 'question', 10_000));
		const s = state();
		assert.deepStrictEqual(labels(), ['Reading ~/x.yaml']);
		assert.deepStrictEqual(s.questions?.questions.map((q) => q.question), ['Write the note to ~/notes?', 'Write the note to ~/notes?']);
		assert.strictEqual(s.questions?.questions[0].options[0].description, '~/notes');
		await view().receive({ type: 'answered', id: 'q1', answers: ['Yes (My pick)', 'No'] });
		assert.strictEqual(await done, 'error');
		assert.strictEqual(state().error, 'failed in ~/y');
		assert.ok(!JSON.stringify(view().posted).includes(home + path.sep));
		// Manual check 1: with no question step to fold into, one line: a kept pick and an answer.
		assert.deepStrictEqual(labels(), ['Reading ~/x.yaml', 'Asked 2 questions · you kept 1 pick, answered 1']);
		// Both questions have the same text: the record keeps the last, under the original (unmasked) text.
		assert.deepStrictEqual(hosts.last!.answers.get('q1'), { [asked[0].question]: 'No' });
	});

	test('review 21: only a design note inside the workspace is the note: not another file, not one outside', async () => {
		const outside = path.join(root, 'elsewhere.design.md');
		const hosts = new FakeAssistantHosts([
			{ write: { file: 'orders.yaml', content: 'input: {}\n' } },
			{ write: { file: 'orders_to_api.design.md', content: readyNote('orders_to_api') } },
			{ emit: { type: 'fileWritten', path: outside } },
			{ write: { file: 'notes.md', content: '# x\n' } },
		]);
		fs.writeFileSync(outside, readyNote('elsewhere', 'draft'));
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY });
		assert.strictEqual(await view().run(REQUEST), 'done');
		assert.deepStrictEqual(turn().note, { file: 'orders_to_api.design.md', status: 'ready' });
	});

	test('review 12: a line another component logs with the key in it is masked in the output channel', async () => {
		await assistant().setAccessForTest({ key: KEY });
		const uri = vscode.Uri.file(path.join(root, `${KEY}.yaml`));
		await vscode.commands.executeCommand('redpandaConnect.run', uri);
		assert.ok(await waitFor(() => api().outputLines().some((l) => l.startsWith('Run: ') && l.includes('is not open')), 5_000));
		const line = api().outputLines().filter((l) => l.startsWith('Run: ') && l.includes('is not open')).at(-1)!;
		assert.ok(line.includes(CREDENTIAL_MASK) && !line.includes(KEY), line);
	});

	test('story 8.2: BAD_SKILLS_PATH: a skills path without .claude-plugin/plugin.json: the view says so; nothing starts', async () => {
		const hosts = new FakeAssistantHosts(happyScript());
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY });
		const notACheckout = path.join(root, 'not-a-checkout');
		fs.mkdirSync(path.join(notACheckout, 'skills'), { recursive: true });
		await setSkillsPath(notACheckout);
		try {
			assert.ok(await waitFor(() => state().access === 'badSkillsPath', 5_000), JSON.stringify(state()));
			assert.strictEqual(await view().run(REQUEST), 'badSkillsPath');
			assert.strictEqual(hosts.made.length, 0, 'nothing starts');
		} finally {
			await setSkillsPath(undefined);
		}
		assert.strictEqual(state().access, 'ready');
		assert.strictEqual(state().skills, 'bundled');
	});

	test('story 8.2: BAD_SKILLS_PATH (in the workspace): a checkout inside the workspace folder: inWorkspace; nothing starts', async () => {
		const hosts = new FakeAssistantHosts(happyScript());
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY });
		const inside = path.join(ws, 'rpcn-skills');
		fs.cpSync(bundledSkillsDir(vscode.extensions.getExtension(EXTENSION_ID)!.extensionUri), inside, { recursive: true });
		await setSkillsPath(inside);
		try {
			assert.ok(await waitFor(() => state().access === 'badSkillsPath', 5_000), JSON.stringify(state()));
			assert.strictEqual(state().skillsProblem, 'inWorkspace');
			assert.strictEqual(state().skills, null);
			assert.strictEqual(await view().run(REQUEST), 'badSkillsPath');
			assert.strictEqual(hosts.made.length, 0, 'nothing starts');
		} finally {
			await setSkillsPath(undefined);
		}
	});

	test('story 8.2: SKILLS_PATH (fake host): a valid skills path is the run\'s copy; the view says "Skills: local copy"', async () => {
		const hosts = new FakeAssistantHosts(happyScript());
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY });
		const local = localSkills();
		await setSkillsPath(local);
		try {
			assert.ok(await waitFor(() => state().skills === 'local', 5_000), JSON.stringify(state()));
			assert.strictEqual(state().access, 'ready');
			const { done } = await startRun();
			assert.ok(await waitFor(() => state().status === 'question', 10_000), JSON.stringify(state()));
			await answerPicks();
			assert.strictEqual(await done, 'done');
			assert.strictEqual(hosts.last?.config.skillsDir, local);
			assert.ok(api().outputLines().some((l) => l.includes('a design run started') && l.includes('the local skills copy')));
		} finally {
			await setSkillsPath(undefined);
		}
		assert.strictEqual(state().skills, 'bundled');
	});

	// Story 8.12: the chat (option A) against the scripted fake host: the turns, the step rows, the file rows
	// and their diff, Keep and Undo, the slash commands, New conversation, the links, and masking.
	suite('the chat (story 8.12)', () => {
		const NOTE = 'orders_to_api.design.md';
		const run = async (script: FakeAssistantStep[], request = REQUEST) => {
			const hosts = new FakeAssistantHosts(script);
			assistant().setHostFactory(hosts.factory);
			await assistant().setAccessForTest({ key: KEY });
			const outcome = await view().run(request);
			return { outcome, hosts };
		};
		const happy = async () => {
			assistant().setHostFactory(new FakeAssistantHosts(happyScript()).factory);
			await assistant().setAccessForTest({ key: KEY });
			const { done } = await startRun();
			assert.ok(await waitFor(() => state().status === 'question', 10_000), JSON.stringify(state()));
			await answerPicks();
			assert.strictEqual(await done, 'done');
		};
		const diffTab = () => {
			const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
			return input instanceof vscode.TabInputTextDiff ? input : undefined;
		};

		teardown(async () => {
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		});

		test('HAPPY_DESIGN: one turn: steps ✓ with results, the reply, a row for the note with +N, Keep, Undo, Open note, /build and /test off with their hints', async () => {
			await happy();
			const t = turn();
			assert.strictEqual(state().turns.length, 1);
			assert.strictEqual(t.command, 'design');
			assert.strictEqual(t.outcome, 'done');
			assert.ok(t.steps.filter((x) => x.mark !== 'info').every((x) => x.mark === 'ok'), JSON.stringify(t.steps));
			assert.strictEqual(t.steps.find((x) => x.id === 's2')?.result, 'ok · 4.112.0');
			assert.strictEqual(t.reply, `The design note **${NOTE}** is \`ready\`.`);
			assert.deepStrictEqual(t.files, [{ path: NOTE, added: readyNote('orders_to_api').split('\n').length - 1, removed: 0, created: true, tooLarge: false }]);
			assert.strictEqual(t.review, 'pending');
			assert.deepStrictEqual(t.actions.map((a) => [a.id, a.label, a.enabled]), [['openNote', 'Open note', true]]);
			assert.deepStrictEqual(t.chips, [
				{ label: '/build', command: 'build', enabled: false, hint: 'Arrives with the Author stage' },
				{ label: '/test', command: 'test', enabled: false, hint: 'Arrives with the Test hand-off' },
			]);
			assert.strictEqual(state().folder, path.basename(ws));
			// Open note opens the note.
			await view().receive({ type: 'turnAction', turn: t.id, action: 'openNote' });
			assert.ok(await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath === path.join(ws, NOTE), 5_000));
		});

		test('DIFF: a click on the note\'s row opens vscode.diff: an empty left side (a new file), the note on the right; gone: an info message', async () => {
			await happy();
			const t = turn();
			assert.ok(await view().openFileDiff(t.id, NOTE));
			assert.ok(await waitFor(() => diffTab() !== undefined, 5_000), 'a diff tab');
			const diff = diffTab()!;
			assert.strictEqual(diff.original.scheme, BEFORE_SCHEME);
			assert.strictEqual((await vscode.workspace.openTextDocument(diff.original)).getText(), '');
			assert.strictEqual(diff.modified.fsPath, path.join(ws, NOTE));
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			fs.rmSync(path.join(ws, NOTE));
			assert.strictEqual(await view().openFileDiff(t.id, NOTE), false);
			assert.strictEqual(infos.length, 1);
			assert.ok(infos[0].includes(NOTE) && infos[0].includes('no longer exists'), infos[0]);
			assert.strictEqual(diffTab(), undefined, 'no diff');
		});

		test('UNDO_EDIT and DIFF of an edit: the left side is the file before the turn; Undo makes it byte-identical', async () => {
			const before = 'input:\r\n  generate: {}\r\n# ünïcödé\r\n';
			fs.writeFileSync(path.join(ws, 'a.yaml'), before);
			await run([{ write: { file: 'a.yaml', content: 'input:\n  kafka: {}\n' } }, { write: { file: 'a.yaml', content: 'input:\n  kafka: {}\n  x: 1\n' } }]);
			assert.deepStrictEqual(turn().files.map((f) => [f.path, f.added, f.removed, f.created]), [['a.yaml', 2, 2, false]], 'the first snapshot wins');
			assert.ok(await view().openFileDiff(turn().id, 'a.yaml'));
			assert.ok(await waitFor(() => diffTab() !== undefined, 5_000));
			assert.strictEqual((await vscode.workspace.openTextDocument(diffTab()!.original)).getText(), before);
			assert.strictEqual(await view().undo(turn().id), 'undone');
			assert.deepStrictEqual(fs.readFileSync(path.join(ws, 'a.yaml')), Buffer.from(before, 'utf8'));
			assert.strictEqual(turn().review, 'undone');
			assert.deepStrictEqual(undoAsked, [], 'no later edits: not asked');
		});

		test('UNDO_NEW: the turn created a.yaml and the note; Undo deletes both; the turn shows Undone; Design ✓ goes', async () => {
			await run([{ write: { file: 'a.yaml', content: 'input: {}\n' } }, { write: { file: NOTE, content: readyNote('orders_to_api') } }]);
			assert.ok(state().designReady);
			assert.strictEqual(await view().undo(turn().id), 'undone');
			assert.deepStrictEqual(fs.readdirSync(ws), []);
			assert.strictEqual(turn().review, 'undone');
			assert.strictEqual(turn().notice, null);
			assert.strictEqual(turn().note, null);
			assert.deepStrictEqual(turn().actions, []);
			assert.strictEqual(state().designReady, false);
			assert.strictEqual(await view().undo(turn().id), 'none', 'once');
			assert.strictEqual(await view().openFileDiff(turn().id, 'a.yaml'), false, 'the rows are text now');
		});

		test('UNDO_NEW (new folders): Undo deletes the files and the folders the turn created for them; a folder holding another file stays', async () => {
			fs.mkdirSync(path.join(ws, 'existing'));
			await run([
				{ write: { file: 'flows/x/a.yaml', content: 'a\n' } },
				{ write: { file: 'flows/y/b.yaml', content: 'b\n' } },
				{ write: { file: 'existing/c.yaml', content: 'c\n' } },
			]);
			fs.writeFileSync(path.join(ws, 'flows', 'y', 'mine.txt'), 'mine');
			assert.strictEqual(await view().undo(turn().id), 'undone');
			assert.deepStrictEqual(undoAsked, []);
			assert.ok(!fs.existsSync(path.join(ws, 'flows', 'x')), 'the new folder went');
			assert.ok(!fs.existsSync(path.join(ws, 'flows', 'y', 'b.yaml')));
			assert.ok(fs.existsSync(path.join(ws, 'flows', 'y', 'mine.txt')), 'a folder holding a file stays');
			assert.ok(fs.existsSync(path.join(ws, 'existing')) && !fs.existsSync(path.join(ws, 'existing', 'c.yaml')), 'a folder that was there stays');
		});

		test('UNDO_NEW (a delete fails): an error line in the turn; the other files are still restored', async function () {
			if (process.platform === 'win32' || process.getuid?.() === 0) {
				this.skip();
			}
			fs.writeFileSync(path.join(ws, 'b.yaml'), 'old\n');
			const locked = path.join(ws, 'locked');
			await run([{ write: { file: 'locked/a.yaml', content: 'x\n' } }, { write: { file: 'b.yaml', content: 'new\n' } }]);
			fs.chmodSync(locked, 0o555);
			try {
				assert.strictEqual(await view().undo(turn().id), 'undone');
				assert.ok(turn().notice?.startsWith('Could not undo locked/a.yaml'), String(turn().notice));
				assert.strictEqual(fs.readFileSync(path.join(ws, 'b.yaml'), 'utf8'), 'old\n', 'the other file restored');
			} finally {
				fs.chmodSync(locked, 0o755);
			}
		});

		test('UNDO_LATER_EDIT: the user edited the file after the turn: Undo asks; Cancel restores nothing; OK restores every file', async () => {
			fs.writeFileSync(path.join(ws, 'a.yaml'), 'v1\n');
			await run([{ write: { file: 'a.yaml', content: 'v2\n' } }, { write: { file: 'b.yaml', content: 'new\n' } }]);
			fs.writeFileSync(path.join(ws, 'a.yaml'), 'v3 by hand\n');
			undoWith = false;
			assert.strictEqual(await view().undo(turn().id), 'cancelled');
			assert.deepStrictEqual(undoAsked, ['Undo will discard your edits to `a.yaml` since the turn.']);
			assert.strictEqual(fs.readFileSync(path.join(ws, 'a.yaml'), 'utf8'), 'v3 by hand\n');
			assert.ok(fs.existsSync(path.join(ws, 'b.yaml')), 'Cancel restores nothing');
			assert.strictEqual(turn().review, 'pending');
			undoWith = true;
			assert.strictEqual(await view().undo(turn().id), 'undone');
			assert.strictEqual(fs.readFileSync(path.join(ws, 'a.yaml'), 'utf8'), 'v1\n');
			assert.ok(!fs.existsSync(path.join(ws, 'b.yaml')));
		});

		test('KEEP: the buttons go, the snapshots drop; the rows stay, no longer clickable', async () => {
			await happy();
			const t = turn();
			assert.ok(view().keep(t.id));
			assert.strictEqual(turn().review, 'kept');
			assert.strictEqual(turn().files.length, 1, 'the row stays');
			assert.strictEqual(await view().openFileDiff(t.id, NOTE), false);
			assert.strictEqual(await view().undo(t.id), 'none');
			assert.ok(fs.existsSync(path.join(ws, NOTE)));
		});

		test('NO_CHANGE: a write of the same bytes, or a write announced and never made: no row, no Keep or Undo', async () => {
			fs.writeFileSync(path.join(ws, 'same.yaml'), 'same\n');
			await run([
				{ write: { file: 'same.yaml', content: 'same\n' } },
				{ emit: { type: 'fileChanging', path: path.join(ws, 'denied.yaml'), before: null } },
			]);
			assert.deepStrictEqual(turn().files, []);
			assert.strictEqual(turn().review, 'none');
		});

		test('BIG_FILE: a file over 1 MB: its row says too large to undo; no diff; Undo leaves it alone', async () => {
			const big = path.join(ws, 'big.json');
			fs.writeFileSync(big, 'x'.repeat(1024 * 1024 + 1));
			const after = 'y'.repeat(1024 * 1024 + 2);
			await run([{ write: { file: 'big.json', content: after } }, { write: { file: 'small.yaml', content: 'a\n' } }]);
			assert.deepStrictEqual(turn().files.map((f) => [f.path, f.tooLarge]), [['big.json', true], ['small.yaml', false]]);
			assert.strictEqual(await view().openFileDiff(turn().id, 'big.json'), false);
			assert.strictEqual(await view().undo(turn().id), 'undone');
			assert.strictEqual(fs.readFileSync(big, 'utf8'), after, 'left alone');
			assert.ok(!fs.existsSync(path.join(ws, 'small.yaml')));
		});

		test('STEP_FAIL: a failed step is ✗ with the first line of its error', async () => {
			await run([step('s1', 'Ran a shell command'), stepDone('s1', false, 'The user denied this.')]);
			assert.deepStrictEqual(turn().steps.map((x) => [x.mark, x.result]), [['failed', 'The user denied this.']]);
		});

		test('PLAIN and /design: both run rpcn-design; the turn shows the text as typed; the prompt is the text after the command', async () => {
			const { hosts } = await run([reply('ok')], 'orders to an API');
			assert.strictEqual(hosts.last?.requests[0].skill, 'rpcn-design');
			assert.strictEqual(hosts.last?.requests[0].prompt, 'orders to an API');
			assert.strictEqual(turn().text, 'orders to an API');
			await view().receive({ type: 'runRequested', command: 'design', request: '/design  clicks to a table' });
			assert.ok(await waitFor(() => !view().running && state().turns.length === 2, 5_000));
			assert.strictEqual(hosts.last?.requests[0].prompt, 'clicks to a table');
			assert.strictEqual(turn().text, '/design  clicks to a table');
			assert.strictEqual(await view().run('/design'), 'empty');
		});

		test('/build and /test: disabled; nothing runs, no turn', async () => {
			const hosts = new FakeAssistantHosts([reply('x')]);
			assistant().setHostFactory(hosts.factory);
			await assistant().setAccessForTest({ key: KEY });
			assert.strictEqual(await view().run('/build the pipeline'), 'disabled');
			await view().receive({ type: 'runRequested', command: 'test', request: 'the pipeline' });
			assert.strictEqual(hosts.made.length, 0);
			assert.deepStrictEqual(state().turns, []);
		});

		test('two turns: a new Send keeps the previous turn\'s changes; only the latest offers Keep and Undo', async () => {
			await run([{ write: { file: 'a.yaml', content: 'a\n' } }]);
			const first = turn().id;
			assert.strictEqual(turn().review, 'pending');
			await run([{ write: { file: 'b.yaml', content: 'b\n' } }]);
			const [one, two] = state().turns;
			assert.strictEqual(one.id, first);
			assert.strictEqual(one.review, 'kept');
			assert.strictEqual(two.review, 'pending');
			assert.strictEqual(await view().undo(first), 'none');
			assert.ok(fs.existsSync(path.join(ws, 'a.yaml')));
		});

		test('STATES in the chat: the approval row (status approval) in the running turn; stopped; an error', async () => {
			let resolve: ((allow: boolean) => void) | undefined;
			approveWith = () => new Promise((r) => (resolve = r));
			const hosts = new FakeAssistantHosts([{ emit: { type: 'approval', id: 'a1', tool: 'Bash', summary: 'run `ls`' } }, { waitApproval: 'a1' }]);
			assistant().setHostFactory(hosts.factory);
			await assistant().setAccessForTest({ key: KEY });
			const { done } = await startRun();
			assert.ok(await waitFor(() => resolve !== undefined, 10_000));
			assert.strictEqual(state().status, 'approval');
			assert.strictEqual(turn().outcome, 'running');
			// Manual check 2: an approval with no step of its own (the fake host sends none) is one row; its outcome its result.
			assert.deepStrictEqual(turn().steps.map((x) => [x.label, x.mark, x.result]), [['Asks to run `ls`', 'running', '']]);
			resolve!(false);
			assert.strictEqual(await done, 'done');
			assert.deepStrictEqual(turn().steps.map((x) => [x.label, x.mark, x.result]), [['Asks to run `ls`', 'failed', 'denied']]);
			await run([{ emit: { type: 'error', message: 'boom' } }]);
			assert.strictEqual(turn().outcome, 'error');
			assert.strictEqual(state().error, 'boom');
		});

		test('NEW_CONV: idle: the transcript and snapshots cleared; busy: the run stops first, then everything is cleared', async () => {
			await run([{ write: { file: 'a.yaml', content: 'a\n' } }]);
			const id = turn().id;
			await view().receive({ type: 'newConversation' });
			assert.deepStrictEqual(state().turns, []);
			assert.strictEqual(await view().undo(id), 'none', 'the snapshots went');
			assert.ok(fs.existsSync(path.join(ws, 'a.yaml')), 'the files stay');
			const hosts = new FakeAssistantHosts(happyScript());
			assistant().setHostFactory(hosts.factory);
			const { done } = await startRun();
			assert.ok(await waitFor(() => state().status === 'question', 10_000));
			await view().newConversation();
			assert.strictEqual(await done, 'stopped');
			assert.ok(hosts.last?.cancelled);
			assert.ok(!view().running);
			assert.deepStrictEqual(state().turns, []);
			assert.strictEqual(state().status, 'idle');
			assert.strictEqual(state().questions, null);
		});

		test('links: http(s) opens outside, a workspace file in the editor; javascript: and paths outside nothing', async () => {
			fs.writeFileSync(path.join(ws, 'a.yaml'), 'input: {}\n');
			await view().receive({ type: 'openLink', href: 'https://docs.redpanda.com/redpanda-connect/' });
			assert.deepStrictEqual(externals, ['https://docs.redpanda.com/redpanda-connect/']);
			await view().receive({ type: 'openLink', href: 'a.yaml' });
			assert.ok(await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath === path.join(ws, 'a.yaml'), 5_000));
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			for (const href of ['javascript:alert(1)', 'command:workbench.action.reloadWindow', '../outside.yaml', path.join(root, 'x.yaml'), 'file:///etc/hosts']) {
				assert.strictEqual(await view().openLink(href), undefined, href);
			}
			assert.strictEqual(externals.length, 1);
			assert.strictEqual(vscode.window.activeTextEditor, undefined);
		});

		test('manual check 3: copyText reaches the clipboard through the host (masked again); an empty or oversized one is refused', async () => {
			await assistant().setAccessForTest({ key: KEY });
			await view().receive({ type: 'copyText', text: '```yaml\ninput: {}\n```' });
			await view().receive({ type: 'copyText', text: `token ${KEY}` });
			await view().receive({ type: 'copyText', text: '' });
			await view().receive({ type: 'copyText', text: 'x'.repeat(100_001) });
			assert.deepStrictEqual(copied, ['```yaml\ninput: {}\n```', `token ${CREDENTIAL_MASK}`]);
		});

		test('LEAK: the key, a Bearer value and the home folder in the reply, a step result and a path are masked in every posted message', async () => {
			const home = os.homedir();
			await run([
				step('s1', `Reading ${home}/secret.yaml`),
				stepDone('s1', false, `Authorization: Bearer ${KEY}`),
				reply(`The key is ${KEY}; see ${home}/notes and Bearer ${KEY}`),
				{ write: { file: `${KEY}.yaml`, content: 'x\n' } },
			]);
			const posted = JSON.stringify(view().posted);
			assert.ok(!posted.includes(KEY), 'the key');
			assert.ok(!posted.includes(home + path.sep), 'the home folder');
			assert.ok(turn().reply.includes(CREDENTIAL_MASK) && turn().reply.includes('~/notes'), turn().reply);
			assert.ok(turn().files[0].path.includes(CREDENTIAL_MASK), turn().files[0].path);
			assertNoLeak();
		});

		test('limits: at most 50 turns, the oldest dropped first; at most 200 steps a turn', async () => {
			const steps: FakeAssistantStep[] = Array.from({ length: 210 }, (_, i) => step(`s${i}`, `step ${i}`));
			await run(steps);
			assert.strictEqual(turn().steps.length, 200);
			assert.strictEqual(turn().steps[0].label, 'step 10');
			const hosts = new FakeAssistantHosts([reply('x')]);
			assistant().setHostFactory(hosts.factory);
			for (let i = 0; i < 50; i++) {
				assert.strictEqual(await view().run(`request ${i}`), 'done');
			}
			assert.strictEqual(state().turns.length, 50);
			assert.strictEqual(state().turns[0].text, 'request 0');
		});
	});

	// Story 8.2: the assistant runtime, installed by the user from VS Code, against a fake registry (never the
	// real one). Each test starts with no runtime in a temporary folder, the development override off, no
	// proxy, and no agreement remembered. Every row of the plan's matrix has a test.
	suite('the assistant runtime (story 8.2)', () => {
		const runtime = () => assistant().runtime;
		const V1 = '9.0.1';
		const V2 = '9.0.2';
		const platform = hostPlatform();
		let registry: FakeRegistry;
		let rtRoot: string;
		let originalRuntimeUi: AssistantRuntimeUi;
		/** The terms modal's answers, in order (then Escape), and what it was shown. */
		let agreeWith: (string | undefined)[] = [];
		const asked: { readonly message: string; readonly detail: string }[] = [];
		const opened: string[] = [];
		const progressTitles: string[] = [];
		let cancelInstall: (() => void) | undefined;
		/** Everything under the runtime folder, relative. */
		const tree = () => (fs.existsSync(rtRoot) ? fs.readdirSync(rtRoot, { recursive: true }).map(String).sort() : []);
		const install = () => vscode.commands.executeCommand<RuntimeInstallOutcome>(INSTALL_RUNTIME_COMMAND);
		const binaryOf = (version: string) => path.join(rtRoot, version, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${platform}`, platform.startsWith('win32') ? 'claude.exe' : 'claude');

		suiteSetup(async () => {
			registry = new FakeRegistry();
			await registry.start();
			originalRuntimeUi = runtime().ui;
			runtime().ui = {
				agree: async (message, detail) => {
					asked.push({ message, detail });
					return agreeWith.shift();
				},
				openTerms: async (url) => opened.push(url),
				progress: async (title, task, cancel) => {
					progressTitles.push(title);
					cancelInstall = cancel;
					return task(() => undefined);
				},
				showInfo: async (m) => shown.push(m),
				showError: async (m) => shown.push(m),
			};
			await assistant().setAccessForTest({ key: KEY });
		});
		suiteTeardown(async () => {
			runtime().ui = originalRuntimeUi;
			await runtime().setForTest({ root: null, manifest: null, devOverride: null, platform: null, proxy: null, agreed: null });
			await registry?.stop();
		});
		setup(async () => {
			registry.reset();
			registry.files.clear();
			registry.serve(V1, platform);
			rtRoot = path.join(root, 'agent-runtime');
			fs.rmSync(rtRoot, { recursive: true, force: true });
			agreeWith = [AGREE_AND_INSTALL];
			asked.length = 0;
			opened.length = 0;
			progressTitles.length = 0;
			cancelInstall = undefined;
			assistant().setHostFactory(new FakeAssistantHosts(happyScript()).factory);
			await runtime().setForTest({ root: rtRoot, manifest: registry.manifest(V1, [platform, 'darwin-arm64']), devOverride: false, platform: null, proxy: {}, agreed: null });
			await assistant().setAccessForTest({ key: KEY });
		});
		teardown(async () => {
			registry.release();
			assert.ok(await waitFor(() => !runtime().busy, 10_000), 'no install left going');
		});

		test('FIRST_USE: no runtime: runtimeMissing with Install assistant runtime…; nothing starts; the runtime folder is in global storage', async () => {
			const hosts = new FakeAssistantHosts(happyScript());
			assistant().setHostFactory(hosts.factory);
			const s = state();
			assert.strictEqual(s.access, 'runtimeMissing', JSON.stringify(s));
			assert.deepStrictEqual(s.runtime, { pinned: V1, installed: null, error: null });
			assert.ok(RUNTIME_MISSING_TEXT.includes('Install assistant runtime…'));
			assert.strictEqual(await view().run(REQUEST), 'runtimeMissing');
			assert.strictEqual(hosts.made.length, 0, 'nothing starts');
			assert.strictEqual(registry.requests.length, 0, 'nothing downloaded');
			await runtime().setForTest({ root: null });
			try {
				assert.strictEqual(runtime().root(), path.join(REPO_ROOT, '.vscode-test', 'user-data', 'User', 'globalStorage', EXTENSION_ID, 'agent-runtime'));
			} finally {
				await runtime().setForTest({ root: rtRoot });
			}
		});

		test('AGREE_AND_INSTALL: the terms named and linked; progress; the two tarballs; claude executable; ready; a run uses only that runtime', async () => {
			agreeWith = [READ_TERMS, AGREE_AND_INSTALL];
			// The view's button posts installRuntimeRequested, which runs the command.
			await view().receive({ type: 'installRuntimeRequested' });
			assert.deepStrictEqual(opened, [RUNTIME_TERMS_URL], 'the terms link opened, then the modal again');
			assert.strictEqual(asked.length, 2);
			const detail = asked[0].detail;
			for (const text of [`${SDK} ${V1}`, `${SDK}-${platform} ${V1}`, registry.url, RUNTIME_TERMS_URL, AGREE_AND_INSTALL]) {
				assert.ok(detail.includes(text), `${text} in ${detail}`);
			}
			assert.deepStrictEqual(progressTitles, ['Installing the assistant runtime']);
			assert.deepStrictEqual(registry.requests.map((r) => r.url).sort(), [tarballPath(SDK, V1), tarballPath(`${SDK}-${platform}`, V1)].sort(), 'exactly the two tarballs');
			assert.ok(fs.statSync(binaryOf(V1)).mode & 0o111, 'claude keeps its executable bit');
			assert.deepStrictEqual(fs.readdirSync(rtRoot), [V1], 'no temporary folder left');
			assert.strictEqual(state().access, 'ready', JSON.stringify(state()));
			const hosts = new FakeAssistantHosts(happyScript());
			assistant().setHostFactory(hosts.factory);
			const { done } = await startRun();
			assert.ok(await waitFor(() => state().status === 'question', 10_000));
			await answerPicks();
			assert.strictEqual(await done, 'done');
			assert.deepStrictEqual(hosts.last?.config.runtime, {
				version: V1,
				sdk: path.join(rtRoot, V1, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'),
				binary: binaryOf(V1),
			});
			// Already installed: nothing asked, nothing downloaded.
			const requests = registry.requests.length;
			assert.strictEqual(await install(), 'current');
			assert.strictEqual(registry.requests.length, requests);
			assert.strictEqual(asked.length, 2);
		});

		test('DECLINE: Escape: nothing downloaded; still runtimeMissing. The agreement is remembered for that version only', async () => {
			agreeWith = [undefined];
			assert.strictEqual(await install(), 'declined');
			assert.strictEqual(registry.requests.length, 0, 'nothing downloaded');
			assert.deepStrictEqual(tree(), []);
			assert.strictEqual(state().access, 'runtimeMissing');
			agreeWith = [AGREE_AND_INSTALL];
			assert.strictEqual(await install(), 'installed');
			assert.strictEqual(asked.length, 2);
			assert.strictEqual(await vscode.commands.executeCommand(REMOVE_RUNTIME_COMMAND), 'removed');
			agreeWith = [];
			assert.strictEqual(await install(), 'installed', 'agreed to this version already: not asked again');
			assert.strictEqual(asked.length, 2);
		});

		test('BAD_HASH: nothing unpacked; runtimeFailed with the reason (masked) and Retry; Retry installs', async () => {
			registry.corrupt.add(tarballPath(`${SDK}-${platform}`, V1));
			assert.strictEqual(await install(), 'failed');
			assert.deepStrictEqual(tree(), [], 'nothing unpacked, no partial folder');
			const s = state();
			assert.strictEqual(s.access, 'runtimeFailed');
			assert.ok(s.runtime.error?.includes('didn\'t match the expected integrity'), JSON.stringify(s.runtime));
			assert.ok(api().outputLines().some((l) => l.startsWith('Assistant: the runtime install failed:') && l.includes('didn\'t match the expected integrity')));
			assert.ok(!JSON.stringify(view().posted).includes(os.homedir() + path.sep), 'masked');
			registry.corrupt.clear();
			await view().receive({ type: 'installRuntimeRequested' });
			assert.strictEqual(state().access, 'ready', JSON.stringify(state()));
			assert.strictEqual(asked.length, 1, 'Retry does not ask again for the same version');
		});

		test('OFFLINE / PROXY: the download fails, or the proxy refuses: runtimeFailed with the reason; no partial folder', async () => {
			await runtime().setForTest({ manifest: registry.manifest(V1, [platform], 'http://127.0.0.1:1') });
			assert.strictEqual(await install(), 'failed');
			assert.strictEqual(state().access, 'runtimeFailed');
			assert.ok(state().runtime.error?.includes('ECONNREFUSED'), JSON.stringify(state().runtime));
			assert.deepStrictEqual(tree(), []);
			const proxy = new FakeProxy();
			await proxy.start();
			try {
				await runtime().setForTest({ manifest: registry.manifest(V1, [platform], 'https://registry.example.invalid'), proxy: { proxy: proxy.url } });
				assert.strictEqual(await install(), 'failed');
				assert.ok(state().runtime.error?.includes('the proxy refused the connection (407)'), JSON.stringify(state().runtime));
				assert.deepStrictEqual(proxy.connects, ['registry.example.invalid:443'], 'through the proxy');
				assert.deepStrictEqual(tree(), []);
			} finally {
				await proxy.stop();
			}
		});

		test('CANCEL: Cancel during the download: no partial folder; runtimeMissing; nothing starts meanwhile', async () => {
			registry.hold = true;
			const going = install();
			assert.ok(await waitFor(() => registry.requests.length > 0 && cancelInstall !== undefined, 10_000));
			assert.strictEqual(state().access, 'runtimeInstalling');
			assert.strictEqual(await view().run(REQUEST), 'runtimeInstalling', 'nothing starts while it installs');
			assert.strictEqual(await install(), 'busy');
			cancelInstall!();
			assert.strictEqual(await going, 'cancelled');
			assert.deepStrictEqual(tree(), [], 'no partial folder');
			assert.strictEqual(state().access, 'runtimeMissing');
			assert.strictEqual(state().runtime.error, null);
		});

		test('UNSAFE_ARCHIVE: a tar entry with .. (its hash matching): refused; runtimeFailed; nothing outside', async () => {
			registry.serve(V1, platform, { ...fakeRuntime(V1, platform), binary: tarball([{ name: 'package/../../escaped', content: 'x' }]) });
			await runtime().setForTest({ manifest: registry.manifest(V1, [platform]) });
			assert.strictEqual(await install(), 'failed');
			assert.ok(state().runtime.error?.includes('the archive is unsafe'), JSON.stringify(state().runtime));
			assert.strictEqual(state().access, 'runtimeFailed');
			assert.deepStrictEqual(tree(), []);
			assert.ok(!fs.existsSync(path.join(root, 'escaped')) && !fs.existsSync(path.join(path.dirname(root), 'escaped')));
		});

		test('NEW_PIN: an older version installed: runtimeOutdated with Update; Update asks for the new version, installs it, then removes the old', async () => {
			assert.strictEqual(await install(), 'installed');
			registry.serve(V2, platform);
			await runtime().setForTest({ manifest: registry.manifest(V2, [platform]) });
			const s = state();
			assert.strictEqual(s.access, 'runtimeOutdated');
			assert.deepStrictEqual(s.runtime, { pinned: V2, installed: V1, error: null });
			assert.strictEqual(await view().run(REQUEST), 'runtimeOutdated', 'nothing starts on the old version');
			agreeWith = [AGREE_AND_INSTALL];
			await view().receive({ type: 'updateRuntimeRequested' });
			assert.strictEqual(asked.length, 2, 'the new version asks again');
			assert.ok(asked[1].message.includes(V2));
			assert.deepStrictEqual(fs.readdirSync(rtRoot), [V2], 'the old one removed');
			assert.strictEqual(state().access, 'ready');
			assert.strictEqual(await vscode.commands.executeCommand(UPDATE_RUNTIME_COMMAND), 'current');
		});

		test('REMOVE: the folder is deleted; runtimeMissing', async () => {
			assert.strictEqual(await install(), 'installed');
			assert.strictEqual(state().access, 'ready');
			assert.strictEqual(await vscode.commands.executeCommand(REMOVE_RUNTIME_COMMAND), 'removed');
			assert.ok(!fs.existsSync(rtRoot));
			assert.strictEqual(state().access, 'runtimeMissing');
			assert.strictEqual(await vscode.commands.executeCommand(REMOVE_RUNTIME_COMMAND), 'none');
		});

		test('FOREIGN_COPY: an SDK in an ancestor node_modules and on NODE_PATH, no runtime: still runtimeMissing, never loaded', async () => {
			const foreign = path.join(root, 'node_modules');
			fs.mkdirSync(path.join(foreign, '@anthropic-ai'), { recursive: true });
			fs.cpSync(path.join(REPO_ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), path.join(foreign, '@anthropic-ai', 'claude-agent-sdk'), { recursive: true });
			const before = process.env.NODE_PATH;
			process.env.NODE_PATH = foreign;
			const hosts = new FakeAssistantHosts(happyScript());
			assistant().setHostFactory(hosts.factory);
			try {
				await runtime().setForTest({ manifest: registry.manifest(V1, [platform]) });
				assert.strictEqual(state().access, 'runtimeMissing');
				assert.strictEqual(await view().run(REQUEST), 'runtimeMissing');
				assert.strictEqual(hosts.made.length, 0);
			} finally {
				if (before === undefined) {
					delete process.env.NODE_PATH;
				} else {
					process.env.NODE_PATH = before;
				}
				fs.rmSync(foreign, { recursive: true, force: true });
			}
		});

		test('NO_BINARY_FOR_PLATFORM: no package for the platform: unavailable "isn\'t available for <platform> yet"; no install, nothing starts', async () => {
			await runtime().setForTest({ platform: 'aix-ppc64' });
			const s = state();
			assert.strictEqual(s.access, 'unavailable');
			assert.strictEqual(s.platform, 'aix-ppc64');
			assert.strictEqual(unavailableText('aix-ppc64'), 'The RPCN AI Assistant isn\'t available for aix-ppc64 yet: Anthropic publishes no Claude Code binary package for it.');
			assert.strictEqual(await install(), 'unavailable');
			assert.strictEqual(asked.length, 0);
			assert.strictEqual(await view().run(REQUEST), 'unavailable');
		});

		test('REAL_HOST: the real SDK host imports the installed sdk.mjs (the fake SDK\'s own error); the SDK\'s binary-not-found: runtimeMissing, no error line', async () => {
			assert.strictEqual(await install(), 'installed');
			assistant().setHostFactory(undefined);
			assert.strictEqual(await view().run(REQUEST), 'error');
			assert.ok(state().error?.includes('fake SDK'), `the installed sdk.mjs ran: ${state().error}`);
			// Another version whose SDK throws the SDK's own "binary not found".
			const missing = 'export const query = () => { throw new Error("Native CLI binary for linux-x64 not found. Reinstall @anthropic-ai/claude-agent-sdk."); };\nexport const createSdkMcpServer = () => ({});\n';
			registry.serve(V2, platform, { ...fakeRuntime(V2, platform), sdk: tarball([
				{ name: 'package/package.json', content: JSON.stringify({ name: SDK, version: V2, type: 'module' }) },
				{ name: 'package/sdk.mjs', content: missing },
			]) });
			await runtime().setForTest({ manifest: registry.manifest(V2, [platform]) });
			agreeWith = [AGREE_AND_INSTALL];
			assert.strictEqual(await install(), 'installed');
			assert.strictEqual(state().access, 'ready');
			const turnsBefore = state().turns.map((t) => t.id);
			assert.strictEqual(await view().run(REQUEST), 'runtimeMissing');
			assert.strictEqual(state().error, null, 'no error line');
			assert.deepStrictEqual(state().turns.map((t) => t.id), turnsBefore, 'the run left no turn');
			assert.strictEqual(state().access, 'runtimeMissing');
		});

		test('BUSY: Install, Update and Remove while a run goes: busy, the runtime kept, the reason shown', async () => {
			assert.strictEqual(await install(), 'installed');
			assistant().setHostFactory(new FakeAssistantHosts(happyScript()).factory);
			const { done } = await startRun();
			assert.ok(await waitFor(() => state().status === 'question', 10_000));
			shown.length = 0;
			assert.strictEqual(await vscode.commands.executeCommand(REMOVE_RUNTIME_COMMAND), 'busy');
			assert.strictEqual(await vscode.commands.executeCommand(UPDATE_RUNTIME_COMMAND), 'busy');
			assert.strictEqual(await install(), 'busy');
			assert.ok(fs.existsSync(binaryOf(V1)), 'the runtime is still there');
			assert.deepStrictEqual(shown, [RUNTIME_BUSY_TEXT, RUNTIME_BUSY_TEXT, RUNTIME_BUSY_TEXT]);
			await answerPicks();
			assert.strictEqual(await done, 'done');
		});

		test('BINARY_VANISHES: the runtime passes the view\'s check, then the host cannot load it: runtimeMissing; request cleared; no "run started" line, no error line', async () => {
			assert.strictEqual(await install(), 'installed');
			assert.strictEqual(state().access, 'ready');
			const lines = api().outputLines().length;
			// The real SDK host, with the binary removed between the view's check and the host's start.
			assistant().setHostFactory((config) => {
				fs.rmSync(config.runtime.binary);
				return agentSdkHost(config);
			});
			assert.strictEqual(await view().run(REQUEST), 'runtimeMissing');
			let s = state();
			assert.strictEqual(s.access, 'runtimeMissing');
			assert.strictEqual(s.status, 'idle');
			assert.deepStrictEqual(s.turns, [], 'the request cleared: no turn');
			assert.strictEqual(s.error, null, 'no error line');
			const added = api().outputLines().slice(lines);
			assert.ok(!added.some((l) => l.includes('a design run started')), added.join('\n'));
			assert.ok(!added.some((l) => l.includes('the run failed')), added.join('\n'));
			// Installed again from the view: ready at once, without the view being shown again.
			assistant().setHostFactory(new FakeAssistantHosts(happyScript()).factory);
			await view().receive({ type: 'installRuntimeRequested' });
			assert.strictEqual(state().access, 'ready', JSON.stringify(state()));
			// A host that reports the runtime gone while its files are there: the same, until the next lookup.
			assistant().setHostFactory(new FakeAssistantHosts([{ emit: { type: 'error', message: 'gone', runtimeMissing: true } }]).factory);
			assert.strictEqual(await view().run(REQUEST), 'runtimeMissing');
			s = state();
			assert.strictEqual(s.access, 'runtimeMissing');
			assert.strictEqual(s.error, null);
			assert.deepStrictEqual(s.turns, []);
			assistant().setHostFactory(new FakeAssistantHosts(happyScript()).factory);
			const { done } = await startRun();
			assert.ok(await waitFor(() => state().status === 'question', 10_000), 'the next run looks the runtime up again');
			await answerPicks();
			assert.strictEqual(await done, 'done');
		});
	});

	suite('through the Agent SDK and the fake Messages API', () => {
		let fakeApi: FakeMessagesApi;
		let script: string;

		suiteSetup(async () => {
			fakeApi = new FakeMessagesApi();
			await fakeApi.start();
			script = path.join(bundledSkillsDir(vscode.extensions.getExtension(EXTENSION_ID)!.extensionUri), 'skills', 'rpcn-design', 'scripts', 'rpcn_check.py');
			assistant().setHostFactory(undefined);
			await assistant().setAccessForTest({ key: KEY, baseUrl: fakeApi.url, auth: 'bearer', model: 'claude-opus-5-5' });
		});
		suiteTeardown(async () => {
			await fakeApi?.stop();
		});
		setup(() => {
			fakeApi.reset();
			fakeApi.failure = undefined;
			fakeApi.delayMs = 0;
			assistant().setHostFactory(undefined);
		});

		const turns = (): FakeTurn[] => [
			{ tool: 'Skill', input: { skill: 'rpcn-skills:rpcn-design' } },
			{ tool: 'Bash', input: { command: `uv run ${script} binary`, description: 'Check the binary' } },
			{ tool: 'AskUserQuestion', input: { questions: RUN_2_QUESTIONS.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) })) } },
			{ tool: 'Write', input: { file_path: path.join(ws, 'orders_to_api.design.md'), content: readyNote('orders_to_api') } },
		];

		test('HAPPY_MODEL and NO_LEAK: the skill, its check, 2 question cards (pick first) answered, the note ready; the key nowhere', async () => {
			fakeApi.turns = turns();
			const { done } = await startRun();
			assert.ok(await waitFor(() => state().status === 'question' || !view().running, 90_000), JSON.stringify(state()));
			const s = state();
			assert.strictEqual(s.status, 'question', JSON.stringify(s));
			assert.ok(labels().includes('Running the rpcn-design skill'), JSON.stringify(labels()));
			assert.ok(labels().includes('Checking with rpcn_check binary'), JSON.stringify(labels()));
			// Story 8.12: the check's step row ended ok (its tool_result matched by id); the question's still runs.
			assert.strictEqual(turn().steps.find((x) => x.label === 'Checking with rpcn_check binary')?.mark, 'ok', JSON.stringify(turn().steps));
			assert.deepStrictEqual(s.questions?.questions.map((q) => q.options[0].label), ['No ordering (My pick)', 'No dedupe (My pick)']);
			await answerPicks();
			assert.strictEqual(await done, 'done', JSON.stringify(state()));
			assert.deepStrictEqual(turn().note, { file: 'orders_to_api.design.md', status: 'ready' });
			assert.ok(fs.existsSync(path.join(ws, 'orders_to_api.design.md')));
			// Story 8.12: the PreToolUse hook snapshotted the note (it did not exist): a new file's row, Keep and Undo.
			assert.deepStrictEqual(turn().files.map((f) => [f.path, f.created, f.removed]), [['orders_to_api.design.md', true, 0]]);
			assert.ok(turn().files[0].added > 0);
			assert.strictEqual(turn().review, 'pending');
			assert.ok(turn().steps.every((x) => x.mark !== 'running'), JSON.stringify(turn().steps));
			assert.deepStrictEqual(approvals, [], 'the check and the note did not ask');
			const asked = fakeApi.results.get(toolUseId(2));
			assert.ok(asked && !asked.isError && asked.text.includes('No ordering (My pick)') && asked.text.includes('No dedupe (My pick)'), JSON.stringify(asked));
			const check = fakeApi.results.get(toolUseId(1));
			// Review 22: the check ran and printed rpcn_check's successful envelope (the fake binary is 4.112.0).
			assert.ok(check && !check.isError && /\\?"command\\?":\s*\\?"binary\\?"/.test(check.text) && /\\?"ok\\?":\s*true/.test(check.text),
				`the rpcn_check call ran: ${JSON.stringify(check)}`);
			// Every model call carried the key as a bearer token and named the chosen model.
			assert.ok(fakeApi.requests.length > 0);
			const messages = fakeApi.requests.filter((r) => r.path === '/v1/messages');
			assert.ok(messages.every((r) => r.headers.authorization === `Bearer ${KEY}` && r.headers['x-api-key'] === undefined), 'bearer only');
			assert.ok(messages.every((r) => r.model === 'claude-opus-5-5'), JSON.stringify(messages.map((r) => r.model)));
			assert.ok(fakeApi.mainCalls[0].body.includes('rpcn-design'), 'the model sees the rpcn skills');

			assertNoLeak();
			const config = vscode.workspace.getConfiguration('redpandaConnect.assistant');
			assert.ok(![config.get('model'), config.get('baseUrl'), config.get('auth')].some((v) => String(v).includes(KEY)));
			assert.ok(!fs.readdirSync(ws, { recursive: true }).some((f) => fs.statSync(path.join(ws, String(f))).isFile() && fs.readFileSync(path.join(ws, String(f)), 'utf8').includes(KEY)),
				'nor in the workspace');
			assert.ok(!JSON.stringify(view().posted).includes(os.homedir() + path.sep), 'no home path posted');
			// The agent's own files (Claude Code's config, uv, XDG) are under the extension's global storage, and hold no
			// home path. uv's cache is left out: it records the Python interpreter it found, wherever the machine has it.
			const agentDir = path.join(REPO_ROOT, '.vscode-test', 'user-data', 'User', 'globalStorage', EXTENSION_ID, 'assistant');
			assert.ok(fs.existsSync(path.join(agentDir, 'claude-config')), 'CLAUDE_CONFIG_DIR is under global storage');
			const holding = fs.readdirSync(agentDir, { recursive: true }).map(String)
				.filter((f) => !f.startsWith('uv-cache') && fs.statSync(path.join(agentDir, f)).isFile())
				.filter((f) => fs.readFileSync(path.join(agentDir, f), 'utf8').includes(os.homedir() + path.sep));
			assert.deepStrictEqual(holding, [], 'no home path in the agent\'s files');
		});

		test('a write the boundaries do not allow asks; denied, the run goes on; a write outside the workspace is denied without asking', async () => {
			const outside = path.join(root, 'outside.txt');
			fakeApi.turns = [
				{ tool: 'Write', input: { file_path: path.join(ws, 'orders.yaml'), content: 'input: {}\n' } },
				{ tool: 'Write', input: { file_path: outside, content: 'x' } },
				{ tool: 'Bash', input: { command: `uv run ${script} binary; echo chained` } },
			];
			assert.strictEqual(await view().run(REQUEST), 'done', JSON.stringify(state()));
			assert.strictEqual(approvals.length, 2, JSON.stringify(approvals));
			assert.ok(approvals[0].startsWith('write ') && approvals[0].endsWith('orders.yaml'), approvals[0]);
			assert.ok(approvals[1].includes('echo chained'), approvals[1]);
			assert.ok(!fs.existsSync(path.join(ws, 'orders.yaml')) && !fs.existsSync(outside));
			assert.ok(fakeApi.results.get(toolUseId(0))?.isError && fakeApi.results.get(toolUseId(1))?.isError && fakeApi.results.get(toolUseId(2))?.isError);
			// Story 8.12: NO_CHANGE (a denied write: snapshotted, never written: no row, no Keep or Undo) and STEP_FAIL (✗).
			assert.deepStrictEqual(turn().files, []);
			assert.strictEqual(turn().review, 'none');
			const writes = turn().steps.filter((x) => x.mark !== 'info');
			assert.strictEqual(writes.length, 3, JSON.stringify(turn().steps));
			assert.ok(writes.every((x) => x.mark === 'failed' && x.result !== ''), JSON.stringify(writes));
			// Manual check 2: the approvals folded into their steps (no "Asks to" or "Denied" rows); the denied ones say so.
			assert.ok(!turn().steps.some((x) => x.label.startsWith('Asks to') || x.label === 'Denied' || x.label === 'Allowed'), JSON.stringify(turn().steps));
			assert.deepStrictEqual(writes.map((x) => x.result), ['denied', writes[1].result, 'denied'], JSON.stringify(writes));
			assert.ok(writes[1].result.startsWith('PreToolUse:Write hook error'), writes[1].result);
		});

		test('AGENT_ERROR (fake model): a 401 shows a masked error line; the run ends; a new request works', async () => {
			fakeApi.failure = { status: ADP_401.status, body: { ...ADP_401.body, message: `invalid api key ${KEY}` } };
			assert.strictEqual(await view().run(REQUEST), 'error', JSON.stringify(state()));
			const s = state();
			assert.strictEqual(s.status, 'error');
			assert.ok(s.error && s.error.length > 0);
			assert.ok(!s.error.includes(KEY), s.error);
			assert.ok(!api().outputLines().some((l) => l.includes(KEY)));
			assert.ok(!view().running);
			fakeApi.failure = undefined;
			fakeApi.turns = [];
			assert.strictEqual(await view().run(REQUEST), 'done', JSON.stringify(state()));
			assert.strictEqual(state().error, null);
		});

		test('review 9: an approval allowed: the write happens, its result is no error, its step row ends ok', async () => {
			approveWith = async () => true;
			fakeApi.turns = [{ tool: 'Write', input: { file_path: path.join(ws, 'orders.yaml'), content: 'input: {}\n' } }];
			assert.strictEqual(await view().run(REQUEST), 'done', JSON.stringify(state()));
			assert.strictEqual(approvals.length, 1);
			assert.ok(fs.existsSync(path.join(ws, 'orders.yaml')));
			assert.strictEqual(fakeApi.results.get(toolUseId(0))?.isError, false);
			// Manual check 2: folded into the Write's own row (its summary "written" wins over "allowed").
			assert.ok(!labels().some((l) => l.startsWith('Asks to') || l === 'Allowed'), JSON.stringify(labels()));
			assert.deepStrictEqual(turn().steps.filter((x) => x.mark !== 'info').map((x) => [x.label, x.mark, x.result]), [['Writing orders.yaml', 'ok', 'written']]);
			assert.deepStrictEqual(turn().files.map((f) => [f.path, f.added, f.removed, f.created]), [['orders.yaml', 1, 0, true]]);
		});

		test('story 8.2: SKILLS_PATH (fake model): the local copy\'s rpcn_check.py runs without asking; the bundled one asks', async () => {
			const local = localSkills();
			const localScript = path.join(local, 'skills', 'rpcn-design', 'scripts', 'rpcn_check.py');
			await setSkillsPath(local);
			try {
				assert.ok(await waitFor(() => state().skills === 'local', 5_000));
				fakeApi.turns = [
					{ tool: 'Bash', input: { command: `uv run ${localScript} binary`, description: 'Check the binary' } },
					{ tool: 'Bash', input: { command: `uv run ${script} binary`, description: 'Check the binary' } },
				];
				assert.strictEqual(await view().run(REQUEST), 'done', JSON.stringify(state()));
				const check = fakeApi.results.get(toolUseId(0));
				assert.ok(check && !check.isError && /\\?"ok\\?":\s*true/.test(check.text), `the local check ran: ${JSON.stringify(check)}`);
				assert.strictEqual(approvals.length, 1, JSON.stringify(approvals));
				// The approval text is masked (the bundled copy may be under the home folder): matched on its tail.
				assert.ok(approvals[0].includes(path.join('assets', 'rpcn-skills', 'skills', 'rpcn-design', 'scripts', 'rpcn_check.py')), `the bundled copy's script asks: ${approvals[0]}`);
				assert.ok(fakeApi.results.get(toolUseId(1))?.isError, 'denied');
				assert.ok(fakeApi.mainCalls[0].body.includes('rpcn-design'), 'the model sees the rpcn skills');
			} finally {
				await setSkillsPath(undefined);
			}
		});

		test('review 10: x-api-key: the key as an x-api-key header, no authorization; nothing leaks', async () => {
			await assistant().setAccessForTest({ auth: 'x-api-key', key: KEY });
			try {
				fakeApi.turns = turns();
				const { done } = await startRun();
				assert.ok(await waitFor(() => state().status === 'question' || !view().running, 90_000), JSON.stringify(state()));
				await answerPicks();
				assert.strictEqual(await done, 'done', JSON.stringify(state()));
				const messages = fakeApi.requests.filter((r) => r.path === '/v1/messages');
				assert.ok(messages.length > 0);
				assert.ok(messages.every((r) => r.headers['x-api-key'] === KEY && r.headers.authorization === undefined), 'x-api-key only');
				assertNoLeak();
			} finally {
				await assistant().setAccessForTest({ auth: 'bearer' });
			}
		});

		test('review 8: no message from the agent for the idle timeout ends the run with an error line', async () => {
			view().idleTimeoutMs = 1500;
			try {
				fakeApi.turns = turns().slice(3);
				fakeApi.delayMs = 60_000;
				assert.strictEqual(await view().run(REQUEST), 'error', JSON.stringify(state()));
				assert.strictEqual(state().error, 'No answer from the assistant for 2 s: the run was stopped.');
				assert.ok(!fs.existsSync(path.join(ws, 'orders_to_api.design.md')));
			} finally {
				view().idleTimeoutMs = undefined;
			}
		});

		test('review 8: an open question does not count as idle', async () => {
			view().idleTimeoutMs = 1500;
			try {
				fakeApi.turns = turns().slice(2);
				const { done } = await startRun();
				assert.ok(await waitFor(() => state().status === 'question' || !view().running, 60_000), JSON.stringify(state()));
				await new Promise((r) => setTimeout(r, 2500));
				assert.strictEqual(state().status, 'question', 'still waiting on the user');
				await answerPicks();
				assert.strictEqual(await done, 'done', JSON.stringify(state()));
			} finally {
				view().idleTimeoutMs = undefined;
			}
		});

		test('STOP (fake model): Stop while the run waits on a model turn: aborted, shown stopped, nothing written', async () => {
			fakeApi.turns = turns().slice(3);
			fakeApi.delayMs = 60_000;
			const { done } = await startRun();
			assert.ok(await waitFor(() => fakeApi.mainCalls.length > 0, 60_000), 'a model turn was asked for');
			view().stop();
			assert.strictEqual(await done, 'stopped', JSON.stringify(state()));
			assert.strictEqual(state().status, 'stopped');
			assert.ok(!fs.existsSync(path.join(ws, 'orders_to_api.design.md')), 'nothing written');
		});

		test('STOP (fake model): Stop while the run waits on a question', async () => {
			fakeApi.turns = turns().slice(2);
			const { done } = await startRun();
			assert.ok(await waitFor(() => state().status === 'question' || !view().running, 60_000), JSON.stringify(state()));
			view().stop();
			assert.strictEqual(await done, 'stopped', JSON.stringify(state()));
			assert.strictEqual(state().questions, null);
			assert.ok(!fs.existsSync(path.join(ws, 'orders_to_api.design.md')), 'nothing written');
		});
	});

	test('the key is in the secret storage only, under its own name, with the base URL it was set up for', async () => {
		await assistant().setAccessForTest({ key: KEY });
		assert.ok(assistant().access.hasKey);
		assert.strictEqual(assistant().access.mask(`x ${KEY} y`), `x ${CREDENTIAL_MASK} y`);
		assert.strictEqual(await assistant().access.storedSecret(ASSISTANT_KEY_SECRET), KEY);
		assert.strictEqual(await assistant().access.storedSecret(ASSISTANT_KEY_URL_SECRET), 'https://api.anthropic.com');
		assert.deepStrictEqual(userFilesHolding(KEY), []);
	});
});
