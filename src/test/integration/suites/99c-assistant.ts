// The RPCN AI Assistant's tracer bullet (story 8.1, AD-26), end to end in the stable run, with no model
// call: the assistant view through its test seams (`receive`, as the webview posts; story 8.5: an
// approval card's decision posted as the webview's `approvalDecided`), against the scripted in-memory host (`helpers/fakeAssistantHost.ts`) and against the
// embedded Agent SDK talking to a local fake Messages API (`helpers/fakeMessagesApi.ts`). The stable run
// opens no folder: the seam holds a temporary folder as the workspace, and an `ok` binary state on a fake
// binary. The key goes through Set up assistant access… into the secret storage. Every row of the plan's
// matrix has a test (HAPPY_HOST, HAPPY_MODEL, NO_KEY, NO_BINARY, AGENT_ERROR, STOP, NO_LEAK). Story 8.12:
// every state test reads the chat's turns; the chat's own rows are in "the chat (story 8.12)". Story 8.3:
// outside "assistant access (story 8.3)" the set-up's test call is stubbed (it passes, no network); inside
// it, it goes to a local fake `/v1/models` (every row of 8.3's matrix).
import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	ASSISTANT_ACCESS_STORED_MESSAGE, ASSISTANT_KEY_SECRET, ASSISTANT_KEY_URL_SECRET, FORGET_ACCESS_COMMAND, NO_MODEL_LIST_TEXT, normalBaseUrl, OTHER_MODEL_LABEL, SET_UP_ASSISTANT_ACCESS_COMMAND,
	AssistantAccess as AssistantAccessClass, TEST_CONNECTION_COMMAND, TRY_AGAIN_LABEL, type AssistantAccess, type AssistantAccessUi,
} from '../../../adapters/vscode/assistantAccess';
import { ASSISTANT_VIEW_ID, BEFORE_SCHEME, bundledSkillsDir, RUN_ASSISTANT_COMMAND, type AssistantRunOutcome, type AssistantViewUi } from '../../../adapters/vscode/assistantView';
import { CREDENTIAL_MASK } from '../../../adapters/cloud/errors';
import type { BinaryState } from '../../../adapters/redpandaConnect/binary';
import {
	KEY_REFUSED_TEXT, RUNTIME_MISSING_TEXT, unavailableText, unreachableText, type AssistantApprovalDecision, type AssistantApprovalView, type AssistantStateMessage, type AssistantTurnView,
} from '../../../shared/assistantProtocol';
import { agentSdkHost } from '../../../adapters/assistant/agentSdkHost';
import { hostPlatform } from '../../../adapters/assistant/platform';
import {
	AGREE_AND_INSTALL, INSTALL_RUNTIME_COMMAND, READ_TERMS, REMOVE_RUNTIME_COMMAND, RUNTIME_BUSY_TEXT, RUNTIME_TERMS_URL, UPDATE_RUNTIME_COMMAND,
	type AssistantRuntimeUi, type RuntimeInstallOutcome,
} from '../../../adapters/vscode/assistantRuntime';
import { type ExtensionApi } from '../../../extension';
import { FakeAssistantHosts, happyScript, readyNote, reply, RUN_2_QUESTIONS, step, stepDone, type FakeAssistantStep } from '../../helpers/fakeAssistantHost';
import { makeTempDir, REPO_ROOT, VERSION_4_112_SCRIPT, writeFakeBinary } from '../../helpers/fakeBinary';
import { shellKey } from '../../../adapters/assistant/rules';
import { ADP_401, adp403Model, ANTHROPIC_401, FakeMessagesApi, toolUseId, type FakeModel, type FakeTurn } from '../../helpers/fakeMessagesApi';
import { FakeProxy, FakeRegistry, fakeRuntime, SDK, tarball, tarballPath } from '../../helpers/fakeRegistry';
import { EXTENSION_ID, userFilesHolding, waitFor, waitForAsync } from '../helpers';

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
	let originalEndpoint: AssistantAccess['endpoint'];
	/**
	 * Story 8.3: the suite's access UI: the base URL box keeps its prefilled value, the auth pick takes the
	 * current value (first), the key box gives KEY; confirms say yes; the progress runs the task.
	 */
	const accessUi: AssistantAccessUi = {
		input: async (o) => (o.password ? KEY : o.value),
		pick: async (items) => items[0],
		confirm: async () => true,
		progress: (_title, task) => task(),
		showInfo: async (m) => shown.push(m),
		showError: async (m) => {
			shown.push(m);
			return undefined;
		},
	};
	/** Story 8.3: the endpoint stub of the tests outside the access suite: every test call passes (no list), no network. */
	const passingEndpoint: AssistantAccess['endpoint'] = async () => ({ ok: true, models: null });
	/** Story 8.3: the assistant's user settings a set-up or the model pick writes, removed. */
	const resetSettings = async () => {
		const config = vscode.workspace.getConfiguration('redpandaConnect.assistant');
		for (const name of ['model', 'baseUrl', 'auth']) {
			if (config.inspect(name)?.globalValue !== undefined) {
				await config.update(name, undefined, vscode.ConfigurationTarget.Global);
			}
		}
	};
	const approvals: string[] = [];
	const shown: string[] = [];
	/** Story 8.12: Undo's questions, its answer, the info messages, the links opened outside. */
	const undoAsked: string[] = [];
	let undoWith = true;
	const infos: string[] = [];
	const externals: string[] = [];
	/** Manual check 3: what went to the clipboard seam. */
	const copied: string[] = [];
	/**
	 * Story 8.5: each approval card's decision (default: Deny), posted as the webview would
	 * (`approvalDecided`) once the card is in the current turn. `approvals` gets each card's summary,
	 * `cards` the whole card.
	 */
	let approveWith: (card: AssistantApprovalView) => AssistantApprovalDecision | Promise<AssistantApprovalDecision> = () => 'deny';
	const cards: AssistantApprovalView[] = [];
	const decided = new Set<string>();
	let approvalWatch: vscode.Disposable | undefined;

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
		originalEndpoint = assistant().access.endpoint;
		assistant().access.endpoint = passingEndpoint;
		await resetSettings();
		approvalWatch = view().onDidChange(() => {
			const t = view().state().turns.at(-1);
			for (const card of t?.approvals ?? []) {
				// Each run's host numbers its approvals from 1: a card is its turn's and its id.
				const key = `${t!.id}/${card.id}`;
				if (!decided.has(key)) {
					decided.add(key);
					approvals.push(card.summary);
					cards.push(card);
					void Promise.resolve(approveWith(card)).then((decision) => view().receive({ type: 'approvalDecided', id: card.id, decision }));
				}
			}
		});
		view().ui = {
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
		assistant().access.ui = accessUi;
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
		approvalWatch?.dispose();
		view().forgetSessionForTest();
		assistant().setHostFactory(undefined);
		await setSkillsPath(undefined);
		await assistant().setAccessForTest({ key: null, model: null, baseUrl: null, auth: null, binary: null, workspace: null, uv: null });
		view().idleTimeoutMs = undefined;
		view().ui = originalViewUi;
		assistant().access.ui = originalAccessUi;
		assistant().access.endpoint = originalEndpoint;
		await resetSettings();
		fs.rmSync(root, { recursive: true, force: true });
	});

	teardown(async () => {
		// A failed test may leave its run waiting: stopped, so the next one is not busy.
		view().stop();
		assert.ok(await waitFor(() => !view().running, 30_000), 'the run ended after Stop');
	});

	setup(async () => {
		approveWith = () => 'deny';
		approvals.length = 0;
		cards.length = 0;
		decided.clear();
		view().forgetSessionForTest();
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

		assistant().access.ui = { ...accessUi, input: async () => undefined };
		assert.strictEqual(await vscode.commands.executeCommand(SET_UP_ASSISTANT_ACCESS_COMMAND), 'cancelled');
		assert.ok(!assistant().access.hasKey, 'Escape stores nothing');
		assistant().access.ui = accessUi;
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
		// Story 8.3: a 401 is key refused (sticky: nothing starts until access is set up again).
		assert.strictEqual(s.access, 'keyRefused');
		assert.strictEqual(await view().run(REQUEST), 'keyRefused');
		await assistant().setAccessForTest({ key: KEY });
		assert.strictEqual(state().access, 'ready');
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
			// Story 8.3: the set-up wrote the base URL setting.
			await resetSettings();
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

	test('review 5, story 8.5 TWO_OPEN: two approvals open at once: two cards; approval until both are decided, each by its own card', async () => {
		const pending: ((decision: AssistantApprovalDecision) => void)[] = [];
		approveWith = () => new Promise((resolve) => pending.push(resolve));
		const hosts = new FakeAssistantHosts([
			{ emit: { type: 'approval', id: 'a1', tool: 'Bash', summary: 'run `ls`', sessionKey: 'ls' } },
			{ emit: { type: 'approval', id: 'a2', tool: 'WebFetch', summary: 'use WebFetch', sessionKey: null } },
			{ waitApproval: 'a1' },
			{ waitApproval: 'a2' },
		]);
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY });
		const { done } = await startRun();
		assert.ok(await waitFor(() => pending.length === 2, 10_000));
		assert.strictEqual(state().status, 'approval');
		assert.deepStrictEqual(turn().approvals, [
			{ id: 'a1', summary: 'run `ls`', detail: null, sessionKey: 'ls', stepId: 'a1', write: false },
			{ id: 'a2', summary: 'use WebFetch', detail: null, sessionKey: null, stepId: 'a2', write: false },
		]);
		pending[1]('once');
		assert.ok(await waitFor(() => hosts.last!.approvals.has('a2'), 5_000));
		assert.strictEqual(state().status, 'approval', 'a1 is still open');
		assert.deepStrictEqual(turn().approvals.map((a) => a.id), ['a1'], 'a2\'s card went');
		pending[0]('deny');
		assert.strictEqual(await done, 'done');
		assert.deepStrictEqual([...hosts.last!.approvals], [['a2', 'once'], ['a1', 'deny']]);
		assert.deepStrictEqual(turn().approvals, []);
	});

	test('story 8.5 SESSION (fake host): Allow for this session remembers the key: the next call with it has no card, its row says so; New conversation keeps it; nothing stores it', async () => {
		const KEY_PIPE = 'rpk connect list | python3';
		const script: FakeAssistantStep[] = [
			step('s1', 'Ran a shell command'),
			{ waitApproval: 'a1', sessionKey: KEY_PIPE, summary: 'run `rpk connect list | python3 -I -c …`', stepId: 's1', detail: 'rpk connect list --format jsonschema | python3 -I -c "…"' },
			stepDone('s1', true, '42'),
		];
		const hosts = new FakeAssistantHosts(script);
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY });
		approveWith = () => 'session';
		assert.strictEqual(await view().run(REQUEST), 'done');
		assert.deepStrictEqual(cards, [{
			id: 'a1', summary: 'run `rpk connect list | python3 -I -c …`', detail: 'rpk connect list --format jsonschema | python3 -I -c "…"', sessionKey: KEY_PIPE, stepId: 's1', write: false,
		}]);
		assert.deepStrictEqual(hosts.last!.approvals.get('a1'), 'session');
		// Manual check (8.3): the step records the outcome (the webview's words: "you allowed for this session").
		assert.deepStrictEqual(turn().steps.map((x) => [x.id, x.mark, x.approval]), [['s1', 'ok', 'session']]);
		assert.deepStrictEqual(view().sessionKeys(), [KEY_PIPE]);
		// SESSION_HIT, after New conversation: no card; the row says "allowed by this session's approval".
		await view().newConversation();
		assert.strictEqual(await view().run(REQUEST), 'done');
		assert.strictEqual(cards.length, 1, 'no second card');
		assert.ok(!hosts.last!.approvals.has('a1'), 'never asked');
		assert.ok(hosts.last!.events.some((e) => e.type === 'remembered' && e.sessionKey === KEY_PIPE));
		assert.deepStrictEqual(turn().steps.map((x) => [x.id, x.mark, x.approval]), [['s1', 'ok', 'remembered']]);
		// SESSION_MISS: another key asks. ONCE: Allow once remembers nothing.
		hosts.script = [{ waitApproval: 'a2', sessionKey: 'rpk cluster info', summary: 'run `rpk cluster info`' }, { waitApproval: 'a3', sessionKey: 'rpk cluster info', summary: 'run `rpk cluster info`' }];
		approveWith = () => 'once';
		assert.strictEqual(await view().run(REQUEST), 'done');
		assert.deepStrictEqual(cards.slice(1).map((c) => [c.id, c.sessionKey]), [['a2', 'rpk cluster info'], ['a3', 'rpk cluster info']], 'a card each time');
		assert.deepStrictEqual(view().sessionKeys(), [KEY_PIPE]);
		// RELOAD: the memory is in the view only: no setting or global storage file holds it.
		assert.deepStrictEqual(userFilesHolding(KEY_PIPE), []);
		view().forgetSessionForTest();
		assert.deepStrictEqual(view().sessionKeys(), []);
	});

	test('story 8.5: Allow for this session on one card settles the other open cards with the same key', async () => {
		approveWith = () => new Promise(() => undefined);
		const hosts = new FakeAssistantHosts([
			step('s1', 'Ran a shell command'),
			step('s2', 'Ran a shell command'),
			{ emit: { type: 'approval', id: 'a1', tool: 'Bash', summary: 'run `grep a x`', sessionKey: 'grep', stepId: 's1' } },
			{ emit: { type: 'approval', id: 'a2', tool: 'Bash', summary: 'run `grep b x`', sessionKey: 'grep', stepId: 's2' } },
			{ emit: { type: 'approval', id: 'a3', tool: 'Bash', summary: 'run `cat x`', sessionKey: 'cat' } },
			{ waitApproval: 'a1' },
			{ waitApproval: 'a2' },
			{ waitApproval: 'a3' },
			stepDone('s1', true, 'a'),
			stepDone('s2', true, 'b'),
		]);
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY });
		const { done } = await startRun();
		assert.ok(await waitFor(() => turn().approvals.length === 3, 10_000));
		await view().receive({ type: 'approvalDecided', id: 'a2', decision: 'session' });
		assert.deepStrictEqual(turn().approvals.map((a) => a.id), ['a3'], 'a1 went with a2; a3 (another key) stays');
		assert.deepStrictEqual([hosts.last!.approvals.get('a1'), hosts.last!.approvals.get('a2')], ['session', 'session']);
		await view().receive({ type: 'approvalDecided', id: 'a3', decision: 'deny' });
		assert.strictEqual(await done, 'done');
		assert.deepStrictEqual(turn().steps.filter((x) => x.id === 's1' || x.id === 's2').map((x) => x.approval), ['session', 'session']);
		assert.deepStrictEqual(view().sessionKeys(), ['grep']);
	});

	test('story 8.5 NO_KEY_CARD and WITHDRAWN: a call with no key has no session choice (session on it is once); a withdrawn approval\'s card goes; Stop removes an open card', async () => {
		approveWith = () => new Promise(() => undefined);
		const hosts = new FakeAssistantHosts([
			{ waitApproval: 'a0', sessionKey: null, summary: 'run `rm y`' },
			{ emit: { type: 'approval', id: 'a1', tool: 'Bash', summary: 'run `rm x`', sessionKey: null } },
			{ delayMs: 300 },
			{ emit: { type: 'withdrawn', id: 'a1' } },
			{ waitApproval: 'a2', sessionKey: 'grep', summary: 'run `grep x`' },
		]);
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY });
		const { done } = await startRun();
		assert.ok(await waitFor(() => turn().approvals.length === 1, 10_000));
		// A webview posting `session` for a card with no key: Allow once; nothing remembered.
		await view().receive({ type: 'approvalDecided', id: 'a0', decision: 'session' });
		assert.ok(await waitFor(() => hosts.last!.approvals.has('a0'), 5_000));
		assert.strictEqual(hosts.last!.approvals.get('a0'), 'once');
		assert.deepStrictEqual(view().sessionKeys(), []);
		assert.deepStrictEqual(turn().steps.find((x) => x.id === 'a0')?.approval, 'once');
		assert.ok(await waitFor(() => turn().approvals[0]?.id === 'a1', 5_000));
		assert.deepStrictEqual(turn().approvals[0], { id: 'a1', summary: 'run `rm x`', detail: null, sessionKey: null, stepId: 'a1', write: false });
		assert.ok(await waitFor(() => turn().approvals.map((a) => a.id).join() === 'a2', 5_000), JSON.stringify(turn().approvals));
		// A decision for the withdrawn one changes nothing.
		await view().receive({ type: 'approvalDecided', id: 'a1', decision: 'once' });
		assert.ok(!hosts.last!.approvals.has('a1'));
		await view().receive({ type: 'stopRequested' });
		assert.strictEqual(await done, 'stopped');
		assert.deepStrictEqual(turn().approvals, [], 'the card went');
		assert.strictEqual(state().status, 'stopped');
	});

	test('story 8.5 LEAK (host half): the key and the home folder in an approval\'s summary, detail and key are masked on the card', async () => {
		const home = os.homedir();
		approveWith = () => 'deny';
		const hosts = new FakeAssistantHosts([
			{ waitApproval: 'a1', sessionKey: 'cat', summary: `run \`cat ${home}/x\``, detail: `cat ${home}/x # Bearer ${KEY}` },
		]);
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY });
		assert.strictEqual(await view().run(REQUEST), 'done');
		assert.strictEqual(cards.length, 1);
		assert.strictEqual(cards[0].summary, 'run `cat ~/x`');
		assert.ok(cards[0].detail?.startsWith('cat ~/x # ') && !cards[0].detail.includes(KEY), String(cards[0].detail));
		assert.ok(!JSON.stringify(view().posted).includes(KEY));
		assert.ok(!JSON.stringify(view().posted).includes(home + path.sep));
	});

	test('manual check (8.3): a long command\'s full text (step and approval card): the key masked, new lines kept, capped with "… (cut)"', async () => {
		await assistant().setAccessForTest({ key: KEY });
		const full = `curl -H "x: ${KEY}" \\\n  https://example.invalid/${'p'.repeat(300)}`;
		const huge = `echo ${'z'.repeat(30_000)}`;
		assistant().setHostFactory(new FakeAssistantHosts([
			{ emit: { type: 'step', id: 'b1', label: 'Ran a shell command', detail: 'curl …', fullDetail: full } },
			{ emit: { type: 'step', id: 'b2', label: 'Ran a shell command', detail: 'echo …', fullDetail: huge } },
			{ waitApproval: 'a1', sessionKey: null, summary: 'run `curl`', detail: full, stepId: 'b1' },
		]).factory);
		const { done } = await startRun();
		assert.ok(await waitFor(() => cards.length === 1, 10_000), JSON.stringify(state()));
		const steps = turn().steps;
		const posted = steps.find((x) => x.id === 'b1')?.fullDetail ?? '';
		assert.ok(!posted.includes(KEY) && posted.includes(CREDENTIAL_MASK) && posted.includes('\n'), posted);
		assert.ok(!(cards[0].detail ?? '').includes(KEY) && (cards[0].detail ?? '').includes('\n'), cards[0].detail ?? '');
		const cut = steps.find((x) => x.id === 'b2')?.fullDetail ?? '';
		assert.ok(cut.length === 20_000 && cut.endsWith('… (cut)'), String(cut.length));
		assert.strictEqual(await done, 'done');
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

	test('manual check (8.3): a question round stays on its step: each question, the pick and the answer given (kept or not); a key typed into Other is masked', async () => {
		const hosts = new FakeAssistantHosts(happyScript());
		assistant().setHostFactory(hosts.factory);
		await assistant().setAccessForTest({ key: KEY });
		const { done } = await startRun();
		assert.ok(await waitFor(() => state().status === 'question', 10_000));
		const q = state().questions!;
		// The first card keeps the pick; the second is an Other text with the key in it.
		await view().receive({ type: 'answered', id: q.id, answers: [q.questions[0].options[0].label, `dedupe with ${KEY}`] });
		assert.strictEqual(await done, 'done');
		const row = turn().steps.find((x) => x.qa !== undefined);
		assert.ok(row, JSON.stringify(turn().steps));
		assert.deepStrictEqual(row.qa!.map((x) => [x.header, x.question, x.pick, x.kept]), [
			['Ordering', RUN_2_QUESTIONS[0].question, 'No ordering (My pick)', true],
			['Duplicates', RUN_2_QUESTIONS[1].question, 'No dedupe (My pick)', false],
		]);
		assert.strictEqual(row.qa![0].answer, 'No ordering (My pick)');
		assert.strictEqual(row.qa![1].answer, `dedupe with ${CREDENTIAL_MASK}`);
		assert.ok(!JSON.stringify(view().posted).includes(KEY), 'masked in every posted message');
		assert.strictEqual(hosts.last?.answers.get('q1')?.[RUN_2_QUESTIONS[1].question], `dedupe with ${KEY}`, 'the agent gets the answer as typed');
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
			let resolve: ((decision: AssistantApprovalDecision) => void) | undefined;
			approveWith = () => new Promise((r) => (resolve = r));
			const hosts = new FakeAssistantHosts([{ emit: { type: 'approval', id: 'a1', tool: 'Bash', summary: 'run `ls`', sessionKey: 'ls' } }, { waitApproval: 'a1' }]);
			assistant().setHostFactory(hosts.factory);
			await assistant().setAccessForTest({ key: KEY });
			const { done } = await startRun();
			assert.ok(await waitFor(() => resolve !== undefined, 10_000));
			assert.strictEqual(state().status, 'approval');
			assert.strictEqual(turn().outcome, 'running');
			// Manual check 2: an approval with no step of its own (the fake host sends none) is one row; its outcome its result.
			assert.deepStrictEqual(turn().steps.map((x) => [x.label, x.mark, x.result]), [['Asks to run `ls`', 'running', '']]);
			resolve!('deny');
			assert.strictEqual(await done, 'done');
			assert.deepStrictEqual(turn().steps.map((x) => [x.label, x.mark, x.result, x.approval]), [['Asks to run `ls`', 'failed', '', 'deny']]);
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

		test('manual check 4: a turn with a question reports its waiting time apart; steps their own; the log line says both', async () => {
			assistant().setHostFactory(new FakeAssistantHosts([
				step('s1', 'Checking with rpcn_check binary'),
				{ delayMs: 1100 },
				stepDone('s1'),
				{ emit: { type: 'question', id: 'q1', questions: [RUN_2_QUESTIONS[0]] } },
				{ waitAnswer: 'q1' },
				{ delayMs: 300 },
			]).factory);
			await assistant().setAccessForTest({ key: KEY });
			const { done } = await startRun();
			assert.ok(await waitFor(() => state().status === 'question', 10_000));
			assert.strictEqual(turn().outcome, 'running');
			await new Promise((r) => setTimeout(r, 1200));
			const mid = turn();
			assert.ok(mid.waitingMs >= 1000 && mid.elapsedMs >= mid.waitingMs + 1000, JSON.stringify([mid.elapsedMs, mid.waitingMs]));
			await answerPicks();
			assert.strictEqual(await done, 'done');
			const t = turn();
			assert.ok(t.waitingMs >= 1150, `waited ${t.waitingMs}`);
			assert.ok(t.elapsedMs >= t.waitingMs + 1300, JSON.stringify([t.elapsedMs, t.waitingMs]));
			const checked = t.steps.find((x) => x.id === 's1');
			assert.ok(checked?.durationMs !== undefined && checked.durationMs >= 1000, JSON.stringify(checked));
			// Ended: the times stay put.
			await new Promise((r) => setTimeout(r, 50));
			assert.deepStrictEqual([turn().elapsedMs, turn().waitingMs], [t.elapsedMs, t.waitingMs]);
			assert.ok(api().outputLines().some((l) => /^Assistant: the run ended after \d+s, \d+s waiting on you\.$/.test(l)), api().outputLines().filter((l) => l.includes('the run ended')).join('\n'));
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

		test('manual check (8.3): a turn of 250 steps with 30 shell commands keeps all 30 shell rows, in order; the rest counted', async () => {
			const steps: FakeAssistantStep[] = Array.from({ length: 250 }, (_, i): FakeAssistantStep => (i % 8 === 0 && i < 240
				? { emit: { type: 'step', id: `s${i}`, label: 'Ran a shell command', detail: `cmd ${i}` } }
				: step(`s${i}`, `Reading f${i}.yaml`)));
			await run(steps);
			const all = turn().steps;
			assert.ok(all.length <= 200, String(all.length));
			assert.deepStrictEqual(all.filter((x) => x.label === 'Ran a shell command').map((x) => x.detail), Array.from({ length: 30 }, (_, k) => `cmd ${k * 8}`));
			assert.match(all[0].label, /^\d+ earlier steps not shown$/);
			assert.strictEqual(Number(all[0].label.split(' ')[0]) + all.length - 1, 250 + all.filter((x) => !x.id.startsWith('s') && x.id !== 'dropped').length);
		});

		test('limits: at most 50 turns, the oldest dropped first; at most 200 steps a turn', async () => {
			const steps: FakeAssistantStep[] = Array.from({ length: 210 }, (_, i) => step(`s${i}`, `step ${i}`));
			await run(steps);
			assert.strictEqual(turn().steps.length, 200);
			// Manual check (8.3): the dropped rows are counted in a line of their own at the top.
			assert.strictEqual(turn().steps[0].label, '11 earlier steps not shown');
			assert.strictEqual(turn().steps[1].label, 'step 11');
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
			assert.ok(writes.every((x) => x.mark === 'failed' && (x.result !== '' || x.approval === 'deny')), JSON.stringify(writes));
			// Manual check 2: the approvals folded into their steps (no "Asks to" or "Denied" rows); the denied ones say so.
			assert.ok(!turn().steps.some((x) => x.label.startsWith('Asks to') || x.label === 'Denied' || x.label === 'Allowed'), JSON.stringify(turn().steps));
			assert.deepStrictEqual(writes.map((x) => x.approval), ['deny', undefined, 'deny'], JSON.stringify(writes));
			assert.ok(writes[0].approvalDetail?.endsWith('orders.yaml'), writes[0].approvalDetail);
			assert.ok(writes[1].result.startsWith('PreToolUse:Write hook error'), writes[1].result);
		});

		test('story 8.5 WS_CHECK, CHAINED, RUN_ASKS, REDIRECT, PIPE_KEY (fake model): each asks; only the read-only pipe offers its session key; denied, none runs', async () => {
			const rpk = writeFakeBinary(root, 'rpk', 'echo \'{"inputs":[]}\'');
			const commands = [
				'uv run evil/rpcn_check.py list',
				`uv run ${script} list; rm x`,
				'printf \'input: {}\' | timeout 60 rpk connect run /tmp/x.yaml',
				'rpk connect list > out.txt',
				`${rpk} connect list --format jsonschema 2>/dev/null | python3 -I -c "import sys; print(len(sys.stdin.read()))"`,
			];
			fakeApi.turns = commands.map((command) => ({ tool: 'Bash', input: { command } }));
			assert.strictEqual(await view().run(REQUEST), 'done', JSON.stringify(state()));
			assert.deepStrictEqual(cards.map((c) => c.sessionKey), [null, null, null, null, 'rpk connect list | python3'], JSON.stringify(cards));
			assert.deepStrictEqual(commands.map((c) => shellKey(c, ws)), [null, null, null, null, 'rpk connect list | python3'], 'the rules\' key, as the cards got it');
			commands.forEach((_, i) => assert.ok(fakeApi.results.get(toolUseId(i))?.isError, `denied: ${commands[i]}`));
			assert.ok(!fs.existsSync(path.join(ws, 'out.txt')));
			assert.ok(turn().steps.filter((x) => x.mark !== 'info').every((x) => x.mark === 'failed' && x.approval === 'deny'), JSON.stringify(turn().steps));
			assert.deepStrictEqual(view().sessionKeys(), []);
		});

		test('manual check (8.3) (fake model): an rpcn_check call not in its plain form asks with the key "rpcn_check <subcommand>"; after Allow for this session the next one runs with no card', async () => {
			approveWith = () => 'session';
			fakeApi.turns = [
				{ tool: 'Bash', input: { command: `uv run ${script} binary 2>&1 | head -200`, description: 'Check the binary' } },
				{ tool: 'Bash', input: { command: `uv run ${script} binary 2>/dev/null | head -100`, description: 'Check the binary again' } },
			];
			assert.strictEqual(await view().run(REQUEST), 'done', JSON.stringify(state()));
			assert.deepStrictEqual(cards.map((c) => c.sessionKey), ['rpcn_check binary'], JSON.stringify(cards));
			assert.deepStrictEqual(view().sessionKeys(), ['rpcn_check binary']);
			for (const i of [0, 1]) {
				const r = fakeApi.results.get(toolUseId(i));
				assert.ok(r && !r.isError && /\\?"ok\\?":\s*true/.test(r.text), `ran: ${JSON.stringify(r)}`);
			}
			const row = (i: number) => turn().steps.find((x) => x.id === toolUseId(i));
			assert.deepStrictEqual([row(0)?.approval, row(1)?.approval], ['session', 'remembered'], JSON.stringify(turn().steps));
		});

		test('story 8.5 PIPE_KEY, SESSION_HIT, SESSION_MISS, ONCE (fake model): Allow for this session, then the same key runs without a card; another key and Allow once ask again', async () => {
			const rpk = writeFakeBinary(root, 'rpk', 'echo \'{"inputs":[]}\'');
			const reads = 'import sys; print(len(sys.stdin.read()))';
			const commands = [
				`${rpk} connect list --format jsonschema 2>/dev/null | python3 -I -c "${reads}"`,
				`${rpk} connect list --format json caches | python3 -I -c "import sys; sys.stdin.read(); print('other')"`,
				`${rpk} cluster info`,
				'echo once',
				'echo once',
			];
			const decisions: AssistantApprovalDecision[] = ['session', 'deny', 'once', 'deny'];
			approveWith = () => decisions.shift() ?? 'deny';
			fakeApi.turns = commands.map((command) => ({ tool: 'Bash', input: { command } }));
			assert.strictEqual(await view().run(REQUEST), 'done', JSON.stringify(state()));
			assert.deepStrictEqual(cards.map((c) => c.sessionKey), ['rpk connect list | python3', 'rpk cluster info', 'echo', 'echo'], JSON.stringify([cards, turn().steps, [...fakeApi.results]]));
			// The card holds the whole command (masked), for Copy command.
			assert.ok(cards[0].detail?.endsWith(`| python3 -I -c "${reads}"`), String(cards[0].detail));
			assert.deepStrictEqual(view().sessionKeys(), ['rpk connect list | python3']);
			assert.deepStrictEqual([0, 1, 2, 3, 4].map((i) => fakeApi.results.get(toolUseId(i))?.isError), [false, false, true, false, true], JSON.stringify([...fakeApi.results]));
			assert.ok(fakeApi.results.get(toolUseId(1))?.text.includes('other'), 'the remembered call ran');
			const row = (i: number) => turn().steps.find((x) => x.id === toolUseId(i));
			assert.deepStrictEqual([0, 1, 2, 3, 4].map((i) => row(i)?.approval), ['session', 'remembered', 'deny', 'once', 'deny'], JSON.stringify(turn().steps));
			assert.ok(row(2)?.approvalDetail?.endsWith(' cluster info'), row(2)?.approvalDetail);
		});

		test('story 8.5 OWN_NOTE, OTHER_WRITE, OUTSIDE (fake model): the note written and edited with no card; Write for this session; a write outside still denied with no card', async () => {
			const note = path.join(ws, 'x.design.md');
			const outside = path.join(root, 'outside-session.txt');
			approveWith = () => 'session';
			fakeApi.turns = [
				{ tool: 'Write', input: { file_path: note, content: readyNote('x') } },
				{ tool: 'Edit', input: { file_path: note, old_string: 'A fake note.', new_string: 'An edited note.' } },
				{ tool: 'Write', input: { file_path: path.join(ws, 'a.yaml'), content: 'a: 1\n' } },
				{ tool: 'Write', input: { file_path: path.join(ws, 'b.yaml'), content: 'b: 1\n' } },
				{ tool: 'Write', input: { file_path: outside, content: 'x' } },
			];
			assert.strictEqual(await view().run(REQUEST), 'done', JSON.stringify(state()));
			assert.deepStrictEqual(cards.map((c) => c.sessionKey), ['Write'], JSON.stringify(cards));
			assert.ok(cards[0].summary.endsWith('a.yaml'), cards[0].summary);
			assert.ok(fs.readFileSync(note, 'utf8').includes('An edited note.'), 'the note edited without asking');
			assert.strictEqual(fs.readFileSync(path.join(ws, 'b.yaml'), 'utf8'), 'b: 1\n');
			assert.ok(!fs.existsSync(outside), 'outside: denied');
			assert.deepStrictEqual([0, 1, 2, 3, 4].map((i) => fakeApi.results.get(toolUseId(i))?.isError), [false, false, false, false, true], JSON.stringify([...fakeApi.results]));
			assert.strictEqual(turn().steps.find((x) => x.id === toolUseId(3))?.approval, 'remembered', JSON.stringify(turn().steps));
		});

		test('story 8.5 manual check 1 (fake model): a Read of a tool result spilled under the agent\'s own config folder runs with no card; a sibling outside it asks', async () => {
			const config = path.join(REPO_ROOT, '.vscode-test', 'user-data', 'User', 'globalStorage', EXTENSION_ID, 'assistant', 'claude-config');
			const spilled = path.join(config, 'projects', 'rpcn-test', 'session', 'tool-results', 'spilled.txt');
			const sibling = path.join(config, '..', 'spilled-sibling.txt');
			fs.mkdirSync(path.dirname(spilled), { recursive: true });
			fs.writeFileSync(spilled, 'spilled tool result\n');
			fs.writeFileSync(sibling, 'not a tool result\n');
			try {
				fakeApi.turns = [{ tool: 'Read', input: { file_path: spilled } }, { tool: 'Read', input: { file_path: sibling } }];
				assert.strictEqual(await view().run(REQUEST), 'done', JSON.stringify(state()));
				assert.strictEqual(cards.length, 1, JSON.stringify(cards));
				assert.ok(cards[0].summary.endsWith('spilled-sibling.txt'), cards[0].summary);
				const read = fakeApi.results.get(toolUseId(0));
				assert.ok(read && !read.isError && read.text.includes('spilled tool result'), JSON.stringify(read));
				assert.ok(fakeApi.results.get(toolUseId(1))?.isError, 'the sibling was denied');
			} finally {
				fs.rmSync(path.join(config, 'projects', 'rpcn-test'), { recursive: true, force: true });
				fs.rmSync(sibling, { force: true });
			}
		});

		test('story 8.5 HOME (fake model): a whole design run with HOME a temporary folder leaves nothing new in it', async () => {
			const home = fs.realpathSync(makeTempDir('rpcn-assistant-home-'));
			try {
				assistant().setHostFactory((config) => agentSdkHost({ ...config, baseEnv: { ...config.baseEnv, HOME: home } }));
				fakeApi.turns = turns();
				const { done } = await startRun();
				assert.ok(await waitFor(() => state().status === 'question' || !view().running, 90_000), JSON.stringify(state()));
				await answerPicks();
				assert.strictEqual(await done, 'done', JSON.stringify(state()));
				assert.ok(fs.existsSync(path.join(ws, 'orders_to_api.design.md')));
				assert.deepStrictEqual(fs.readdirSync(home, { recursive: true }), [], 'nothing under the home folder');
			} finally {
				fs.rmSync(home, { recursive: true, force: true });
			}
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
			// Story 8.3: RUN_401: the turn shows the masked error; access goes to keyRefused; set up again, it runs.
			assert.strictEqual(turn().outcome, 'error');
			assert.strictEqual(s.access, 'keyRefused', s.error);
			await assistant().setAccessForTest({ key: KEY });
			fakeApi.failure = undefined;
			fakeApi.turns = [];
			assert.strictEqual(await view().run(REQUEST), 'done', JSON.stringify(state()));
			assert.strictEqual(state().error, null);
		});

		test('review 9: an approval allowed: the write happens, its result is no error, its step row ends ok', async () => {
			approveWith = () => 'once';
			fakeApi.turns = [{ tool: 'Write', input: { file_path: path.join(ws, 'orders.yaml'), content: 'input: {}\n' } }];
			assert.strictEqual(await view().run(REQUEST), 'done', JSON.stringify(state()));
			assert.strictEqual(approvals.length, 1);
			assert.ok(fs.existsSync(path.join(ws, 'orders.yaml')));
			assert.strictEqual(fakeApi.results.get(toolUseId(0))?.isError, false);
			// Manual check 2, (8.3): folded into the Write's own row: its own result, and the outcome ("you allowed once · written").
			assert.ok(!labels().some((l) => l.startsWith('Asks to') || l === 'Allowed'), JSON.stringify(labels()));
			assert.deepStrictEqual(turn().steps.filter((x) => x.mark !== 'info').map((x) => [x.label, x.mark, x.result]), [['Writing orders.yaml', 'ok', 'written']]);
			assert.strictEqual(turn().steps.find((x) => x.label === 'Writing orders.yaml')?.approval, 'once');
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

	suite('assistant access (story 8.3)', () => {
		let fake: FakeMessagesApi;
		const THREE: FakeModel[] = [
			{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }, { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' }, { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' },
		];
		/** What the UI answers: the base URL, the auth pick's label, the key, the model picked (`null`: Other…), Other…'s name, the confirm, an error's button (once). */
		let answers: { url?: string; auth?: string; key?: string; model?: string | null; other?: string; confirm?: boolean; errorAction?: string } = {};
		const inputs: vscode.InputBoxOptions[] = [];
		const picks: { readonly title: string | undefined; readonly items: (vscode.QuickPickItem & { readonly model?: string | null })[] }[] = [];
		const errors: { readonly message: string; readonly actions: readonly string[] }[] = [];
		const notes: string[] = [];
		const config = () => vscode.workspace.getConfiguration('redpandaConnect.assistant');
		const secrets = async () => [await assistant().access.storedSecret(ASSISTANT_KEY_SECRET), await assistant().access.storedSecret(ASSISTANT_KEY_URL_SECRET)];
		const setUp = () => vscode.commands.executeCommand<string>(SET_UP_ASSISTANT_ACCESS_COMMAND);
		const lastPick = () => {
			const p = picks.at(-1);
			assert.ok(p, 'a pick opened');
			return p;
		};
		const closedPort = () => new Promise<number>((resolve) => {
			const server = net.createServer().listen(0, '127.0.0.1', () => {
				const port = (server.address() as net.AddressInfo).port;
				server.close(() => resolve(port));
			});
		});

		suiteSetup(async () => {
			fake = new FakeMessagesApi();
			await fake.start();
		});
		suiteTeardown(async () => {
			await fake?.stop();
			assistant().access.endpoint = passingEndpoint;
			assistant().access.endpointTimeoutMs = undefined;
			assistant().access.now = () => Date.now();
			assistant().access.ui = accessUi;
			await resetSettings();
			await assistant().setAccessForTest({ key: null, model: null, baseUrl: null, auth: null });
		});
		setup(async () => {
			fake.reset();
			fake.models = THREE;
			fake.modelsFailure = undefined;
			fake.failure = undefined;
			fake.hang = false;
			answers = { url: fake.url, auth: 'bearer', key: KEY };
			inputs.length = 0;
			picks.length = 0;
			errors.length = 0;
			notes.length = 0;
			assistant().access.endpoint = originalEndpoint;
			assistant().access.endpointTimeoutMs = undefined;
			assistant().access.now = () => Date.now();
			await resetSettings();
			await assistant().setAccessForTest({ key: null, model: null, baseUrl: null, auth: null });
			assistant().access.ui = {
				input: async (o) => {
					inputs.push(o);
					return o.password ? answers.key : o.title?.includes('base URL') ? answers.url : answers.other;
				},
				pick: async (items, o) => {
					picks.push({ title: o.title, items: items.map((i) => ({ ...i })) });
					return items.find((i) => ('model' in i ? (i as { model: string | null }).model === answers.model : i.label === answers.auth));
				},
				confirm: async () => answers.confirm === true,
				progress: (_title, task) => task(),
				showInfo: async (m) => notes.push(m),
				showError: async (m, ...actions) => {
					errors.push({ message: m, actions });
					const action = answers.errorAction;
					answers.errorAction = undefined;
					return action;
				},
			};
		});

		test('package.json: Test assistant connection and Forget assistant access; the model setting names the chip', () => {
			const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as {
				contributes: { commands: { command: string; title: string }[]; configuration: { properties: Record<string, { markdownDescription?: string }> } };
			};
			assert.deepStrictEqual([TEST_CONNECTION_COMMAND, FORGET_ACCESS_COMMAND].map((id) => pkg.contributes.commands.find((c) => c.command === id)?.title),
				['Test assistant connection', 'Forget assistant access']);
			assert.ok(pkg.contributes.configuration.properties['redpandaConnect.assistant.model'].markdownDescription?.includes('model chip'));
		});

		test('SETUP_OK, PICK: URL, x-api-key and key; the fake lists 3 models: settings written, key stored, info; the chip\'s pick lists them with cost marks; a pick is written', async () => {
			answers.auth = 'x-api-key';
			assert.strictEqual(await setUp(), 'stored');
			// The steps: the base URL prefilled, the auth with the current value first, the key in a password box.
			assert.deepStrictEqual(inputs.map((o) => [o.value, o.password === true]), [['https://api.anthropic.com', false], [undefined, true]]);
			assert.deepStrictEqual(picks[0].items.map((i) => i.label), ['bearer', 'x-api-key']);
			assert.strictEqual(config().inspect('baseUrl')?.globalValue, fake.url);
			assert.strictEqual(config().inspect('auth')?.globalValue, 'x-api-key');
			assert.deepStrictEqual(await secrets(), [KEY, normalBaseUrl(fake.url)]);
			assert.deepStrictEqual(notes, [ASSISTANT_ACCESS_STORED_MESSAGE]);
			// The test call: one GET /v1/models with the key as x-api-key and anthropic-version; nothing that costs tokens.
			assert.deepStrictEqual(fake.requests.map((r) => [r.method, r.path]), [['GET', '/v1/models']]);
			assert.strictEqual(fake.requests[0].headers['x-api-key'], KEY);
			assert.ok(fake.requests[0].headers['anthropic-version']);
			assert.ok(await waitFor(() => state().access === 'ready', 5_000), state().access);
			assert.strictEqual(state().model, 'claude-opus-5-5');
			// The chip: the cached list (no new call), the current model checked, Other… last.
			fake.reset();
			answers.model = 'claude-sonnet-4-6';
			await view().receive({ type: 'chooseModelRequested' });
			assert.deepStrictEqual(lastPick().items.map((i) => [i.label, i.description]), [
				['$(check) claude-opus-5-5', '$$$  Claude Opus 5.5'], ['claude-sonnet-4-6', '$$  Claude Sonnet 4.6'], ['claude-haiku-5-5', '$  Claude Haiku 5.5'],
				[OTHER_MODEL_LABEL, 'any model name'],
			]);
			assert.strictEqual(fake.requests.length, 0, 'the list was cached');
			assert.strictEqual(config().inspect('model')?.globalValue, 'claude-sonnet-4-6');
			assert.ok(await waitFor(() => state().model === 'claude-sonnet-4-6' && view().posted.at(-1)?.model === 'claude-sonnet-4-6', 5_000), state().model);
			// Over 10 minutes old: fetched again when the pick opens.
			assistant().access.now = () => Date.now() + 11 * 60_000;
			answers.model = undefined;
			await view().receive({ type: 'chooseModelRequested' });
			assert.deepStrictEqual(fake.requests.map((r) => [r.method, r.path]), [['GET', '/v1/models']]);
			assert.strictEqual(lastPick().items[1].label, '$(check) claude-sonnet-4-6');
			assert.strictEqual(config().inspect('model')?.globalValue, 'claude-sonnet-4-6', 'Escape changes nothing');
		});

		test('COST_MARKS: opus, sonnet, fable, haiku and my-alias: $$$, $$, $$, $ and none', async () => {
			fake.models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-haiku-5-5', 'my-alias'].map((id) => ({ id }));
			assert.strictEqual(await setUp(), 'stored');
			assert.strictEqual(await assistant().access.chooseModel(), undefined);
			assert.deepStrictEqual(lastPick().items.map((i) => i.description), ['$$$', '$$', '$$', '$', '', 'any model name']);
		});

		test('SETUP_401, SETUP_ADP_401: nothing stored; "The endpoint refused the key." with Try again, which asks again', async () => {
			for (const failure of [ANTHROPIC_401, ADP_401]) {
				errors.length = 0;
				fake.modelsFailure = failure;
				assert.strictEqual(await setUp(), 'failed');
				assert.deepStrictEqual(await secrets(), [undefined, undefined]);
				assert.strictEqual(config().inspect('baseUrl')?.globalValue, undefined, 'no setting written');
				assert.ok(errors[0].message.startsWith(KEY_REFUSED_TEXT), errors[0].message);
				assert.deepStrictEqual(errors[0].actions, [TRY_AGAIN_LABEL]);
				assert.strictEqual(state().access, 'noAccess');
			}
			// Try again: the set-up runs again (the key is right now: stored).
			inputs.length = 0;
			answers.errorAction = TRY_AGAIN_LABEL;
			assert.strictEqual(await setUp(), 'failed');
			fake.modelsFailure = undefined;
			// The fresh set-up ends with its info message (then its guard is released).
			assert.ok(await waitFor(() => assistant().access.hasKey && notes.includes(ASSISTANT_ACCESS_STORED_MESSAGE), 5_000), 'Try again set access up');
			await new Promise((r) => setTimeout(r, 50));
			assert.strictEqual(inputs.length, 4, 'every step asked twice');
		});

		test('the guard: a failed set-up\'s notification left unanswered does not block another set-up', async () => {
			fake.modelsFailure = ANTHROPIC_401;
			const unanswered: string[] = [];
			assistant().access.ui = { ...assistant().access.ui, showError: (m) => {
				unanswered.push(m);
				return new Promise<undefined>(() => undefined);
			} };
			assert.strictEqual(await setUp(), 'failed');
			assert.strictEqual(unanswered.length, 1);
			fake.modelsFailure = undefined;
			assert.strictEqual(await setUp(), 'stored', 'not busy');
		});

		test('SETUP_ESC: Escape at the auth step (or the URL or the key): no setting changed, nothing stored, nothing sent', async () => {
			// A new base URL typed, then Escape at the auth step: not written, nothing stored, nothing sent.
			answers.url = `${fake.url}/other`;
			answers.auth = undefined;
			assert.strictEqual(await setUp(), 'cancelled');
			assert.strictEqual(inputs.length, 1, 'no key asked');
			assert.strictEqual(config().inspect('baseUrl')?.globalValue, undefined, 'the typed base URL was not written');
			assert.strictEqual(assistant().access.settings().baseUrl, 'https://api.anthropic.com');
			assert.deepStrictEqual(await secrets(), [undefined, undefined]);
			answers = { url: undefined };
			assert.strictEqual(await setUp(), 'cancelled');
			answers = { url: fake.url, auth: 'x-api-key', key: undefined };
			assert.strictEqual(await setUp(), 'cancelled');
			assert.deepStrictEqual(await secrets(), [undefined, undefined]);
			assert.deepStrictEqual(['baseUrl', 'auth', 'model'].map((n) => config().inspect(n)?.globalValue), [undefined, undefined, undefined]);
			assert.strictEqual(fake.requests.length, 0);
		});

		test('SETUP_NO_LIST: /v1/models gives 404: stored, "reachable, no model list"; the pick has the current model and Other… only', async () => {
			fake.modelsFailure = { status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'Not found' } } };
			assert.strictEqual(await setUp(), 'stored');
			assert.deepStrictEqual(await secrets(), [KEY, normalBaseUrl(fake.url)]);
			assert.ok(notes[0].includes(NO_MODEL_LIST_TEXT), notes[0]);
			await view().receive({ type: 'chooseModelRequested' });
			assert.deepStrictEqual(lastPick().items.map((i) => i.label), ['$(check) claude-opus-5-5', OTHER_MODEL_LABEL]);
		});

		test('UNREACHABLE: a closed port: nothing stored; "Could not reach `<host>`."', async () => {
			const port = await closedPort();
			answers.url = `http://127.0.0.1:${port}`;
			assert.strictEqual(await setUp(), 'failed');
			assert.deepStrictEqual(await secrets(), [undefined, undefined]);
			assert.ok(errors[0].message.startsWith(unreachableText(`127.0.0.1:${port}`)), errors[0].message);
			assert.strictEqual(config().inspect('baseUrl')?.globalValue, undefined);
		});

		test('TIMEOUT: the fake hangs past the (shortened) limit: unreachable', async () => {
			fake.hang = true;
			assistant().access.endpointTimeoutMs = 500;
			assert.strictEqual(await setUp(), 'failed');
			assert.ok(errors[0].message.startsWith(unreachableText(new URL(fake.url).host)) && /timed out/i.test(errors[0].message), errors[0].message);
			assert.deepStrictEqual(await secrets(), [undefined, undefined]);
		});

		test('TEST_CONN: with the stored key: a 401 sets keyRefused (sticky); a 403 is key refused with its message; a 200 clears it with an info message', async () => {
			assert.strictEqual(await setUp(), 'stored');
			fake.reset();
			fake.modelsFailure = ANTHROPIC_401;
			assert.strictEqual(await vscode.commands.executeCommand(TEST_CONNECTION_COMMAND), 'keyRefused');
			assert.strictEqual(fake.requests[0].headers.authorization, `Bearer ${KEY}`);
			assert.strictEqual(state().access, 'keyRefused');
			assert.strictEqual(await view().run(REQUEST), 'keyRefused', 'nothing starts');
			fake.modelsFailure = { status: 403, body: { type: 'error', error: { type: 'permission_error', message: 'This key cannot use the workspace' } } };
			assert.strictEqual(await assistant().access.testConnection(), 'forbidden');
			assert.deepStrictEqual([state().access, state().accessMessage], ['keyRefused', 'This key cannot use the workspace']);
			fake.modelsFailure = undefined;
			notes.length = 0;
			// The panel's Test connection posts testConnectionRequested, which runs the command.
			await view().receive({ type: 'testConnectionRequested' });
			assert.ok(await waitFor(() => state().access === 'ready', 5_000), state().access);
			assert.ok(notes.some((n) => n.includes('answered with 3 models')), JSON.stringify(notes));
			assert.strictEqual(state().accessMessage, null);
		});

		test('FORGET: Cancel keeps both secrets; confirmed: both gone, the list too; the view shows No access', async () => {
			assert.strictEqual(await setUp(), 'stored');
			answers.confirm = false;
			assert.strictEqual(await vscode.commands.executeCommand(FORGET_ACCESS_COMMAND), 'cancelled');
			assert.deepStrictEqual(await secrets(), [KEY, normalBaseUrl(fake.url)]);
			answers.confirm = true;
			assert.strictEqual(await vscode.commands.executeCommand(FORGET_ACCESS_COMMAND), 'forgotten');
			assert.deepStrictEqual(await secrets(), [undefined, undefined]);
			assert.strictEqual(assistant().access.cachedModels(), undefined);
			assert.ok(await waitFor(() => state().access === 'noAccess', 5_000), state().access);
			assert.strictEqual(view().posted.at(-1)?.access, 'noAccess');
		});

		test('RUN_401 (fake host): a run failing "Not logged in · Please run /login": the turn shows the masked error; access goes to keyRefused', async () => {
			await assistant().setAccessForTest({ key: KEY });
			assistant().setHostFactory(new FakeAssistantHosts([{ emit: { type: 'error', message: `Not logged in · Please run /login ${KEY}` } }]).factory);
			assert.strictEqual(await view().run(REQUEST), 'error');
			assert.strictEqual(turn().outcome, 'error');
			assert.ok(state().error?.startsWith('Not logged in') && !state().error?.includes(KEY), state().error ?? '');
			assert.strictEqual(state().access, 'keyRefused');
		});

		test('RUN_403_MODEL, MODEL_CHANGE (fake host): modelNotAllowed with x; Choose a model opens the pick; another model clears it; the next run uses it', async () => {
			await assistant().setAccessForTest({ key: KEY, baseUrl: fake.url });
			const hosts = new FakeAssistantHosts([{ emit: { type: 'error', message: '403 model "x" is not allowed for provider "p"' } }]);
			assistant().setHostFactory(hosts.factory);
			assert.strictEqual(await view().run(REQUEST), 'error');
			assert.deepStrictEqual([state().access, state().modelNotAllowed], ['modelNotAllowed', 'x']);
			assert.strictEqual(state().error, '403 model "x" is not allowed for provider "p"');
			assert.strictEqual(await view().run(REQUEST), 'modelNotAllowed', 'sticky: nothing starts');
			answers.model = 'claude-sonnet-4-6';
			await view().receive({ type: 'chooseModelRequested' });
			assert.deepStrictEqual(lastPick().items.map((i) => i.model), ['claude-opus-5-5', 'claude-sonnet-4-6', 'claude-haiku-5-5', null], 'the endpoint\'s list, fetched');
			assert.ok(await waitFor(() => state().access === 'ready', 5_000), state().access);
			assert.strictEqual(state().modelNotAllowed, null);
			hosts.script = happyScript();
			const { done } = await startRun();
			assert.ok(await waitFor(() => state().status === 'question', 10_000));
			await answerPicks();
			assert.strictEqual(await done, 'done');
			assert.strictEqual(hosts.last?.config.model, 'claude-sonnet-4-6');
		});

		test('manual check (8.3): a turn keeps the model it started on; a new turn gets the new setting', async () => {
			await assistant().setAccessForTest({ key: KEY });
			assistant().setHostFactory(new FakeAssistantHosts(happyScript()).factory);
			try {
				await config().update('model', 'claude-sonnet-4-6', vscode.ConfigurationTarget.Global);
				const first = await startRun();
				assert.ok(await waitFor(() => state().status === 'question', 10_000));
				assert.strictEqual(turn().model, 'claude-sonnet-4-6');
				await answerPicks();
				assert.strictEqual(await first.done, 'done');
				await config().update('model', 'claude-haiku-5-5', vscode.ConfigurationTarget.Global);
				assert.ok(await waitFor(() => state().model === 'claude-haiku-5-5', 5_000));
				assert.strictEqual(view().posted.at(-1)?.turns.at(-1)?.model, 'claude-sonnet-4-6', 'the earlier turn keeps its model');
				// The second run starts only from ready (the key held): a run that does not start says why, now.
				assert.strictEqual(state().access, 'ready');
				let outcome: string | undefined;
				const second = await startRun();
				void second.done.then((o) => (outcome = o));
				const ok = await waitFor(() => state().status === 'question' || outcome !== undefined, 10_000);
				assert.ok(ok && state().status === 'question', JSON.stringify({ outcome, status: state().status, access: state().access, error: state().error }));
				await answerPicks();
				assert.strictEqual(await second.done, 'done');
				assert.deepStrictEqual(state().turns.map((t) => t.model), ['claude-sonnet-4-6', 'claude-haiku-5-5']);
			} finally {
				await resetSettings();
			}
		});

		test('manual check (8.3): the secret storage: a read started before a write never wins over it; an echo of an earlier own state is ignored; another window\'s change applies', async () => {
			// A store whose reads can be made to hand back an older state once (as VS Code's application storage did).
			const values = new Map<string, string>();
			const changed = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
			let echo: Map<string, string> | undefined;
			let release: (() => void) | undefined;
			let slowReads = false;
			const store: vscode.SecretStorage = {
				get: (key) => {
					const value = echo ? echo.get(key) : values.get(key);
					// A slow read answers what it saw when it started, after the write it overlapped.
					return slowReads ? new Promise((resolve) => setTimeout(() => resolve(value), 60)) : Promise.resolve(value);
				},
				store: (key, value) => new Promise<void>((resolve) => {
					// The first write waits for the test: a read meanwhile must not overtake it.
					const done = () => {
						values.set(key, value);
						resolve();
					};
					if (!release) {
						release = done;
					} else {
						done();
					}
				}),
				delete: async (key) => {
					values.delete(key);
				},
				onDidChange: changed.event,
			};
			const access = new AssistantAccessClass({ store, log: () => undefined });
			try {
				await access.ready;
				// 1. A write in flight; a change's read starts (it sees no key) and answers only after the write ended.
				const writing = access.setAccessForTest({ key: KEY, keyBaseUrl: 'https://api.anthropic.com' });
				await waitFor(() => release !== undefined, 2_000);
				slowReads = true;
				changed.fire({ key: ASSISTANT_KEY_SECRET });
				await new Promise((r) => setTimeout(r, 10));
				release!();
				await writing;
				assert.ok(access.hasKey, 'held once written');
				await new Promise((r) => setTimeout(r, 120));
				slowReads = false;
				assert.ok(access.hasKey && access.keyMatchesBaseUrl, 'the read started before the write did not overwrite it');
				// 2. Our next write, then the storage hands back the earlier state (no key) once: ignored.
				await access.setAccessForTest({ key: null });
				await access.setAccessForTest({ key: KEY, keyBaseUrl: 'https://api.anthropic.com' });
				echo = new Map();
				changed.fire({ key: ASSISTANT_KEY_SECRET });
				await new Promise((r) => setTimeout(r, 30));
				assert.ok(access.hasKey, 'an echo of an earlier own state is ignored');
				// 3. Another window's change (a state never written here) applies at once.
				echo = new Map([[ASSISTANT_KEY_SECRET, 'Other7windowKey9xYz'], [ASSISTANT_KEY_URL_SECRET, 'https://adp.example']]);
				changed.fire({ key: ASSISTANT_KEY_SECRET });
				assert.ok(await waitForAsync(async () => (await access.apiKey()) === 'Other7windowKey9xYz', 2_000), 'another window\'s key');
			} finally {
				access.dispose();
				changed.dispose();
			}
		});

		test('MODEL_CHANGE (the setting): a change to the model setting clears modelNotAllowed', async () => {
			await assistant().setAccessForTest({ key: KEY });
			assistant().setHostFactory(new FakeAssistantHosts([{ emit: { type: 'error', message: 'API Error: 403 {"error":{"type":"model_not_allowed","message":"model \\"claude-opus-5-5\\" is not allowed for provider \\"p\\""}}' } }]).factory);
			assert.strictEqual(await view().run(REQUEST), 'error');
			assert.deepStrictEqual([state().access, state().modelNotAllowed], ['modelNotAllowed', 'claude-opus-5-5']);
			await config().update('model', 'claude-haiku-5-5', vscode.ConfigurationTarget.Global);
			assert.ok(await waitFor(() => state().access === 'ready', 5_000), state().access);
		});

		test('unreachable (fake host): not sticky: the failed turn shows it; the composer stays; the next run starts and clears it', async () => {
			await assistant().setAccessForTest({ key: KEY, baseUrl: fake.url });
			const hosts = new FakeAssistantHosts([{ emit: { type: 'error', message: 'API Error: Connection error.' } }]);
			assistant().setHostFactory(hosts.factory);
			assert.strictEqual(await view().run(REQUEST), 'error');
			assert.deepStrictEqual([state().access, state().host], ['unreachable', new URL(fake.url).host]);
			hosts.script = happyScript();
			const { done } = await startRun();
			assert.strictEqual(state().access, 'ready', 'cleared as the run starts');
			assert.ok(await waitFor(() => state().status === 'question', 10_000));
			await answerPicks();
			assert.strictEqual(await done, 'done');
		});

		test('RUN_403_MODEL (fake model): the endpoint refuses the model with ADP\'s 403: modelNotAllowed with its name', async () => {
			await assistant().setAccessForTest({ key: KEY, baseUrl: fake.url, auth: 'bearer', model: 'claude-opus-5-5' });
			assistant().setHostFactory(undefined);
			fake.failure = adp403Model('claude-opus-5-5');
			assert.strictEqual(await view().run(REQUEST), 'error', JSON.stringify(state()));
			assert.deepStrictEqual([state().access, state().modelNotAllowed], ['modelNotAllowed', 'claude-opus-5-5'], state().error ?? '');
		});

		test('PICK_OTHER: Other…, then a typed name: written; Escape at Other… changes nothing', async () => {
			assert.strictEqual(await setUp(), 'stored');
			answers.model = null;
			answers.other = 'my-alias';
			assert.strictEqual(await assistant().access.chooseModel(), 'my-alias');
			assert.strictEqual(config().inspect('model')?.globalValue, 'my-alias');
			assert.strictEqual(inputs.at(-1)?.value, 'claude-opus-5-5', 'Other… is prefilled with the current model');
			answers.other = undefined;
			assert.strictEqual(await assistant().access.chooseModel(), undefined);
			assert.strictEqual(config().inspect('model')?.globalValue, 'my-alias');
			assert.ok(await waitFor(() => state().model === 'my-alias', 5_000));
		});

		test('NO_LEAK: after set-up, a test, a run and forget: the key is in no setting, file, log, message or quick-pick item', async () => {
			assert.strictEqual(await setUp(), 'stored');
			assert.strictEqual(await assistant().access.testConnection(), 'ok');
			assistant().setHostFactory(new FakeAssistantHosts([{ emit: { type: 'error', message: `API Error: 401 Bearer ${KEY}` } }]).factory);
			assert.strictEqual(await view().run(REQUEST), 'error');
			await assistant().setAccessForTest({ key: KEY, keyBaseUrl: fake.url });
			await view().receive({ type: 'chooseModelRequested' });
			answers.confirm = true;
			assert.strictEqual(await assistant().access.forget(), 'forgotten');
			assertNoLeak();
			const ui = JSON.stringify({ picks, errors, notes, inputs: inputs.map((o) => ({ ...o, validateInput: undefined })) });
			for (let i = 0; i + 12 <= KEY.length; i++) {
				assert.ok(!ui.includes(KEY.slice(i, i + 12)), 'quick picks, inputs and messages');
			}
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
