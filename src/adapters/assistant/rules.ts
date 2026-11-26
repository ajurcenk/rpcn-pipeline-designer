// The assistant's boundaries (AD-26; story 8.1, completed by story 8.5), ported from spike 65
// (`scripts/spike/assistant-host/src/extension.ts`). One decision, `decide`, which the PreToolUse hook
// and `canUseTool` both wrap, so the same call gets the same answer from either:
//   - Bash: allowed without asking only for `uv run <script> <subcommand> …` with no shell
//     metacharacter, where the script is an absolute path that resolves (symlinks followed) to an
//     `rpcn_check.py` inside the skills copy in use, and every path argument resolves inside the
//     workspace or the skills. Anything else asks, with its `shellKey` (or none: it always asks).
//   - Reads (Read, Glob, Grep) inside the workspace or the skills copy, or the agent's own
//     `<CLAUDE_CONFIG_DIR>/projects/` (tool results Claude Code spilled there), are allowed without asking;
//     others ask. Writes there are outside the workspace: denied. Claude Code's own Skill, TodoWrite and ToolSearch are allowed.
//   - Writes (Write, Edit, MultiEdit, NotebookEdit) outside the workspace folder are denied, without
//     asking. Inside it, the running stage's own artifact (`STAGE_ARTIFACTS`, by skill: for
//     `rpcn-design`, a Write, Edit or MultiEdit of a `*.design.md`) is written without asking; any
//     other write asks, with the tool's name as its session key (under `.git/` or `.vscode/`, or to
//     `.envrc` or `.env*`: with none).
//   - The extension's own in-process tools (`mcp__rpcn__*`) are allowed.
//   - `AskUserQuestion` becomes a question card.
//   - Anything else (WebFetch, WebSearch, Task, unknown tools) asks, with no session key.
// The hook says `ask` for every ask, so none is left to Claude Code's own allow rules.
// The session memory (which keys the user allowed for this session) is the view's; the adapter asks it.
// No `vscode` or SDK import.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface BoundaryContext {
	/** The workspace folder (the agent's `cwd`). */
	readonly workspace: string;
	/** The skills copy in use. */
	readonly skillsDir: string;
	/** Story 8.5: the running stage's skill (its own artifact is written without asking). */
	readonly skill?: string;
	/**
	 * Manual check 1 of 8.5: the agent's own Claude Code config folder (its `CLAUDE_CONFIG_DIR`). Claude
	 * Code spills large tool results under its `projects/` folder and reads them back: those reads are allowed.
	 */
	readonly agentConfigDir?: string;
}

