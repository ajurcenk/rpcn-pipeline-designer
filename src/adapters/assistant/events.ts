// The SDK's message stream as the port's events (AD-26, story 8.1; story 8.12: step rows, their results
// and the full reply): each top-level tool call a step, its result that step's end, the model's text the
// reply, the final `result` message the run's `result` or `error`.
// Plain functions over the messages' shapes, so they are tested without the SDK. No `vscode` or SDK import.

import * as path from 'path';
import { SHELL_LABEL, SKILL_READ_LABEL } from '../../shared/assistantProtocol';
import { STEP_RESULT_CHARS, type AssistantEvent } from './host';
import { isInside, QUESTION_TOOL } from './rules';

export interface ProgressContext {
	readonly workspace: string;
	readonly skillsDir: string;
}

/** A progress line's longest text. */
export const PROGRESS_CHARS = 200;

const RPCN_CHECK_SUBCOMMAND = /rpcn_check\.py\s+([a-z][a-z-]*)/;

function clip(text: string): string {
	const one = text.replace(/\s+/g, ' ').trim();
	return one.length > PROGRESS_CHARS ? `${one.slice(0, PROGRESS_CHARS - 1)}…` : one;
}

/** A path as the view shows it: inside the workspace relative, inside the skills `rpcn-skills/…`, else its name. */
export function displayPath(p: unknown, ctx: ProgressContext): string {
	if (typeof p !== 'string' || p === '') {
		return '';
	}
	const abs = path.resolve(ctx.workspace, p);
	if (isInside(ctx.skillsDir, abs)) {
		return path.posix.join('rpcn-skills', path.relative(ctx.skillsDir, abs).split(path.sep).join('/'));
	}
	if (isInside(ctx.workspace, abs)) {
		return path.relative(ctx.workspace, abs).split(path.sep).join('/') || '.';
	}
	return path.basename(abs);
}

/** Whether `p` is an absolute or workspace-relative path inside the skills copy in use. */
function inSkills(p: unknown, ctx: ProgressContext): boolean {
	return typeof p === 'string' && p !== '' && isInside(ctx.skillsDir, path.resolve(ctx.workspace, p));
}

/** One tool call's progress line. */
export function toolProgress(name: string, input: Record<string, unknown>, ctx: ProgressContext): string {
	switch (name) {
		case 'Skill': {
			const skill = String(input.skill ?? input.command ?? '').replace(/^.*:/, '');
			return skill ? `Running the ${skill} skill` : 'Running a skill';
		}
		case 'Bash': {
			const command = String(input.command ?? '');
			const check = RPCN_CHECK_SUBCOMMAND.exec(command);
			// Manual check 2: a short label (the command is the step's detail), so repeats group.
			return check ? `Checking with rpcn_check ${check[1]}` : SHELL_LABEL;
		}
		case 'Read':
			// Manual check 1: the skills' own references are one folded row in the view, not their paths.
			return inSkills(input.file_path, ctx) ? SKILL_READ_LABEL : `Reading ${displayPath(input.file_path, ctx)}`;
		case 'Glob':
		case 'Grep':
			return inSkills(input.path, ctx) || (name === 'Glob' && inSkills(input.pattern, ctx)) ? SKILL_READ_LABEL : `Searching ${displayPath(input.path, ctx) || 'the workspace'}`;
		case 'Write':
		case 'Edit':
		case 'MultiEdit':
			return `Writing ${displayPath(input.file_path, ctx)}`;
		case 'NotebookEdit':
			return `Writing ${displayPath(input.notebook_path, ctx)}`;
		case QUESTION_TOOL: {
			const n = Array.isArray(input.questions) ? input.questions.length : 0;
			return `Asking ${n} question${n === 1 ? '' : 's'}`;
		}
		default:
			return `Using ${name}`;
	}
}

type Block = Record<string, unknown> & { readonly type?: unknown };

/** Story 8.12: a short result of a tool call's output (its text), by tool name; none: no summariser. */
export type StepSummariser = (output: string, input: Record<string, unknown>) => string;

const countOf = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Story 8.12: the step rows' summarisers (8.4 adds the rpcn tools'); a tool without one shows no result. */
export const STEP_SUMMARISERS: Readonly<Record<string, StepSummariser>> = {
	Read: (output) => countOf(output.split(/\r?\n/).filter((l) => l.trim() !== '').length, 'line', 'lines'),
	Glob: (output) => (/^no files found/i.test(output.trim()) ? '0 files' : countOf(output.split(/\r?\n/).filter((l) => l.trim() !== '').length, 'file', 'files')),
	Write: () => 'written',
	Edit: () => 'edited',
	MultiEdit: () => 'edited',
	NotebookEdit: () => 'edited',
};

/** Story 8.12: a text on one line, at most `max` characters. */
export function oneLine(text: string, max: number): string {
	const one = text.replace(/\s+/g, ' ').trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The text of a `tool_result` block's content (a string, or text blocks). */
function resultText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return (content as Block[]).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n');
	}
	return '';
}

