// The RPCN AI Assistant's host port (AD-26, story 8.1): the one boundary between the assistant view and
// whatever runs the agent. The view and its controller see only this port; the first adapter is the
// embedded Claude Agent SDK (`agentSdkHost.ts`), the integration tests use a scripted in-memory one
// (`src/test/helpers/fakeAssistantHost.ts`). No `vscode` or SDK import here (eslint keeps `vscode` out).
//
// A run: `start` with the request, events through the listener while it goes, then exactly one
// `result` or `error` as its last event, and the promise settles. While a `question` or an `approval`
// is open the run waits for `answer` or `approve` with its id (several may be open at once, each by its
// id; `withdrawn` closes one the agent gave up on); `cancel` ends it (the open ones are refused, and the
// run's last event is a `result` with `stopped`). Story 8.5: a call whose session key the view's session
// memory holds (`isRemembered`) does not ask: a `remembered` event instead.

import type { RuntimeFiles } from './runtime';

/** The skills the bundled `rpcn-skills` plugin gives the model (the `skills` allowlist). */
export const RPCN_SKILLS = ['rpcn-design', 'rpcn-author', 'rpcn-test'] as const;
export type RpcnSkill = typeof RPCN_SKILLS[number];

/** How the key is sent: `Authorization: Bearer` (`ANTHROPIC_AUTH_TOKEN`) or `x-api-key` (`ANTHROPIC_API_KEY`). */
export type AssistantAuth = 'bearer' | 'x-api-key';

export interface AssistantQuestionOption {
	readonly label: string;
	readonly description: string;
}

/** One `AskUserQuestion` question, as the skill asked it. */
export interface AssistantQuestion {
	readonly question: string;
	readonly header: string;
	readonly options: readonly AssistantQuestionOption[];
	readonly multiSelect: boolean;
}

/** The answers to one `question` event, by question text (as `AskUserQuestion` takes them back). */
export type AssistantAnswers = Readonly<Record<string, string>>;

export type AssistantEvent =
	/** A line of the run that is no tool call, already short and plain (such as "Started (model)", a retry). */
	| { readonly type: 'progress'; readonly text: string }
	/** Story 8.12: a top-level tool call began: its step row (`label` from `toolProgress`). */
	/** `detail`: a shell step's command on one line, clipped; `fullDetail`: all of it (new lines kept, unmasked), when longer or multi-line. */
	| { readonly type: 'step'; readonly id: string; readonly label: string; readonly detail?: string; readonly fullDetail?: string }
	/** Story 8.12: that tool call's result: ok or failed, and a short result (at most `STEP_RESULT_CHARS`; may be empty). */
	| { readonly type: 'stepDone'; readonly id: string; readonly ok: boolean; readonly result: string }
	/** Story 8.12: top-level text of the model's reply, in order (the view joins the pieces). */
	| { readonly type: 'reply'; readonly text: string }
	/**
	 * Story 8.12: the run is about to write `path` (absolute) for the first time: its content before
	 * (`null`: it did not exist). `tooLarge`: over `SNAPSHOT_MAX_BYTES`, so not kept (`before` is `null`).
	 */
	| { readonly type: 'fileChanging'; readonly path: string; readonly before: string | null; readonly tooLarge?: boolean }
	/** The skill asks; answer with `answer(id, …)`. */
	| { readonly type: 'question'; readonly id: string; readonly questions: readonly AssistantQuestion[] }
	/**
	 * A tool call outside the boundaries asks; decide with `approve(id, …)`. Story 8.5: `sessionKey`, from
	 * the rules, is what Allow for this session remembers (`null`: the call always asks).
	 */
	| {
		readonly type: 'approval'; readonly id: string; readonly tool: string; readonly summary: string; readonly detail?: string; readonly stepId?: string;
		readonly sessionKey: string | null;
	}
	/** Story 8.5: a call that would ask, allowed without a card because the session memory holds its key. */
	| { readonly type: 'remembered'; readonly sessionKey: string; readonly stepId?: string }
	/** An open `question` or `approval` the agent no longer waits for (its request was aborted): its card goes. */
	| { readonly type: 'withdrawn'; readonly id: string }
	/** A file the agent wrote (absolute path). */
	| { readonly type: 'fileWritten'; readonly path: string }
	/** The run ended: done, or (`stopped`) cancelled. */
	| { readonly type: 'result'; readonly stopped: boolean; readonly text?: string }
	/**
	 * The run ended with an error (its text, not yet masked by the view). Story 8.2: `runtimeMissing` when
	 * the assistant runtime the view found is gone (or cannot be loaded) as the run starts; the view then
	 * shows its runtime state, not an error.
	 */
	| { readonly type: 'error'; readonly message: string; readonly runtimeMissing?: boolean };

