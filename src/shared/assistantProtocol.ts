// The RPCN AI Assistant view's messages (AD-26, story 8.1; story 8.12: the chat's turns), host↔webview. As the metrics tab's
// (`metricsProtocol.ts`): the webview posts `ready` each time it loads and gets the whole state then
// and on every change; it keeps no state of its own but the text being typed. Webview → host: past-tense
// intents. Both directions are parsed from unknown input, field by field.

/** Whether a request can start, and if not, why. */
export type AssistantAccess = 'ready' | 'unavailable' | 'runtimeMissing' | 'runtimeInstalling' | 'runtimeOutdated' | 'runtimeFailed' | 'badSkillsPath' | 'noAccess' | 'badBaseUrl' | 'baseUrlChanged' | 'noBinary' | 'noUv' | 'noWorkspace';

/** Story 8.2: the `rpcn-skills` copy in use: the bundled one, or the local checkout `skillsPath` names. */
export type AssistantSkills = 'bundled' | 'local';

/** Story 8.2: why `skillsPath` gives no copy to use (review 1, 7, 15). */
export type SkillsPathProblem = 'notAbsolute' | 'notFound' | 'notCheckout' | 'inWorkspace';

/** Story 8.2: the assistant runtime (the Agent SDK and this platform's Claude Code binary, installed by the user). */
export interface AssistantRuntimeView {
	/** The SDK version this extension pins. */
	readonly pinned: string;
	/** Another installed version, with `runtimeOutdated`; else `null`. */
	readonly installed: string | null;
	/** Why the last install failed (masked), with `runtimeFailed`; else `null`. */
	readonly error: string | null;
}

/** Where the run is. */
export type AssistantStatus = 'idle' | 'running' | 'question' | 'approval' | 'done' | 'stopped' | 'error';

export interface AssistantOptionView {
	readonly label: string;
	readonly description: string;
	/** The skill's own pick ("(My pick)" in its label): shown first, chosen until another is. */
	readonly pick: boolean;
}

export interface AssistantQuestionView {
	readonly question: string;
	readonly header: string;
	/** The pick first, then the others in the skill's order. */
	readonly options: readonly AssistantOptionView[];
	readonly multiSelect: boolean;
}

/** One open `AskUserQuestion`: its cards, answered together. */
export interface AssistantQuestionsView {
	readonly id: string;
	readonly questions: readonly AssistantQuestionView[];
}

/** The design note on disk: its workspace-relative file and its frontmatter `status` (`null`: none). */
export interface AssistantNoteView {
	readonly file: string;
	readonly status: string | null;
}

/** Story 8.12: the composer's slash commands (`design` the default; `build` and `test` arrive with their stages). */
export type AssistantCommand = 'design' | 'build' | 'test';
export const ASSISTANT_COMMANDS: readonly AssistantCommand[] = ['design', 'build', 'test'];

/** Story 8.12: a step row's mark (`info`: a line that is no tool call, such as "Started (model)" or "Allowed"). */
export type AssistantStepMark = 'running' | 'ok' | 'failed' | 'info';

export interface AssistantStepView {
	readonly id: string;
	readonly label: string;
	readonly mark: AssistantStepMark;
	/** The short result (at most 60 characters; may be empty). */
	readonly result: string;
}

/** Story 8.12: a file the turn changed. */
export interface AssistantFileView {
	/** Workspace-relative, `/`-separated. */
	readonly path: string;
	readonly added: number;
	readonly removed: number;
	/** The turn created it (no file before). */
	readonly created: boolean;
	/** Over 1 MB before the turn: no snapshot, so no diff and no undo. */
	readonly tooLarge: boolean;
}

/** Story 8.12: what became of a turn's changes: none written, waiting for Keep or Undo, kept, or undone. */
export type AssistantReview = 'none' | 'pending' | 'kept' | 'undone';

/** Story 8.12: how a turn's run ended (`running` while it goes). */
export type AssistantOutcome = 'running' | 'done' | 'stopped' | 'error';

