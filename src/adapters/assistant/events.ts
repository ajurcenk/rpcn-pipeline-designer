// The SDK's message stream as the port's events (AD-26, story 8.1): each assistant turn's tool calls
// and text become short progress lines, the final `result` message the run's `result` or `error`.
// Plain functions over the messages' shapes, so they are tested without the SDK. No `vscode` or SDK import.

import * as path from 'path';
import type { AssistantEvent } from './host';
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
			return check ? `Checking with rpcn_check ${check[1]}` : `Running a shell command: ${clip(command)}`;
		}
		case 'Read':
			return `Reading ${displayPath(input.file_path, ctx)}`;
		case 'Glob':
		case 'Grep':
			return `Searching ${displayPath(input.path, ctx) || 'the workspace'}`;
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

/** The progress lines of one stream message (none for most). */
export function progressOf(message: unknown, ctx: ProgressContext): string[] {
	const m = message as Record<string, unknown> | null;
	if (!m || typeof m !== 'object') {
		return [];
	}
	if (m.type === 'system' && m.subtype === 'init') {
		return [`Started (${typeof m.model === 'string' ? m.model : 'model'})`];
	}
	if (m.type !== 'assistant' || m.parent_tool_use_id) {
		return [];
	}
	const content = (m.message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) {
		return [];
	}
	const lines: string[] = [];
	for (const b of content as Block[]) {
		if (b?.type === 'text' && typeof b.text === 'string') {
			const first = b.text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
			if (first) {
				lines.push(clip(first));
			}
		} else if (b?.type === 'tool_use' && typeof b.name === 'string') {
			lines.push(toolProgress(b.name, (b.input ?? {}) as Record<string, unknown>, ctx));
		}
	}
	return lines;
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
