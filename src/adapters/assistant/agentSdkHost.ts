// The first `AssistantHost` adapter (AD-26, story 8.1): the Claude Agent SDK, embedded in the extension
// host, ported from spike 65 (`scripts/spike/assistant-host/src/extension.ts`). One `query()` per run:
//   - `model`, and `env` built whole (`env.ts`: the base URL and the key only there);
//   - the bundled `rpcn-skills` copy as a local plugin, `skills` limited to the RPCN skills;
//   - `settingSources: []` (the user's own Claude configuration is not loaded), no session kept;
//   - `cwd` the workspace folder;
//   - an in-process tool server, `rpcn`, with `alwaysLoad` (no tools yet: story 8.4 adds them);
//   - a PreToolUse hook and `canUseTool` over the same rules (`rules.ts`); each `AskUserQuestion`
//     becomes a `question` event and waits for `answer`, any other call that asks an `approval` event
//     that waits for `approve`;
//   - a PostToolUse hook on the write tools, which becomes `fileWritten`;
//   - a refusal by the endpoint (401, 403), which Claude Code retries for about three minutes, ends the
//     run at its first `api_retry` with an error (the other retries are progress lines).
// The SDK is ESM only: loaded with a dynamic `import()` on the first run (it is external to the bundle).
// No `vscode` import.