/** Story 8.12: a next-step button of a turn (the host's slot: this story fills Open note). */
export interface AssistantActionView {
	readonly id: string;
	readonly label: string;
	readonly enabled: boolean;
	/** Why it is off (with `enabled` false); else `null`. */
	readonly hint: string | null;
}

/** Story 8.12: a chip under a turn: a slash command for the composer. */
export interface AssistantChipView {
	readonly label: string;
	readonly command: AssistantCommand;
	readonly enabled: boolean;
	readonly hint: string | null;
}

/** Story 8.12: one turn of the conversation: the user's message and rpcn's answer to it. */
export interface AssistantTurnView {
	readonly id: string;
	readonly command: AssistantCommand;
	/** The message as typed. */
	readonly text: string;
	/** The skill it ran. */
	readonly skill: string;
	readonly steps: readonly AssistantStepView[];
	/** The reply, as Markdown (at most `MAX_REPLY_CHARS`). */
	readonly reply: string;
	readonly files: readonly AssistantFileView[];
	readonly review: AssistantReview;
	/** The design note the turn wrote, read from disk (its frontmatter `status`), or `null`. */
	readonly note: AssistantNoteView | null;
	readonly actions: readonly AssistantActionView[];
	readonly chips: readonly AssistantChipView[];
	readonly outcome: AssistantOutcome;
	/** A line about Keep or Undo (an undo that could not restore every file); else `null`. */
	readonly notice: string | null;
}

export interface AssistantStateMessage {
	readonly type: 'state';
	readonly access: AssistantAccess;
	/** Story 8.2: the platform no Claude Code binary package exists for (`win32-x64`, …), with `unavailable`; else `null`. */
	readonly platform: string | null;
	/** Story 8.2: the assistant runtime's versions and last install error. */
	readonly runtime: AssistantRuntimeView;
	/** Story 8.2: the skills copy a run uses (`null`: `skillsPath` gives none, review 14). */
	readonly skills: AssistantSkills | null;
	/** Story 8.2: why, with `badSkillsPath`; else `null`. */
	readonly skillsProblem: SkillsPathProblem | null;
	readonly status: AssistantStatus;
	/** Story 8.12: the conversation, oldest first (at most `MAX_TURNS`); the last is the current or last run's. */
	readonly turns: readonly AssistantTurnView[];
	/** Story 8.12: the stage strip's target folder (the workspace folder's name), or `null`. */
	readonly folder: string | null;
	/** Story 8.12: this conversation's design note is `ready` (Design's ✓). */
	readonly designReady: boolean;
	/** The current run's open question, shown in the current turn. */
	readonly questions: AssistantQuestionsView | null;
	/** The error line (masked) of the last run. */
	readonly error: string | null;
}

export type AssistantHostMessage = AssistantStateMessage;

export type AssistantWebviewMessage =
	| { readonly type: 'ready' }
	/** Story 8.12: the message as typed, and its command (no slash command: `design`). */
	| { readonly type: 'runRequested'; readonly command: AssistantCommand; readonly request: string }
	/** The open question's answers, one per card in the cards' order (review 20: by index, never by text). */
	| { readonly type: 'answered'; readonly id: string; readonly answers: readonly string[] }
	| { readonly type: 'stopRequested' }
	| { readonly type: 'setUpAccessRequested' }
	/** Review 15: the bad base URL's Open settings. */
	| { readonly type: 'openSettingsRequested' }
	/** Story 8.2: Install assistant runtime… (and Retry). */
	| { readonly type: 'installRuntimeRequested' }
	/** Story 8.2: Update assistant runtime…. */
	| { readonly type: 'updateRuntimeRequested' }
	/** Story 8.12: a file row clicked: its diff against the copy from before the turn. */
	| { readonly type: 'openFileDiff'; readonly turn: string; readonly path: string }
	| { readonly type: 'keepTurn'; readonly turn: string }
	| { readonly type: 'undoTurn'; readonly turn: string }
	/** Story 8.12: a next-step button (`action`: its id). */
	| { readonly type: 'turnAction'; readonly turn: string; readonly action: string }
	/** Story 8.12: a link in a reply clicked (the host opens only http(s) links and workspace files). */
	| { readonly type: 'openLink'; readonly href: string }
	| { readonly type: 'newConversation' };