/** Story 8.12: the longest short result of a step row. */
export const STEP_RESULT_CHARS = 60;
/** Story 8.12: files larger than this are not snapshotted before a write (their row says "too large to undo"). */
export const SNAPSHOT_MAX_BYTES = 1024 * 1024;

/** Story 8.5: the user's decision on an approval: allow this call, allow its key for the session, or deny. */
export type ApprovalDecision = 'once' | 'session' | 'deny';

export type AssistantListener = (event: AssistantEvent) => void;

/** What one run is asked to do. */
export interface AssistantRequest {
	/** The user's request, as typed. */
	readonly prompt: string;
	/** The skill the request runs (story 8.1: always `rpcn-design`). */
	readonly skill: RpcnSkill;
}

/** Everything an adapter needs, as plain values (read by the vscode glue). */
export interface AssistantHostConfig {
	readonly model: string;
	readonly baseUrl: string;
	readonly auth: AssistantAuth;
	/** The key, from the secret storage; only ever passed on in the agent's environment. */
	readonly apiKey: string;
	/** The workspace folder: the agent's `cwd`, the only place it may write. */
	readonly workspace: string;
	/** The `rpcn-skills` copy in use (a Claude Code plugin folder): the bundled one, or `skillsPath`'s (story 8.2). */
	readonly skillsDir: string;
	/** The Redpanda Connect binary AD-9 resolved (`RPCN_BINARY`). */
	readonly rpcnBinary: string;
	/** The extension's global storage: the agent's config, `uv` and XDG folders go under it. */
	readonly storageDir: string;
	/** The extension's environment the agent's is built from (only `PATH`, `HOME`, `LANG` and `PASS_THROUGH` are taken). */
	readonly baseEnv: Readonly<Record<string, string | undefined>>;
	/** A log line (the vscode glue masks it). */
	readonly log: (line: string) => void;
	/** No message from the agent this long, while nothing waits on the user, ends the run (default 5 min; a test's seam). */
	readonly idleTimeoutMs?: number;
	/**
	 * Story 8.2 (review 3): the installed assistant runtime's SDK entry and Claude Code binary, as the view
	 * found them when the run started; loaded only from there (gone by then: a `runtimeMissing` error).
	 */
	readonly runtime: RuntimeFiles;
	/**
	 * Story 8.5: whether the session memory (the view's, in memory, for the window's life) holds a call's
	 * session key; such a call is allowed without asking (`remembered`). Absent: nothing is remembered.
	 */
	readonly isRemembered?: (sessionKey: string) => boolean;
}

export interface AssistantHost {
	/** Runs one request; settles once its last event (`result` or `error`) is sent. Never rejects. */
	start(request: AssistantRequest, listener: AssistantListener): Promise<void>;
	/** Answers an open `question` (`undefined`: dismissed, the skill gets a refusal). */
	answer(id: string, answers: AssistantAnswers | undefined): void;
	/** Decides an open `approval` (`once` and `session` allow it, `deny` denies it). */
	approve(id: string, decision: ApprovalDecision): void;
	/** Stops the run (no effect when none runs). */
	cancel(): void;
}

export type AssistantHostFactory = (config: AssistantHostConfig) => AssistantHost;

/** The questions of an `AskUserQuestion` input, or `undefined` when it holds none in the expected shape. */
export function questionsOf(input: unknown): AssistantQuestion[] | undefined {
	const list = (input as { questions?: unknown } | null)?.questions;
	if (!Array.isArray(list) || list.length === 0) {
		return undefined;
	}
	const out: AssistantQuestion[] = [];
	for (const q of list as Record<string, unknown>[]) {
		if (!q || typeof q.question !== 'string' || !Array.isArray(q.options)) {
			return undefined;
		}
		const options = (q.options as Record<string, unknown>[])
			.filter((o) => o && typeof o.label === 'string')
			.map((o) => ({ label: o.label as string, description: typeof o.description === 'string' ? o.description : '' }));
		out.push({ question: q.question, header: typeof q.header === 'string' ? q.header : '', options, multiSelect: q.multiSelect === true });
	}
	return out;
}
