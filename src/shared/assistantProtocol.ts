// The RPCN AI Assistant view's messages (AD-26, story 8.1), host↔webview. As the metrics tab's
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
	/** The request of the current or last run. */
	readonly request: string | null;
	/** The run's progress lines, oldest first (at most `MAX_PROGRESS_LINES`). */
	readonly progress: readonly string[];
	readonly questions: AssistantQuestionsView | null;
	readonly note: AssistantNoteView | null;
	/** The error line (masked). */
	readonly error: string | null;
}

export type AssistantHostMessage = AssistantStateMessage;

export type AssistantWebviewMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'runRequested'; readonly request: string }
	/** The open question's answers, one per card in the cards' order (review 20: by index, never by text). */
	| { readonly type: 'answered'; readonly id: string; readonly answers: readonly string[] }
	| { readonly type: 'stopRequested' }
	| { readonly type: 'setUpAccessRequested' }
	/** Review 15: the bad base URL's Open settings. */
	| { readonly type: 'openSettingsRequested' }
	/** Story 8.2: Install assistant runtime… (and Retry). */
	| { readonly type: 'installRuntimeRequested' }
	/** Story 8.2: Update assistant runtime…. */
	| { readonly type: 'updateRuntimeRequested' };

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
export const DONE_TEXT = 'Done.';
export const REQUEST_PLACEHOLDER = 'Describe the pipeline you want, in plain words';
/** The most progress lines a state carries (the oldest dropped first). */
export const MAX_PROGRESS_LINES = 200;
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

/** A host message, copied with only its own fields, or `undefined` for anything malformed. */
export function parseAssistantHostMessage(v: unknown): AssistantHostMessage | undefined {
	if (!isObject(v) || v.type !== 'state' || !isString(v.access) || !ACCESS.includes(v.access) || !isString(v.status) || !STATUS.includes(v.status)
		|| !isNullableString(v.request) || !Array.isArray(v.progress) || !v.progress.every(isString) || !isNullableString(v.error)
		|| !isNullableString(v.platform) || (v.skills !== 'bundled' && v.skills !== 'local' && v.skills !== null)
		|| !(v.skillsProblem === null || (isString(v.skillsProblem) && Object.hasOwn(BAD_SKILLS_PATH_TEXTS, v.skillsProblem)))) {
		return undefined;
	}
	const questions = parseQuestions(v.questions);
	const note = parseNote(v.note);
	const runtime = parseRuntime(v.runtime);
	if (questions === undefined || note === undefined || runtime === undefined) {
		return undefined;
	}
	return {
		type: 'state', access: v.access as AssistantAccess, platform: v.platform, runtime, skills: v.skills, skillsProblem: v.skillsProblem as SkillsPathProblem | null, status: v.status as AssistantStatus, request: v.request, progress: [...v.progress as string[]],
		questions, note, error: v.error,
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
			return { type: v.type };
		case 'runRequested':
			return isString(v.request) && v.request.trim() !== '' && v.request.length <= MAX_REQUEST_CHARS ? { type: 'runRequested', request: v.request } : undefined;
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