export const ASSISTANT_TITLE = 'RPCN AI Assistant';
/** How a skill marks its pick in an option's label. */
export const PICK_MARK = '(My pick)';
export const OTHER_LABEL = 'Other';
export const OTHER_PLACEHOLDER = 'Type your answer';
export const SET_UP_ACCESS_LABEL = 'Set up assistant access…';
export const NO_ACCESS_TEXT = 'Assistant access isn\'t set up. Set the endpoint and model in the settings (redpandaConnect.assistant.*) and store the key.';
export const BAD_BASE_URL_TEXT = 'The assistant\'s base URL (redpandaConnect.assistant.baseUrl) is not usable: it must be an https:// URL (http:// only for localhost), with no user or password in it.';
export const BASE_URL_CHANGED_TEXT = 'The base URL changed since the key was set up; set up access again to send the key there. Nothing was sent.';
export const NO_UV_TEXT = 'The assistant needs uv on the PATH to run the skills\' checks. Install uv (https://docs.astral.sh/uv/) and reload the window.';
export const OPEN_SETTINGS_LABEL = 'Open settings';
/** Story 8.2: no Claude Code binary package exists for the platform, so no runtime can be installed. */
export function unavailableText(platform: string): string {
	return `The RPCN AI Assistant isn't available for ${platform} yet: Anthropic publishes no Claude Code binary package for it.`;
}
export const INSTALL_RUNTIME_LABEL = 'Install assistant runtime…';
export const UPDATE_RUNTIME_LABEL = 'Update assistant runtime…';
export const RETRY_LABEL = 'Retry';
export const RUNTIME_MISSING_TEXT = 'The assistant needs Anthropic\'s Claude Agent SDK and its Claude Code binary, which this extension doesn\'t include. Install assistant runtime… downloads them from the npm registry, after you agree to Anthropic\'s terms.';
export const RUNTIME_INSTALLING_TEXT = 'Installing the assistant runtime…';
/** Story 8.2: another runtime version is installed than the one this extension pins. */
export function runtimeOutdatedText(installed: string, pinned: string): string {
	return `The installed assistant runtime is ${installed}; this extension needs ${pinned}. Update assistant runtime… installs it and removes the old one.`;
}
/** Story 8.2: the last install failed (`reason` already masked). */
export function runtimeFailedText(reason: string | null): string {
	const why = (reason ?? 'unknown error').trim().replace(/[.\s]+$/, '');
	return `The assistant runtime couldn't be installed: ${why}.`;
}
const SKILLS_PATH_FIX = 'Fix redpandaConnect.assistant.skillsPath, or clear it to use the bundled copy.';
/** Story 8.2 (review 15): each `badSkillsPath` reason's text. */
export const BAD_SKILLS_PATH_TEXTS: Readonly<Record<SkillsPathProblem, string>> = {
	notAbsolute: `The skills path must be absolute (a leading ~ is the home folder). ${SKILLS_PATH_FIX}`,
	notFound: `The skills path is not a folder that exists. ${SKILLS_PATH_FIX}`,
	notCheckout: `The skills path isn't an rpcn-skills checkout: it needs .claude-plugin/plugin.json and the rpcn-design, rpcn-author and rpcn-test skills. ${SKILLS_PATH_FIX}`,
	inWorkspace: `The skills path is the workspace folder, inside it or around it; the assistant writes there, and the skills' scripts run without asking. Use a checkout outside the workspace. ${SKILLS_PATH_FIX}`,
};
/** The `badSkillsPath` text of a state with no reason given. */
export const BAD_SKILLS_PATH_TEXT = BAD_SKILLS_PATH_TEXTS.notCheckout;
export const LOCAL_SKILLS_TEXT = 'Skills: local copy';
export const NO_BINARY_TEXT = 'The assistant needs Redpanda Connect: it checks every design against your own binary. Install rpk or redpanda-connect, or set redpandaConnect.binaryPath.';
export const NO_WORKSPACE_TEXT = 'Open a folder first: the assistant writes its design note there.';
export const STOPPED_TEXT = 'Stopped. Nothing more was written.';
export const REQUEST_PLACEHOLDER = 'Describe the pipeline you want, in plain words; / for commands';
/** Story 8.12: the most step rows a turn carries (the oldest dropped first). */
export const MAX_STEPS = 200;
/** Story 8.12: the most turns a conversation keeps (the oldest dropped first). */
export const MAX_TURNS = 50;
/** Story 8.12: the longest reply of a turn. */
export const MAX_REPLY_CHARS = 20_000;
export const NEW_CONVERSATION_LABEL = 'New conversation';
export const KEEP_LABEL = 'Keep';
export const UNDO_LABEL = 'Undo';
export const UNDONE_TEXT = 'Undone';
export const TOO_LARGE_TEXT = 'too large to undo';
export const OPEN_NOTE_ACTION = 'openNote';
export const OPEN_NOTE_LABEL = 'Open note';
/** Story 8.12: the stage strip. */
export const STAGES = ['Design', 'Author', 'Test'] as const;
/** Story 8.12: why a command is not offered yet (`null`: it runs). */
export const COMMAND_HINTS: Readonly<Record<AssistantCommand, string | null>> = {
	design: null,
	build: 'Arrives with the Author stage',
	test: 'Arrives with the Test hand-off',
};
/** Story 8.12: each command's line in the composer's list. */
export const COMMAND_DESCRIPTIONS: Readonly<Record<AssistantCommand, string>> = {
	design: 'Design a pipeline: a checked design note',
	build: 'Build the pipeline from a ready note',
	test: 'Test the built pipeline',
};
/** Story 8.12: the skill each command runs. */
export const COMMAND_SKILLS: Readonly<Record<AssistantCommand, string>> = { design: 'rpcn-design', build: 'rpcn-author', test: 'rpcn-test' };