import * as fs from 'fs';
import * as path from 'path';
import type { CanUseTool, HookCallback, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { agentFolders, buildAgentEnv } from './env';
import { progressOf, resultEventOf, retryOf } from './events';
import {
	RPCN_SKILLS, questionsOf, type AssistantAnswers, type AssistantEvent, type AssistantHost, type AssistantHostConfig, type AssistantListener, type AssistantRequest,
} from './host';
import { approvalSummary, canUseToolDecision, preToolUseDecision, type BoundaryContext } from './rules';

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk', { with: { 'resolution-mode': 'import' } });

let loading: Promise<Sdk> | undefined;

/** The SDK module, imported once (ESM from a CommonJS bundle); a failed import is tried again next time (review 16). */
export function loadSdk(importer: () => Promise<Sdk> = () => import('@anthropic-ai/claude-agent-sdk')): Promise<Sdk> {
	if (!loading) {
		const attempt = importer();
		loading = attempt;
		attempt.catch(() => {
			if (loading === attempt) {
				loading = undefined;
			}
		});
	}
	return loading;
}

/** Review 8: no message from the agent this long (while nothing waits on the user) ends the run. */
export const IDLE_TIMEOUT_MS = 5 * 60_000;

/** The idle timeout's error line. */
export function idleTimeoutText(ms: number): string {
	const minutes = ms / 60_000;
	return Number.isInteger(minutes) && minutes >= 1
		? `No answer from the assistant for ${minutes} minute${minutes === 1 ? '' : 's'}: the run was stopped.`
		: `No answer from the assistant for ${Math.round(ms / 1000)} s: the run was stopped.`;
}

/** The in-process tool server's name: its tools are `mcp__rpcn__<name>`. */
export const TOOL_SERVER = 'rpcn';
/** How many turns one run may take. */
export const MAX_TURNS = 80;
const STDERR_CHARS = 300;

/** The prompt one request runs with: the skill named, then the request as typed. */
export function promptFor(request: AssistantRequest): string {
	return `Use the ${request.skill} skill (rpcn-skills:${request.skill}) for this request.\n\n${request.prompt}`;
}

/** The text of an error, without a stack. */
function errorMessage(err: unknown): string {
	if (err instanceof Error) {
		return err.message || err.name;
	}
	return String(err);
}

export class AgentSdkHost implements AssistantHost {
	private abort: AbortController | undefined;
	private readonly pending = new Map<string, (value: unknown) => void>();
	private seq = 0;
	private idle: ReturnType<typeof setTimeout> | undefined;
	private onIdle: (() => void) | undefined;

	constructor(private readonly config: AssistantHostConfig) {}

	async start(request: AssistantRequest, listener: AssistantListener): Promise<void> {
		if (this.abort) {
			listener({ type: 'error', message: 'A run is already going.' });
			return;
		}
		const abort = new AbortController();
		this.abort = abort;
		let ended = false;
		const emit = (event: AssistantEvent) => {
			if (ended) {
				return;
			}
			if (event.type === 'result' || event.type === 'error') {
				ended = true;
			}
			listener(event);
		};
		const ctx: BoundaryContext = { workspace: this.config.workspace, skillsDir: this.config.skillsDir };
		const idleMs = this.config.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
		this.onIdle = () => {
			emit({ type: 'error', message: idleTimeoutText(idleMs) });
			abort.abort();
		};
		this.arm(idleMs);
		try {
			for (const dir of Object.values(agentFolders(this.config.storageDir))) {
				fs.mkdirSync(dir, { recursive: true });
			}
			const sdk = await loadSdk();
			if (abort.signal.aborted) {
				emit({ type: 'result', stopped: true });
				return;
			}
			const options = this.options(sdk, ctx, abort, emit);
			for await (const message of sdk.query({ prompt: promptFor(request), options })) {
				if (abort.signal.aborted) {
					break;
				}
				this.arm(idleMs);
				for (const text of progressOf(message, ctx)) {
					emit({ type: 'progress', text });
				}
				const retry = retryOf(message);
				if (retry?.refused) {
					// Claude Code would retry a refusal for minutes: the run ends now, with its error.
					emit({ type: 'error', message: retry.text });
					abort.abort();
					break;
				}
				if (retry) {
					emit({ type: 'progress', text: retry.text });
				}
				const last = resultEventOf(message);
				if (last) {
					emit(last);
				}
			}
			if (abort.signal.aborted) {
				emit({ type: 'result', stopped: true });
			} else {
				emit({ type: 'error', message: 'The assistant ended without a result.' });
			}
		} catch (err) {
			emit(abort.signal.aborted ? { type: 'result', stopped: true } : { type: 'error', message: errorMessage(err) });
		} finally {
			this.disarm();
			this.onIdle = undefined;
			this.refuseOpen();
			if (this.abort === abort) {
				this.abort = undefined;
			}
		}
	}

	answer(id: string, answers: AssistantAnswers | undefined): void {
		this.settle(id, answers);
	}

	approve(id: string, allow: boolean): void {
		this.settle(id, allow);
	}

	cancel(): void {
		this.abort?.abort();
		this.refuseOpen();
	}

	private settle(id: string, value: unknown): void {
		const resolve = this.pending.get(id);
		if (resolve) {
			this.pending.delete(id);
			resolve(value);
			// The agent's turn again: the idle timer runs once nothing waits on the user.
			if (this.pending.size === 0 && this.abort && !this.abort.signal.aborted) {
				this.arm(this.config.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
			}
		}
	}

	/** (Re)starts the idle timer; not while a question or an approval waits on the user. */
	private arm(ms: number): void {
		this.disarm();
		if (this.pending.size === 0 && this.onIdle) {
			const onIdle = this.onIdle;
			this.idle = setTimeout(() => onIdle(), ms);
		}
	}

	private disarm(): void {
		if (this.idle) {
			clearTimeout(this.idle);
			this.idle = undefined;
		}
	}

	/** Every open question and approval refused (the run stopped or ended). */
	private refuseOpen(): void {
		for (const [id, resolve] of [...this.pending]) {
			this.pending.delete(id);
			resolve(undefined);
		}
	}

	/**
	 * Waits for `answer` / `approve` on `id`; `undefined` once the run is aborted. Review 5: the SDK
	 * aborting this one request withdraws its card (`withdrawn`). Review 26: its abort listener goes once settled.
	 */
	private wait(id: string, signal: AbortSignal, emit: (event: AssistantEvent) => void): Promise<unknown> {
		if (signal.aborted || this.abort?.signal.aborted) {
			return Promise.resolve(undefined);
		}
		return new Promise((resolve) => {
			const onAbort = () => {
				if (this.pending.has(id)) {
					this.settle(id, undefined);
					emit({ type: 'withdrawn', id });
				}
			};
			this.pending.set(id, (value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			});
			this.disarm();
			signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	private options(sdk: Sdk, ctx: BoundaryContext, abort: AbortController, emit: (event: AssistantEvent) => void): Options {
		const preToolUse: HookCallback = async (input) => {
			if (input.hook_event_name !== 'PreToolUse') {
				return {};
			}
			const decision = preToolUseDecision(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, ctx);
			return decision
				? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision.decision, permissionDecisionReason: decision.reason } }
				: {};
		};
		const postToolUse: HookCallback = async (input) => {
			if (input.hook_event_name === 'PostToolUse') {
				const ti = (input.tool_input ?? {}) as Record<string, unknown>;
				const p = ti.file_path ?? ti.notebook_path;
				if (typeof p === 'string') {
					emit({ type: 'fileWritten', path: path.resolve(ctx.workspace, p) });
				}
			}
			return {};
		};
		const canUseTool: CanUseTool = async (toolName, input, opts): Promise<PermissionResult> => {
			const decision = canUseToolDecision(toolName, input, ctx);
			switch (decision.kind) {
				case 'allow':
					return { behavior: 'allow', updatedInput: input };
				case 'deny':
					return { behavior: 'deny', message: decision.message };
				case 'question': {
					const questions = questionsOf(input);
					if (!questions) {
						return { behavior: 'deny', message: 'The question could not be shown.' };
					}
					const id = `question-${++this.seq}`;
					emit({ type: 'question', id, questions });
					const answers = await this.wait(id, opts.signal, emit) as AssistantAnswers | undefined;
					return answers
						? { behavior: 'allow', updatedInput: { ...input, answers } }
						: { behavior: 'deny', message: 'The user dismissed the question.' };
				}
				case 'ask': {
					const id = `approval-${++this.seq}`;
					emit({ type: 'approval', id, tool: toolName, summary: approvalSummary(toolName, input), ...(opts.title ? { detail: opts.title } : {}) });
					const allowed = await this.wait(id, opts.signal, emit);
					return allowed === true ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user denied this.' };
				}
			}
		};
		return {
			model: this.config.model,
			env: buildAgentEnv({ ...this.config }),
			cwd: this.config.workspace,
			plugins: [{ type: 'local', path: this.config.skillsDir }],
			skills: [...RPCN_SKILLS],
			settingSources: [],
			persistSession: false,
			canUseTool,
			hooks: {
				PreToolUse: [{ hooks: [preToolUse] }],
				PostToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [postToolUse] }],
			},
			// alwaysLoad: the tools are in the model's tool list from the first turn, not behind tool search.
			mcpServers: { [TOOL_SERVER]: sdk.createSdkMcpServer({ name: TOOL_SERVER, version: '0.0.1', tools: [], alwaysLoad: true }) },
			abortController: abort,
			maxTurns: MAX_TURNS,
			stderr: (data) => {
				const line = data.trim();
				if (line) {
					this.config.log(`Assistant (agent): ${line.length > STDERR_CHARS ? `${line.slice(0, STDERR_CHARS)}…` : line}`);
				}
			},
		};
	}
}

/** The SDK adapter's factory (`AssistantHostFactory`). */
export const agentSdkHost = (config: AssistantHostConfig): AssistantHost => new AgentSdkHost(config);