/** Story 8.12: a step's short result: the summariser's (at most `STEP_RESULT_CHARS`); failed: the error's first line. */
export function stepResult(tool: string, input: Record<string, unknown>, output: string, ok: boolean): string {
	if (!ok) {
		const first = output.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
		return oneLine(first.replace(/^<tool_use_error>|<\/tool_use_error>$/g, ''), STEP_RESULT_CHARS);
	}
	const summarise = STEP_SUMMARISERS[tool];
	if (!summarise) {
		return '';
	}
	try {
		return oneLine(summarise(output, input), STEP_RESULT_CHARS);
	} catch {
		return '';
	}
}

/**
 * Story 8.12: the SDK's stream as the port's events, one message at a time. `init` is a progress line
 * naming the model; each top-level `tool_use` a `step` (subagent turns, with `parent_tool_use_id`, give
 * none), and the `tool_result` that answers it (matched by `tool_use_id`) its `stepDone`; each top-level
 * text block a `reply`. It keeps the open steps' tools, so it is one per run.
 */
export class StreamMapper {
	private readonly open = new Map<string, { readonly name: string; readonly input: Record<string, unknown> }>();

	constructor(private readonly ctx: ProgressContext) {}

	map(message: unknown): AssistantEvent[] {
		const m = message as Record<string, unknown> | null;
		if (!m || typeof m !== 'object') {
			return [];
		}
		if (m.type === 'system' && m.subtype === 'init') {
			return [{ type: 'progress', text: `Started (${typeof m.model === 'string' ? m.model : 'model'})` }];
		}
		if ((m.type !== 'assistant' && m.type !== 'user') || m.parent_tool_use_id) {
			return [];
		}
		const content = (m.message as { content?: unknown } | undefined)?.content;
		if (!Array.isArray(content)) {
			return [];
		}
		const events: AssistantEvent[] = [];
		for (const b of content as Block[]) {
			if (m.type === 'assistant' && b?.type === 'text' && typeof b.text === 'string') {
				if (b.text.trim() !== '') {
					events.push({ type: 'reply', text: b.text });
				}
			} else if (m.type === 'assistant' && b?.type === 'tool_use' && typeof b.name === 'string' && typeof b.id === 'string') {
				const input = (b.input ?? {}) as Record<string, unknown>;
				this.open.set(b.id, { name: b.name, input });
				const label = toolProgress(b.name, input, this.ctx);
				const detail = label === SHELL_LABEL ? clip(String(input.command ?? '')) : '';
				events.push({ type: 'step', id: b.id, label, ...(detail ? { detail } : {}) });
			} else if (m.type === 'user' && b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
				const call = this.open.get(b.tool_use_id);
				if (call) {
					this.open.delete(b.tool_use_id);
					const ok = b.is_error !== true;
					events.push({ type: 'stepDone', id: b.tool_use_id, ok, result: stepResult(call.name, call.input, resultText(b.content), ok) });
				}
			}
		}
		return events;
	}
}

/** HTTP statuses a retry cannot change: the key or the model refused (ADP and Anthropic alike). */
const REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * Claude Code's `api_retry` message: a refusal (401, 403), which it would retry for minutes, ends the
 * run with an error now (`refused`); any other failure is a progress line while it retries.
 */
export function retryOf(message: unknown): { readonly refused: boolean; readonly text: string } | undefined {
	const m = message as Record<string, unknown> | null;
	if (!m || m.type !== 'system' || m.subtype !== 'api_retry') {
		return undefined;
	}
	const status = typeof m.error_status === 'number' ? m.error_status : null;
	const reason = typeof m.error === 'string' ? m.error : '';
	if (status !== null && REFUSED_STATUSES.has(status)) {
		return { refused: true, text: `The endpoint refused the request (HTTP ${status}${reason ? `, ${reason}` : ''}).` };
	}
	const attempt = typeof m.attempt === 'number' ? m.attempt : undefined;
	const max = typeof m.max_retries === 'number' ? m.max_retries : undefined;
	const what = status !== null ? `answered HTTP ${status}` : 'did not answer';
	return { refused: false, text: `The endpoint ${what}; retrying${attempt !== undefined ? ` (attempt ${attempt}${max !== undefined ? ` of ${max}` : ''})` : ''}` };
}

/** The run's last event from the SDK's `result` message; `undefined` for any other message. */
export function resultEventOf(message: unknown): AssistantEvent | undefined {
	const m = message as Record<string, unknown> | null;
	if (!m || m.type !== 'result') {
		return undefined;
	}
	const text = typeof m.result === 'string' ? m.result : undefined;
	if (m.is_error === true || m.subtype !== 'success') {
		const errors = Array.isArray(m.errors) ? (m.errors as unknown[]).filter((e): e is string => typeof e === 'string') : [];
		const why = [text, ...errors].filter((t): t is string => !!t && t.trim() !== '').join('; ');
		return { type: 'error', message: why || `The assistant stopped (${String(m.subtype ?? 'error')}).` };
	}
	return { type: 'result', stopped: false, ...(text ? { text } : {}) };
}