const RPCN_CHECK = /^uv run (\S+\/rpcn_check\.py) [a-z][a-z-]*(?:\s|$)/;
/** Shell metacharacters: with any of these a command can chain, substitute, expand or redirect. */
const SHELL_META = /[;&|`$<>(){}\\\n\r*?![\]~#]/;
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);
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

/**
 * Story 8.5: each stage's own artifact, by skill: the write tools that may write it without asking, and
 * the file name it has (inside the workspace). Story 8.7 adds `rpcn-author`'s files.
 */
export const STAGE_ARTIFACTS: Readonly<Record<string, readonly { readonly tools: ReadonlySet<string>; readonly name: RegExp }[]>> = {
	'rpcn-design': [{ tools: new Set(['Write', 'Edit', 'MultiEdit']), name: /\.design\.md$/ }],
};

/** Whether `p` (a workspace path) is the running stage's own artifact for `tool`. */
function isStageArtifact(tool: string, p: string, skill: string | undefined): boolean {
	return (STAGE_ARTIFACTS[skill ?? ''] ?? []).some((a) => a.tools.has(tool) && a.name.test(path.basename(p)));
}

/**
 * The one decision for a tool call (story 8.5): answer a question, allow, deny, or ask the user. An ask
 * carries the call's session key (`shellKey` for a shell command, the tool's name for a write inside the
 * workspace), or `null` when the call always asks. The session memory itself is the adapter's.
 */
export type ToolDecision =
	| { readonly kind: 'question' }
	| { readonly kind: 'allow'; readonly reason: string }
	| { readonly kind: 'deny'; readonly message: string }
	| { readonly kind: 'ask'; readonly sessionKey: string | null };

/**
 * Claude Code's own tools the run needs, allowed with no card: Skill (the `skills` allowlist limits it
 * to the RPCN skills), TodoWrite (its task list, no effect outside the run), ToolSearch (looks up tools).
 */
export const INTERNAL_TOOLS: ReadonlySet<string> = new Set(['Skill', 'TodoWrite', 'ToolSearch']);

/**
 * Story 8.5 (amended): a workspace write that always asks, with no session choice: under `.git/` or
 * `.vscode/` (hooks, tasks that run code), or to `.envrc` or a `.env*` file.
 */
export function isRiskyWrite(workspace: string, p: string): boolean {
	const rel = path.relative(realish(workspace), realish(path.resolve(workspace, p)));
	const parts = rel.split(path.sep);
	const name = parts[parts.length - 1] ?? '';
	return parts.slice(0, -1).some((d) => d === '.git' || d === '.vscode') || name === '.git' || name === '.vscode' || name === '.envrc' || name.startsWith('.env');
}

/** The folder part of a glob pattern (up to its first wildcard). */
function globBase(pattern: string): string {
	const at = pattern.search(/[*?[{]/);
	return at < 0 ? pattern : pattern.slice(0, at);
}

/**
 * Story 8.5 (amended): whether a Read, Glob or Grep stays inside the workspace or the skills copy (no
 * path: the workspace), or (manual check 1) the agent's own `<CLAUDE_CONFIG_DIR>/projects/` (spilled tool results).
 */
function readStaysInside(tool: string, input: Record<string, unknown>, ctx: BoundaryContext): boolean {
	const projects = ctx.agentConfigDir !== undefined ? path.join(ctx.agentConfigDir, 'projects') : undefined;
	const inside = (p: string) => isInside(ctx.workspace, p) || isInside(ctx.skillsDir, path.resolve(ctx.workspace, p))
		|| (projects !== undefined && path.isAbsolute(p) && isInside(projects, p));
	const targets: unknown[] = tool === 'Read' ? [input.file_path] : [input.path ?? ctx.workspace];
	if (tool === 'Glob' && typeof input.pattern === 'string') {
		const base = globBase(expandHome(input.pattern));
		if (base !== '') {
			targets.push(base);
		}
	}
	return targets.every((t) => typeof t === 'string' && t !== '' && inside(expandHome(t)));
}

/** `~` or a leading `~/` as the real home folder (nothing else). */
function expandHome(p: string, home: string = os.homedir()): string {
	return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

export function decide(tool: string, input: Record<string, unknown>, ctx: BoundaryContext): ToolDecision {
	if (tool === QUESTION_TOOL) {
		return { kind: 'question' };
	}
	if (tool === 'Bash') {
		return isRpcnCheckCall(input.command, ctx.workspace, ctx.skillsDir)
			? { kind: 'allow', reason: 'the skills\' own rpcn_check call' }
			: { kind: 'ask', sessionKey: typeof input.command === 'string' ? shellKey(input.command, ctx.workspace, ctx.skillsDir) : null };
	}
	if (WRITE_TOOLS.has(tool)) {
		const p = pathOf(input);
		if (typeof p !== 'string' || !isInside(ctx.workspace, p)) {
			return { kind: 'deny', message: 'Writes stay inside the workspace folder.' };
		}
		if (isRiskyWrite(ctx.workspace, p)) {
			return { kind: 'ask', sessionKey: null };
		}
		return isStageArtifact(tool, p, ctx.skill) ? { kind: 'allow', reason: 'the stage\'s own artifact' } : { kind: 'ask', sessionKey: tool };
	}
	if (tool.startsWith(OWN_TOOL_PREFIX)) {
		return { kind: 'allow', reason: 'the extension\'s own tools' };
	}
	if (INTERNAL_TOOLS.has(tool)) {
		return { kind: 'allow', reason: 'Claude Code\'s own tool' };
	}
	if (READ_TOOLS.has(tool) && readStaysInside(tool, input, ctx)) {
		return { kind: 'allow', reason: 'a read inside the workspace or the skills copy' };
	}
	return { kind: 'ask', sessionKey: null };
}

export type HookDecision = { readonly decision: 'allow' | 'deny' | 'ask'; readonly reason: string } | undefined;

/**
 * The PreToolUse hook's decision (`decide`'s). Story 8.5: every ask is `ask`, so it reaches
 * `canUseTool` (its card) even when Claude Code would allow it unasked (a command it deems read-only, a
 * workspace read). A question is `undefined`: `canUseTool` turns it into cards.
 */
export function preToolUseDecision(tool: string, input: Record<string, unknown>, ctx: BoundaryContext): HookDecision {
	const d = decide(tool, input, ctx);
	switch (d.kind) {
		case 'allow':
			return { decision: 'allow', reason: d.reason };
		case 'deny':
			return { decision: 'deny', reason: d.message };
		case 'ask':
			return { decision: 'ask', reason: 'this call asks first' };
		default:
			return undefined;
	}
}

/** `canUseTool`'s decision: `decide`'s. */
export function canUseToolDecision(tool: string, input: Record<string, unknown>, ctx: BoundaryContext): ToolDecision {
	return decide(tool, input, ctx);
}

// ---- Story 8.5: the shell key -------------------------------------------------------------------

/** The programs a session key may name (the read-only list); `rpk` and `redpanda-connect` only with their read-only subcommands. */
export const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set([
	'rpk', 'redpanda-connect', 'strings', 'grep', 'egrep', 'head', 'tail', 'cut', 'sort', 'uniq', 'wc', 'jq', 'cat', 'ls', 'echo', 'printf', 'python3',
]);
const CONNECT_SUBCOMMANDS = ['list', 'lint', 'blobl', 'version', 'fields'];
/** `rpk`'s read-only subcommands, as its key words after `rpk`. */
const RPK_SUBCOMMANDS: ReadonlySet<string> = new Set([
	...CONNECT_SUBCOMMANDS.map((c) => `connect ${c}`), 'cluster info', 'cluster health', 'topic list', 'topic describe', 'version',
]);
const REDPANDA_CONNECT_SUBCOMMANDS: ReadonlySet<string> = new Set(CONNECT_SUBCOMMANDS);

type Token =
	/** `expands`: it holds a `$` expansion (unquoted or in double quotes). */
	| { readonly kind: 'word'; readonly text: string; readonly raw: string; readonly expands: boolean }
	| { readonly kind: 'pipe' }
	/** A redirect: its operator, and its target (`undefined`: a dup such as `2>&1`, or an input redirect's file). */
	| { readonly kind: 'redirect'; readonly op: string; readonly target?: string };

/**
 * The command's tokens (quote-aware: single quotes literal, double quotes with `\\` escapes, `\\`
 * outside quotes), or `null` when it holds anything that makes it ask always: `;`, `&&`, `||`, a lone
 * `&`, a newline outside quotes, backticks, `$(`, `<(`, `>(`, or an input redirect.
 */
function tokenize(command: string): Token[] | null {
	const tokens: Token[] = [];
	let i = 0;
	const n = command.length;
	const isSpace = (c: string) => c === ' ' || c === '\t';
	const readWord = (): { text: string; raw: string; expands: boolean } | null => {
		let text = '';
		let expands = false;
		const from = i;
		while (i < n) {
			const c = command[i];
			if (isSpace(c) || c === '\n' || c === '\r' || c === '|' || c === '&' || c === ';' || c === '<' || c === '>') {
				break;
			}
			if (c === '`' || (c === '$' && command[i + 1] === '(')) {
				return null;
			}
			if (c === '$') {
				expands = true;
			}
			if (c === '\\') {
				if (i + 1 < n) {
					text += command[i + 1];
				}
				i += 2;
				continue;
			}
			if (c === "'") {
				const end = command.indexOf("'", i + 1);
				if (end < 0) {
					return null;
				}
				text += command.slice(i + 1, end);
				i = end + 1;
				continue;
			}
			if (c === '"') {
				i++;
				for (;;) {
					if (i >= n) {
						return null;
					}
					const d = command[i];
					if (d === '"') {
						i++;
						break;
					}
					if (d === '`' || (d === '$' && command[i + 1] === '(')) {
						return null;
					}
					if (d === '$') {
						expands = true;
					}
					if (d === '\\' && i + 1 < n && '"\\$`\n'.includes(command[i + 1])) {
						text += command[i + 1];
						i += 2;
						continue;
					}
					text += d;
					i++;
				}
				continue;
			}
			text += c;
			i++;
		}
		return { text, raw: command.slice(from, i), expands };
	};
	while (i < n) {
		const c = command[i];
		if (isSpace(c)) {
			i++;
			continue;
		}
		if (c === '\n' || c === '\r' || c === ';') {
			return null;
		}
		if (c === '|') {
			if (command[i + 1] === '|') {
				return null;
			}
			// `|&` pipes stderr too: still a pipe.
			i += command[i + 1] === '&' ? 2 : 1;
			tokens.push({ kind: 'pipe' });
			continue;
		}
		// A redirect, with an optional fd number before it (`2>`, `2>>`, `2>&1`) or `&>` / `&>>`.
		const m = /^(\d*>>?|&>>?|\d*<)(&\d+|&-)?/.exec(command.slice(i));
		if (c === '&' && !m) {
			// `&&`, or a lone `&` (background).
			return null;
		}
		if (m && (/^\d/.test(c) ? /^\d+[<>]/.test(command.slice(i)) : c === '>' || c === '<' || c === '&')) {
			const op = m[1];
			if (op.endsWith('<')) {
				// An input redirect, `<(` or a here-document.
				return null;
			}
			if (command[i + m[0].length] === '(') {
				return null;
			}
			i += m[0].length;
			if (m[2]) {
				tokens.push({ kind: 'redirect', op: op + m[2] });
				continue;
			}
			while (i < n && isSpace(command[i])) {
				i++;
			}
			const target = readWord();
			if (!target || target.text === '') {
				return null;
			}
			tokens.push({ kind: 'redirect', op, target: target.text });
			continue;
		}
		const word = readWord();
		if (!word) {
			return null;
		}
		tokens.push({ kind: 'word', ...word });
	}
	return tokens;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

/** Where a shell key is read: the workspace and the skills copy (paths must stay inside), the home folder (`~`). */
export interface ShellKeyContext {
	readonly workspace: string;
	readonly skillsDir?: string;
	readonly home?: string;
}

type Word = { readonly text: string; readonly raw: string; readonly expands: boolean };

/**
 * The words of a stage from its program on, the `timeout <n>` and bare `env` wrappers skipped; `null`
 * (no key): a leading assignment or `env VAR=…`, a wrapper it cannot read, or a program that is not a
 * bare name or an absolute or `~/` path that exists outside the workspace (story 8.5, amended).
 */
function programWords(words: readonly Word[], ctx: ShellKeyContext): Word[] | null {
	let k = 0;
	for (;;) {
		const w = words[k];
		if (!w) {
			return null;
		}
		if (ASSIGNMENT.test(w.raw)) {
			return null;
		}
		if (w.raw === 'env') {
			k++;
			// A bare `env` only: an option (`-S` can hide a command line) or an assignment means no key.
			if (words[k] && (words[k].text.startsWith('-') || ASSIGNMENT.test(words[k].raw))) {
				return null;
			}
			continue;
		}
		if (w.raw === 'timeout') {
			k++;
			while (k < words.length && words[k].text.startsWith('-')) {
				const opt = words[k].text;
				k += opt === '-s' || opt === '-k' || opt === '--signal' || opt === '--kill-after' ? 2 : 1;
			}
			if (!words[k] || !DURATION.test(words[k].text)) {
				return null;
			}
			k++;
			continue;
		}
		break;
	}
	const program = words[k];
	// A quoted `~` (or `~user`) is not the home folder the shell would give.
	if (program.text.startsWith('~') && !program.raw.startsWith('~/')) {
		return null;
	}
	if (program.expands) {
		return null;
	}
	if (program.text.includes('/')) {
		const abs = expandHome(program.text, ctx.home);
		if (!path.isAbsolute(abs) || isInside(ctx.workspace, abs)) {
			return null;
		}
		try {
			if (!fs.statSync(abs).isFile()) {
				return null;
			}
		} catch {
			return null;
		}
	}
	return words.slice(k);
}

/**
 * Story 8.5 (amended): whether an argument may go in a remembered call: no `$` expansion, and when it is
 * path-like (absolute, `~`, a `/`, `.` or `..`; an option's `=` value too) it resolves inside the
 * workspace or the skills copy.
 */
function argStaysInside(arg: Word, ctx: ShellKeyContext): boolean {
	if (arg.expands) {
		return false;
	}
	const value = arg.text.startsWith('-') && arg.text.includes('=') ? arg.text.slice(arg.text.indexOf('=') + 1) : arg.text;
	const pathLike = value.startsWith('~') || path.isAbsolute(value) || value.includes('/') || value === '.' || value === '..' || value.startsWith('../');
	if (!pathLike) {
		return true;
	}
	if (value.startsWith('~') && value !== '~' && !value.startsWith('~/')) {
		return false;
	}
	const abs = path.resolve(ctx.workspace, expandHome(value, ctx.home));
	return isInside(ctx.workspace, abs) || (ctx.skillsDir !== undefined && isInside(ctx.skillsDir, abs));
}

/** The leading words of `args` that are no option, at most `max`. */
function leadingWords(args: readonly string[], max: number): string[] {
	const out: string[] = [];
	for (const a of args) {
		if (out.length >= max || a.startsWith('-')) {
			break;
		}
		out.push(a);
	}
	return out;
}

/** Whether any argument is one of `options` (or `--option=…`), or a short option cluster holding one of `shortLetters`. */
function hasOption(args: readonly string[], options: readonly string[], shortLetters = ''): boolean {
	return args.some((a) => options.some((o) => a === o || (o.startsWith('--') && a.startsWith(`${o}=`)))
		|| (shortLetters !== '' && /^-[^-]/.test(a) && [...a.slice(1)].some((c) => shortLetters.includes(c))));
}

/**
 * One stage's key word (its program, plus `rpk`'s or `redpanda-connect`'s subcommand), or `null` when
 * it is not on the read-only list, or its options write, follow, serve or read other files. `index`:
 * the stage's place in the pipeline.
 */
function stageKey(words: readonly string[], index: number): string | null {
	const [first, ...args] = words;
	const program = path.posix.basename(first);
	if (!READ_ONLY_PROGRAMS.has(program)) {
		return null;
	}
	switch (program) {
		case 'rpk':
		case 'redpanda-connect': {
			const sub = leadingWords(args, program === 'rpk' ? 2 : 1);
			const connect = program === 'redpanda-connect' || sub[0] === 'connect';
			if (connect && hasOption(args, ['-w', '--watch'])) {
				return null;
			}
			// `blobl server` serves; plain `blobl` maps its input.
			if (sub[sub.length - 1] === 'blobl' && args.includes('server')) {
				return null;
			}
			const known = program === 'rpk' ? RPK_SUBCOMMANDS : REDPANDA_CONNECT_SUBCOMMANDS;
			return known.has(sub.join(' ')) ? [program, ...sub].join(' ') : null;
		}
		case 'python3':
			// Only `python3 -I -c <code>` reading a pipe (not the first stage); its code is not checked (the user's decision).
			return index > 0 && args.length === 3 && args[0] === '-I' && args[1] === '-c' ? program : null;
		case 'sort':
			// `-o` writes a file; `--compress-program` runs one; `-T` writes temporary files where it is told.
			return hasOption(args, ['-o', '--output', '--compress-program', '-T', '--temporary-directory'], 'oT') ? null : program;
		case 'uniq':
			// `uniq <in> <out>` writes its second file.
			return args.filter((a) => !a.startsWith('-')).length > 1 ? null : program;
		case 'tail':
			// Following never ends.
			return hasOption(args, ['-f', '-F', '--follow', '--retry'], 'fF') ? null : program;
		case 'wc':
			return hasOption(args, ['--files0-from']) ? null : program;
		case 'jq':
			return hasOption(args, ['--rawfile', '--slurpfile', '--args', '--jsonargs']) ? null : program;
		default:
			return program;
	}
}

/**
 * Story 8.5: a shell command's session key: each `|` stage's key word (its program's name, after the
 * `timeout <n>` and bare `env` wrappers; `rpk` and `redpanda-connect` with their subcommand), joined with
 * ` | `. `null` (the command always asks): it chains, substitutes or runs in the background, redirects to
 * a file other than `/dev/null`, starts with an assignment, runs `rpk connect run`, `blobl server` or
 * watches, a stage's program is not on the read-only list (or is not a bare name or an existing program
 * outside the workspace), or an argument expands `$…` or is a path outside the workspace and the skills
 * copy. Never the exact command text.
 */
export function shellKey(command: string, workspace: string, skillsDir?: string, home?: string): string | null {
	const ctx: ShellKeyContext = { workspace, ...(skillsDir !== undefined ? { skillsDir } : {}), ...(home !== undefined ? { home } : {}) };
	const tokens = tokenize(command);
	if (!tokens || tokens.length === 0) {
		return null;
	}
	const stages: Word[][] = [[]];
	for (const t of tokens) {
		if (t.kind === 'pipe') {
			stages.push([]);
		} else if (t.kind === 'redirect') {
			if (t.target !== undefined && t.target !== '/dev/null') {
				return null;
			}
		} else {
			stages[stages.length - 1].push(t);
		}
	}
	const keys: string[] = [];
	for (const [index, stage] of stages.entries()) {
		const words = programWords(stage, ctx);
		const key = words && words.slice(1).every((w) => argStaysInside(w, ctx)) ? stageKey(words.map((w) => w.text), index) : null;
		if (key === null) {
			return null;
		}
		keys.push(key);
	}
	return keys.join(' | ');
}

/** The full text of a call that asks, for its card (`undefined`: none beyond the summary): a shell command, a URL, a search query, or the file. */
export function approvalDetail(tool: string, input: Record<string, unknown>): string | undefined {
	const field = tool === 'Bash' ? input.command : tool === 'WebFetch' ? input.url : tool === 'WebSearch' ? input.query : undefined;
	if (field !== undefined || tool === 'Bash' || tool === 'WebFetch' || tool === 'WebSearch') {
		return typeof field === 'string' && field !== '' ? field : undefined;
	}
	const p = pathOf(input);
	return typeof p === 'string' && p !== '' ? p : undefined;
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