/**
 * Story 8.12: a message's slash command, if it starts with one (`/design`, `/build`, `/test`, alone or
 * followed by whitespace), and the text after it; else `command` `null` and the text trimmed.
 */
export function parseCommand(text: string): { readonly command: AssistantCommand | null; readonly rest: string } {
	const m = /^\s*\/(design|build|test)(?=\s|$)/.exec(text);
	return m ? { command: m[1] as AssistantCommand, rest: text.slice(m[0].length).trim() } : { command: null, rest: text.trim() };
}

/** Story 8.12: Undo's question when files changed after the turn ended. */
export function undoLaterEditsText(files: readonly string[]): string {
	return `Undo will discard your edits to ${files.map((f) => `\`${f}\``).join(', ')} since the turn.`;
}
/** The longest request accepted. */
export const MAX_REQUEST_CHARS = 8000;

/** Whether an option label is the skill's pick. */
export function isPick(label: string): boolean {
	return label.includes(PICK_MARK);
}

/** The options with the pick first (stable otherwise). */
export function orderOptions<T extends { readonly label: string }>(options: readonly T[]): (T & { readonly pick: boolean })[] {
	const marked = options.map((o) => ({ ...o, pick: isPick(o.label) }));
	return [...marked.filter((o) => o.pick), ...marked.filter((o) => !o.pick)];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';
const ACCESS: readonly string[] = ['ready', 'unavailable', 'runtimeMissing', 'runtimeInstalling', 'runtimeOutdated', 'runtimeFailed', 'badSkillsPath', 'noAccess', 'badBaseUrl', 'baseUrlChanged', 'noBinary', 'noUv', 'noWorkspace'];
const STATUS: readonly string[] = ['idle', 'running', 'question', 'approval', 'done', 'stopped', 'error'];

function parseOption(v: unknown): AssistantOptionView | undefined {
	return isObject(v) && isString(v.label) && isString(v.description) && typeof v.pick === 'boolean'
		? { label: v.label, description: v.description, pick: v.pick } : undefined;
}

function parseQuestion(v: unknown): AssistantQuestionView | undefined {
	if (!isObject(v) || !isString(v.question) || !isString(v.header) || !Array.isArray(v.options) || typeof v.multiSelect !== 'boolean') {
		return undefined;
	}
	const options = v.options.map(parseOption);
	return options.every((o) => o !== undefined)
		? { question: v.question, header: v.header, options: options as AssistantOptionView[], multiSelect: v.multiSelect } : undefined;
}

function parseQuestions(v: unknown): AssistantQuestionsView | null | undefined {
	if (v === null) {
		return null;
	}
	if (!isObject(v) || !isString(v.id) || !Array.isArray(v.questions)) {
		return undefined;
	}
	const questions = v.questions.map(parseQuestion);
	return questions.every((q) => q !== undefined) ? { id: v.id, questions: questions as AssistantQuestionView[] } : undefined;
}

function parseRuntime(v: unknown): AssistantRuntimeView | undefined {
	return isObject(v) && isString(v.pinned) && isNullableString(v.installed) && isNullableString(v.error)
		? { pinned: v.pinned, installed: v.installed, error: v.error } : undefined;
}

function parseNote(v: unknown): AssistantNoteView | null | undefined {
	if (v === null) {
		return null;
	}
	return isObject(v) && isString(v.file) && isNullableString(v.status) ? { file: v.file, status: v.status } : undefined;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isCommand = (v: unknown): v is AssistantCommand => isString(v) && (ASSISTANT_COMMANDS as readonly string[]).includes(v);
const MARKS: readonly string[] = ['running', 'ok', 'failed', 'info'];
const REVIEWS: readonly string[] = ['none', 'pending', 'kept', 'undone'];
const OUTCOMES: readonly string[] = ['running', 'done', 'stopped', 'error'];

function parseList<T>(v: unknown, item: (x: unknown) => T | undefined): T[] | undefined {
	if (!Array.isArray(v)) {
		return undefined;
	}
	const out = v.map(item);
	return out.every((x) => x !== undefined) ? out as T[] : undefined;
}

function parseStep(v: unknown): AssistantStepView | undefined {
	return isObject(v) && isString(v.id) && isString(v.label) && isString(v.mark) && MARKS.includes(v.mark) && isString(v.result)
		? { id: v.id, label: v.label, mark: v.mark as AssistantStepMark, result: v.result } : undefined;
}

function parseFile(v: unknown): AssistantFileView | undefined {
	return isObject(v) && isString(v.path) && isCount(v.added) && isCount(v.removed) && typeof v.created === 'boolean' && typeof v.tooLarge === 'boolean'
		? { path: v.path, added: v.added, removed: v.removed, created: v.created, tooLarge: v.tooLarge } : undefined;
}

function parseAction(v: unknown): AssistantActionView | undefined {
	return isObject(v) && isString(v.id) && isString(v.label) && typeof v.enabled === 'boolean' && isNullableString(v.hint)
		? { id: v.id, label: v.label, enabled: v.enabled, hint: v.hint } : undefined;
}

function parseChip(v: unknown): AssistantChipView | undefined {
	return isObject(v) && isString(v.label) && isCommand(v.command) && typeof v.enabled === 'boolean' && isNullableString(v.hint)
		? { label: v.label, command: v.command, enabled: v.enabled, hint: v.hint } : undefined;
}

function parseTurn(v: unknown): AssistantTurnView | undefined {
	if (!isObject(v) || !isString(v.id) || !isCommand(v.command) || !isString(v.text) || !isString(v.skill) || !isString(v.reply)
		|| !isString(v.review) || !REVIEWS.includes(v.review) || !isString(v.outcome) || !OUTCOMES.includes(v.outcome) || !isNullableString(v.notice)) {
		return undefined;
	}
	const steps = parseList(v.steps, parseStep);
	const files = parseList(v.files, parseFile);
	const actions = parseList(v.actions, parseAction);
	const chips = parseList(v.chips, parseChip);
	const note = parseNote(v.note);
	if (!steps || !files || !actions || !chips || note === undefined) {
		return undefined;
	}
	return {
		id: v.id, command: v.command, text: v.text, skill: v.skill, steps, reply: v.reply, files, review: v.review as AssistantReview, note,
		actions, chips, outcome: v.outcome as AssistantOutcome, notice: v.notice,
	};
}

/** A host message, copied with only its own fields, or `undefined` for anything malformed. */
export function parseAssistantHostMessage(v: unknown): AssistantHostMessage | undefined {
	if (!isObject(v) || v.type !== 'state' || !isString(v.access) || !ACCESS.includes(v.access) || !isString(v.status) || !STATUS.includes(v.status)
		|| !isNullableString(v.error) || !isNullableString(v.folder) || typeof v.designReady !== 'boolean'
		|| !isNullableString(v.platform) || (v.skills !== 'bundled' && v.skills !== 'local' && v.skills !== null)
		|| !(v.skillsProblem === null || (isString(v.skillsProblem) && Object.hasOwn(BAD_SKILLS_PATH_TEXTS, v.skillsProblem)))) {
		return undefined;
	}
	const questions = parseQuestions(v.questions);
	const turns = parseList(v.turns, parseTurn);
	const runtime = parseRuntime(v.runtime);
	if (questions === undefined || turns === undefined || runtime === undefined) {
		return undefined;
	}
	return {
		type: 'state', access: v.access as AssistantAccess, platform: v.platform, runtime, skills: v.skills, skillsProblem: v.skillsProblem as SkillsPathProblem | null,
		status: v.status as AssistantStatus, turns, folder: v.folder, designReady: v.designReady, questions, error: v.error,
	};
}

/** A webview message, copied with only its own fields, or `undefined` for anything malformed. */
export function parseAssistantWebviewMessage(v: unknown): AssistantWebviewMessage | undefined {
	if (!isObject(v)) {
		return undefined;
	}
	switch (v.type) {
		case 'ready':
		case 'stopRequested':
		case 'setUpAccessRequested':
		case 'openSettingsRequested':
		case 'installRuntimeRequested':
		case 'updateRuntimeRequested':
		case 'newConversation':
			return { type: v.type };
		case 'runRequested':
			if (!isString(v.request) || v.request.trim() === '' || v.request.length > MAX_REQUEST_CHARS || (v.command !== undefined && !isCommand(v.command))) {
				return undefined;
			}
			return { type: 'runRequested', command: v.command ?? 'design', request: v.request };
		case 'openFileDiff':
			return isString(v.turn) && isString(v.path) ? { type: 'openFileDiff', turn: v.turn, path: v.path } : undefined;
		case 'keepTurn':
		case 'undoTurn':
			return isString(v.turn) ? { type: v.type, turn: v.turn } : undefined;
		case 'turnAction':
			return isString(v.turn) && isString(v.action) ? { type: 'turnAction', turn: v.turn, action: v.action } : undefined;
		case 'openLink':
			return isString(v.href) && v.href.length <= 4096 ? { type: 'openLink', href: v.href } : undefined;
		case 'answered': {
			if (!isString(v.id) || !Array.isArray(v.answers) || !v.answers.every(isString)) {
				return undefined;
			}
			return { type: 'answered', id: v.id, answers: [...v.answers as string[]] };
		}
		default:
			return undefined;
	}
}
