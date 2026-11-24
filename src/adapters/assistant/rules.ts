// The assistant's boundaries in story 8.1 (AD-26; story 8.5 completes them), ported from spike 65
// (`scripts/spike/assistant-host/src/extension.ts`). One set of rules for the PreToolUse hook and
// `canUseTool` alike:
//   - Bash: allowed without asking only for `uv run <script> <subcommand> …` with no shell
//     metacharacter, where the script is an absolute path that resolves (symlinks followed) to an
//     `rpcn_check.py` inside the bundled skills, and every path argument resolves inside the workspace
//     or the skills. Anything else asks.
//   - Reads (Read, Glob, Grep) inside the bundled skills are allowed without asking.
//   - Writes (Write, Edit, MultiEdit, NotebookEdit) outside the workspace folder are denied, without
//     asking. Inside it, the stage's own artifact (a `*.design.md` note) is written without asking;
//     any other write asks.
//   - The extension's own in-process tools (`mcp__rpcn__*`, none yet) are allowed.
//   - `AskUserQuestion` becomes a question card.
// No `vscode` or SDK import.

import * as fs from 'fs';
import * as path from 'path';

export interface BoundaryContext {
	/** The workspace folder (the agent's `cwd`). */
	readonly workspace: string;
	/** The bundled skills copy. */
	readonly skillsDir: string;
}

const RPCN_CHECK = /^uv run (\S+\/rpcn_check\.py) [a-z][a-z-]*(?:\s|$)/;
/** Shell metacharacters: with any of these a command can chain, substitute, expand or redirect. */
const SHELL_META = /[;&|`$<>(){}\\\n\r*?![\]~#]/;
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);
/** The Design stage's own artifact (AD-26: a stage writes its own artifact without asking). */
const STAGE_ARTIFACT = /\.design\.md$/;
export const QUESTION_TOOL = 'AskUserQuestion';
export const OWN_TOOL_PREFIX = 'mcp__rpcn__';

/** `p`'s real path: its nearest existing parent's, resolved, with the rest appended (a symlink out does not stay inside). */
function realish(p: string): string {
	const abs = path.resolve(p);
	for (let d = abs; ; d = path.dirname(d)) {
		if (fs.existsSync(d)) {
			try {
				return path.join(fs.realpathSync(d), path.relative(d, abs));
			} catch {
				return abs;
			}
		}
		if (path.dirname(d) === d) {
			return abs;
		}
	}
}

/** Whether `p` (relative paths against `root`) is `root` or inside it, symlinks followed. */
export function isInside(root: string, p: string): boolean {
	if (typeof p !== 'string' || p === '') {
		return false;
	}
	const top = realish(root);
	const real = realish(path.resolve(root, p));
	return real === top || real.startsWith(top + path.sep);
}

/** Whether `command` is the skills' own `rpcn_check` call (the one shell rule). */
export function isRpcnCheckCall(command: unknown, cwd: string, skillsDir: string): boolean {
	if (typeof command !== 'string') {
		return false;
	}
	const c = command.trim();
	if (SHELL_META.test(c)) {
		return false;
	}
	const m = RPCN_CHECK.exec(c);
	// Review 18: the script path is absolute (as the skills run it), never relative to the cwd.
	if (!m || !path.isAbsolute(m[1])) {
		return false;
	}
	let script: string;
	let root: string;
	try {
		script = fs.realpathSync(m[1]);
		root = fs.realpathSync(path.resolve(skillsDir));
	} catch {
		return false;
	}
	if (path.basename(script) !== 'rpcn_check.py' || !script.startsWith(root + path.sep)) {
		return false;
	}
	// Review 1: every argument that is a path (absolute, or with a `/` or `..`; an option's `=` value too)
	// resolves inside the workspace or the skills copy; one that does not makes the call ask.
	const args = c.slice(m[0].length).split(/\s+/).filter((a) => a !== '');
	return args.every((arg) => {
		const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
		if (!path.isAbsolute(value) && !value.includes('/') && !value.split(/[\\/]/).includes('..') && value !== '..') {
			return true;
		}
		const abs = path.resolve(cwd, value);
		return isInside(cwd, abs) || isInside(skillsDir, abs);
	});
}

const pathOf = (input: Record<string, unknown>): unknown => input.file_path ?? input.notebook_path ?? input.path;

export type HookDecision = { readonly decision: 'allow' | 'deny'; readonly reason: string } | undefined;

/** The PreToolUse hook's decision; `undefined`: none (the call goes on to the permission check). */
export function preToolUseDecision(tool: string, input: Record<string, unknown>, ctx: BoundaryContext): HookDecision {
	if (tool === 'Bash' && isRpcnCheckCall(input.command, ctx.workspace, ctx.skillsDir)) {
		return { decision: 'allow', reason: 'the skills\' own rpcn_check call' };
	}
	if (WRITE_TOOLS.has(tool)) {
		const p = pathOf(input);
		return typeof p === 'string' && isInside(ctx.workspace, p) ? undefined : { decision: 'deny', reason: 'writes stay inside the workspace folder' };
	}
	if (tool.startsWith(OWN_TOOL_PREFIX)) {
		return { decision: 'allow', reason: 'the extension\'s own tools' };
	}
	if (READ_TOOLS.has(tool)) {
		const p = pathOf(input);
		if (typeof p === 'string' && path.isAbsolute(p) && isInside(ctx.skillsDir, p)) {
			return { decision: 'allow', reason: 'a read inside the bundled skills' };
		}
	}
	return undefined;
}

export type ToolDecision =
	| { readonly kind: 'question' }
	| { readonly kind: 'allow' }
	| { readonly kind: 'deny'; readonly message: string }
	| { readonly kind: 'ask' };

/** `canUseTool`'s decision: answer a question, allow, deny, or ask the user. */
export function canUseToolDecision(tool: string, input: Record<string, unknown>, ctx: BoundaryContext): ToolDecision {
	if (tool === QUESTION_TOOL) {
		return { kind: 'question' };
	}
	if (WRITE_TOOLS.has(tool)) {
		const p = pathOf(input);
		if (typeof p !== 'string' || !isInside(ctx.workspace, p)) {
			return { kind: 'deny', message: 'Writes stay inside the workspace folder.' };
		}
		return tool === 'Write' && STAGE_ARTIFACT.test(p) ? { kind: 'allow' } : { kind: 'ask' };
	}
	const hook = preToolUseDecision(tool, input, ctx);
	if (hook?.decision === 'allow') {
		return { kind: 'allow' };
	}
	return { kind: 'ask' };
}

/** A short description of a call that asks, for its approval prompt (the vscode glue masks it). */
export function approvalSummary(tool: string, input: Record<string, unknown>): string {
	if (tool === 'Bash') {
		return `run \`${String(input.command ?? '').slice(0, 200)}\``;
	}
	const p = pathOf(input);
	if (WRITE_TOOLS.has(tool) && typeof p === 'string') {
		return `write ${p}`;
	}
	if (typeof p === 'string') {
		return `use ${tool} on ${p}`;
	}
	return `use ${tool}`;
}
