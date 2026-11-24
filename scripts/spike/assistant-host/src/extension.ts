// Spike 65: can the extension host the Claude Agent SDK, through the Redpanda ADP proxy? A throwaway
// extension, loaded into the dev host beside the Pipeline Designer, never shipped. One command,
// "Spike: run the assistant":
//   1. reads ~/.config/rpcn-spike/adp.env (refused, before any request, unless it is a regular file
//      you own with mode 0600 holding ADP_BASE_URL and ADP_API_KEY);
//   2. counts the run against the cap (3 full design runs) and asks before calling ADP;
//   3. calls the SDK's `query()` with `model`, `env` (the key only there), the local `rpcn-skills`
//      checkout as a plugin, `skills` limited to rpcn-design / rpcn-author / rpcn-test,
//      `settingSources: []`, `cwd` the workspace folder, `canUseTool`, a PreToolUse hook and the
//      in-process `rpcn` MCP server (src/tools.ts);
//   4. records every stream message, question, approval, hook decision and tool call by shape to
//      its output channel and to <workspace>/.spike-65/run-<time>/ (events.jsonl, run.json).
// Nothing is written outside the workspace folder: the SDK's config and transcripts go to
// <workspace>/.spike-65/claude-config, uv's cache to <workspace>/.spike-65/uv-cache.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CanUseTool, HookCallback, Options, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { ADP_FILE, readAdpAccess, type AdpAccess } from './adp';
import { CaptureLog, errInfo, PREFIX_MIN, Redactor, shape } from './capture';
import { mask, toolServer, type MainExports } from './tools';

const MAIN_ID = 'ajurcenk.rpcn-pipeline-designer';
const SKILLS = ['rpcn-design', 'rpcn-author', 'rpcn-test'];
const MAX_RUNS = 3;
const DEFAULT_REQUEST = 'Design a Redpanda Connect pipeline: read orders from a topic and post them to an API; failures to a dead-letter topic.';
const REPO = path.resolve(__dirname, '../../../..');
const SKILLS_DIR = path.resolve(REPO, '../rpcn-skills');
const RPCN_CHECK = /^uv run (\S+\/rpcn_check\.py) [a-z][a-z-]*(?:\s|$)/;
// Shell metacharacters: with any of these a command can chain, substitute or redirect.
const SHELL_META = /[;&|`$<>(){}\\\n\r*?![\]~#]/;

/**
 * The one Bash rule, for the PreToolUse hook and canUseTool alike: a command is the skills' own
 * rpcn_check call when it is `uv run <script> <subcommand> …` with no shell metacharacter, and
 * the script resolves (normalised, symlinks followed) to an `rpcn_check.py` inside the rpcn-skills
 * checkout. Anything else asks.
 */
export function isRpcnCheckCall(command: unknown, cwd: string, skillsDir: string = SKILLS_DIR): boolean {
	if (typeof command !== 'string') return false;
	const c = command.trim();
	if (SHELL_META.test(c)) return false;
	const m = RPCN_CHECK.exec(c);
	if (!m) return false;
	let script = path.resolve(cwd, m[1]);
	let root = path.resolve(skillsDir);
	try { script = fs.realpathSync(script); root = fs.realpathSync(root); } catch { return false; }
	return path.basename(script) === 'rpcn_check.py' && script.startsWith(root + path.sep);
}

let channel: vscode.OutputChannel;
let running: AbortController | undefined;

export function activate(context: vscode.ExtensionContext): void {
	channel = vscode.window.createOutputChannel('Spike: assistant host');
	context.subscriptions.push(channel, vscode.commands.registerCommand('rpcnSpike.runAssistant', () => runAssistant()));
	channel.appendLine(`activated (spike 65; the ADP file is read only when the command runs: ${ADP_FILE})`);
}

export function deactivate(): void { running?.abort(); }

/** The command. Returns what happened, for the dev-host check (no throw). */
export async function runAssistant(): Promise<{ outcome: string }> {
	const tCommand = Date.now();
	// 1. The file, before anything else (no request, no SDK import).
	let access: AdpAccess;
	try { access = readAdpAccess(); } catch (e) {
		const msg = String((e as Error).message);
		channel.appendLine(`refused: ${msg}`);
		void vscode.window.showErrorMessage(`Spike: ${msg}`);
		return { outcome: 'refused' };
	}
	// 1b. One run at a time: claimed before the first await, released on every exit.
	if (running) { void vscode.window.showWarningMessage('Spike: a run is already going.'); return { outcome: 'busy' }; }
	const abort = new AbortController();
	running = abort;
	try { return await runClaimed(access, abort, tCommand); } finally { running = undefined; }
}

async function runClaimed(access: AdpAccess, abort: AbortController, tCommand: number): Promise<{ outcome: string }> {
	const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!ws) { void vscode.window.showErrorMessage('Spike: open the test workspace folder first.'); return { outcome: 'no-workspace' }; }
	if (!fs.existsSync(path.join(SKILLS_DIR, '.claude-plugin/plugin.json'))) { void vscode.window.showErrorMessage(`Spike: no rpcn-skills checkout at ${SKILLS_DIR}`); return { outcome: 'no-skills' }; }

	// 2. The cost cap, counted in the workspace.
	const spikeDir = path.join(ws, '.spike-65');
	fs.mkdirSync(spikeDir, { recursive: true });
	const countFile = path.join(spikeDir, 'runs.json');
	const runs: { n: number; at: string }[] = fs.existsSync(countFile) ? JSON.parse(fs.readFileSync(countFile, 'utf8')) : [];
	if (runs.length >= MAX_RUNS) { void vscode.window.showErrorMessage(`Spike: the cap of ${MAX_RUNS} design runs is reached (${countFile}).`); return { outcome: 'cap' }; }
	const request = await vscode.window.showInputBox({ title: `Spike 65: design run ${runs.length + 1} of ${MAX_RUNS} (calls ADP)`, value: DEFAULT_REQUEST, ignoreFocusOut: true });
	if (!request) return { outcome: 'cancelled' };
	const go = await vscode.window.showWarningMessage(`Run the assistant through ADP with ${access.model}? This is design run ${runs.length + 1} of ${MAX_RUNS}.`, { modal: true }, 'Run');
	if (go !== 'Run') return { outcome: 'cancelled' };
	const tConfirmed = Date.now();
	runs.push({ n: runs.length + 1, at: new Date().toISOString() });
	fs.writeFileSync(countFile, `${JSON.stringify(runs, null, 2)}\n`);

	const R = new Redactor();
	R.secretWithPrefixes(access.apiKey);
	for (const [, v] of access.headers) R.secretWithPrefixes(v);
	const base = new URL(access.baseUrl);
	R.id(access.baseUrl, '<adp-base-url>');
	R.id(base.host, '<adp-host>');
	R.id(base.hostname, '<adp-host>');
	R.id(SKILLS_DIR, '<rpcn-skills>');
	R.id(ws, '<workspace>');
	R.id(REPO, '<repo>');
	R.id(process.env.HOME, '~');
	R.id(os.userInfo().homedir, '~'); // the account's home, also when HOME points elsewhere
	const runDir = path.join(spikeDir, `run-${runs.length}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
	const log = new CaptureLog(runDir, channel, R);
	channel.show(true);
	const run: Record<string, unknown> = { run: runs.length, date: new Date().toISOString(), model: access.model, request_sample: R.sample(request), platform: `${process.platform}-${process.arch}`, vscode: vscode.version, electron_node: process.versions.node, skills_commit: gitCommit(SKILLS_DIR) };
	const times: Record<string, number> = {};
	const counts = { questions: 0, approvals: 0, denied: 0, hook_allow: 0, hook_deny: 0, tool_calls: {} as Record<string, number>, write_attempts: [] as string[] };

	// The main extension's exports (always exported: redpandaConnect, run, schemaStore).
	const mainExt = vscode.extensions.getExtension<MainExports>(MAIN_ID);
	let main: MainExports | undefined;
	try { main = mainExt ? await mainExt.activate() : undefined; await main?.activationResolved; } catch (e) { log.event('main.activate.error', { error: errInfo(e) }); }
	run.main_extension = { found: !!mainExt, binary_state: main?.redpandaConnect.state.kind ?? null, binary_version: main?.redpandaConnect.state.version ?? null, schema: !!main?.schemaStore.current };
	log.event('start', { ...run });

	let leaked = false;
	try {
		const tImport = Date.now();
		const sdk = await import('@anthropic-ai/claude-agent-sdk');
		const z = await import('zod');
		times.sdk_import_ms = Date.now() - tImport;
		// uv (the skills' scripts, and rpcn_componentFields) keeps its cache, Pythons, tools and data in the workspace.
		const uvEnv = {
			UV_CACHE_DIR: path.join(spikeDir, 'uv-cache'),
			UV_PYTHON_INSTALL_DIR: path.join(spikeDir, 'uv-python'),
			UV_TOOL_DIR: path.join(spikeDir, 'uv-tools'),
			XDG_DATA_HOME: path.join(spikeDir, 'xdg-data'),
			XDG_CACHE_HOME: path.join(spikeDir, 'xdg-cache'),
		};
		const servers: Options['mcpServers'] = main ? { rpcn: toolServer(sdk, z, { workspace: ws, main, skillsDir: SKILLS_DIR, uvEnv, record: (k, d) => { counts.tool_calls[k] = (counts.tool_calls[k] ?? 0) + 1; log.event(k, d); } }) } : {};
		if (!main) log.event('tools.unavailable', { reason: `${MAIN_ID} not found in the dev host` });

		const inside = (p: unknown) => typeof p === 'string' && isInside(ws, p);
		const preToolUse: HookCallback = async (input) => {
			if (input.hook_event_name !== 'PreToolUse') return {};
			const ti = (input.tool_input ?? {}) as Record<string, unknown>;
			let decision: 'allow' | 'deny' | undefined, reason = '';
			if (input.tool_name === 'Bash' && isRpcnCheckCall(ti.command, ws)) { decision = 'allow'; reason = 'the skills\' own rpcn_check call'; }
			else if (['Write', 'Edit', 'NotebookEdit'].includes(input.tool_name) && !inside(ti.file_path ?? ti.notebook_path)) { decision = 'deny'; reason = 'writes stay inside the workspace folder'; }
			else if (input.tool_name.startsWith('mcp__rpcn__')) { decision = 'allow'; reason = 'the extension\'s own read-only tools'; }
			// Run 1: the skills read their own references (outside the workspace), which asked each time.
			else if (['Read', 'Glob', 'Grep'].includes(input.tool_name) && typeof (ti.file_path ?? ti.path) === 'string' && isInside(SKILLS_DIR, (ti.file_path ?? ti.path) as string)) { decision = 'allow'; reason = 'a read inside the rpcn-skills checkout'; }
			log.event('hook.PreToolUse', { tool: input.tool_name, input_shape: shape(ti), command_sample: typeof ti.command === 'string' ? R.sample(ti.command) : undefined, path: typeof (ti.file_path ?? ti.path) === 'string' ? R.text(ti.file_path ?? ti.path) : undefined, decision: decision ?? 'none (to canUseTool / the permission mode)', reason, mcp_server: input.mcp_server });
			if (decision === 'allow') counts.hook_allow++;
			if (decision === 'deny') counts.hook_deny++;
			return decision ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } } : {};
		};

		const canUseTool: CanUseTool = async (toolName, input, opts) => {
			counts.approvals++;
			log.event('canUseTool', { tool: toolName, input_shape: shape(input), title: R.sample(opts.title), decision_reason: R.sample(opts.decisionReason), blocked_path: opts.blockedPath ? R.text(opts.blockedPath) : undefined, suggestions: opts.suggestions?.length ?? 0, mcp_server: opts.mcpServer });
			let result: PermissionResult;
			if (toolName === 'AskUserQuestion') result = await askUser(input, log, () => counts.questions++);
			else if (['Write', 'Edit', 'NotebookEdit'].includes(toolName)) {
				const p = input.file_path ?? input.notebook_path;
				result = inside(p) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Writes stay inside the workspace folder.' };
			} else if (toolName === 'Bash' && isRpcnCheckCall(input.command, ws)) result = { behavior: 'allow', updatedInput: input };
			else {
				const what = toolName === 'Bash' ? `run \`${String(input.command ?? '').slice(0, 200)}\`` : `use ${toolName}`;
				const pick = await vscode.window.showWarningMessage(`The assistant asks to ${mask(what, ws)}.`, { modal: true, detail: opts.title ? mask(opts.title, ws) : undefined }, 'Allow', 'Deny');
				result = pick === 'Allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user denied this.' };
			}
			if (result.behavior === 'deny') counts.denied++;
			log.event('canUseTool.result', { tool: toolName, behavior: result.behavior, message: result.behavior === 'deny' ? result.message : undefined, answers: toolName === 'AskUserQuestion' && result.behavior === 'allow' ? Object.keys((result.updatedInput?.answers as object) ?? {}).length : undefined });
			return result;
		};

		const env: Record<string, string> = {
			PATH: process.env.PATH ?? '',
			HOME: process.env.HOME ?? '',
			LANG: process.env.LANG ?? 'C.UTF-8',
			ANTHROPIC_BASE_URL: access.baseUrl,
			[authEnv()]: access.apiKey,
			// Every model alias Claude Code may use (background calls, subagents) names the ADP model.
			ANTHROPIC_DEFAULT_HAIKU_MODEL: access.model,
			ANTHROPIC_DEFAULT_SONNET_MODEL: access.model,
			ANTHROPIC_DEFAULT_OPUS_MODEL: access.model,
			ANTHROPIC_SMALL_FAST_MODEL: access.model,
			CLAUDE_CONFIG_DIR: path.join(spikeDir, 'claude-config'),
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
			DISABLE_AUTOUPDATER: '1',
			CLAUDE_AGENT_SDK_CLIENT_APP: 'rpcn-spike-65/0.0.0',
			...uvEnv,
			NO_COLOR: '1',
		};
		if (access.headers.length) env.ANTHROPIC_CUSTOM_HEADERS = access.headers.map(([k, v]) => `${k}: ${v}`).join('\n');
		if (main?.redpandaConnect.state.kind === 'ok' && main.redpandaConnect.state.path) env.RPCN_BINARY = main.redpandaConnect.state.path;
		run.env_names = Object.keys(env).sort();

		const options: Options = {
			model: access.model,
			env,
			cwd: ws,
			plugins: [{ type: 'local', path: SKILLS_DIR }],
			skills: SKILLS,
			settingSources: [],
			persistSession: false,
			canUseTool,
			hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
			mcpServers: servers,
			abortController: abort,
			maxTurns: 80,
			stderr: (d) => log.event('sdk.stderr', { sample: R.sample(d.trim()) }),
		};
		log.event('query', { options_shape: shape({ ...options, env: Object.fromEntries(Object.keys(env).map((k) => [k, 'string'])) }), plugin_path: R.text(SKILLS_DIR), skills: SKILLS, setting_sources: [] });
		const tQuery = Date.now();
		times.command_to_query_ms = tQuery - tCommand;
		for await (const m of sdk.query({ prompt: request, options })) {
			// command_to_first_message_ms includes the two dialogs; confirmed_to_first_message_ms does not.
			if (times.first_message_ms === undefined) { times.first_message_ms = Date.now() - tQuery; times.command_to_first_message_ms = Date.now() - tCommand; times.confirmed_to_first_message_ms = Date.now() - tConfirmed; }
			recordMessage(m, log, run, times, tQuery, counts);
		}
	} catch (e) {
		log.event('error', { error: errInfo(e) });
		run.error = errInfo(e);
	} finally {
		run.times = times;
		run.counts = counts;
		run.design_notes = designNotes(ws, spikeDir);
		const scan = log.finish(run, { api_key: access.apiKey, api_key_start: access.apiKey.slice(0, Math.min(PREFIX_MIN, access.apiKey.length)), adp_host: base.hostname, ...Object.fromEntries(access.headers.flatMap(([k, v], i) => [[`header_${i}_${k}`, v], [`header_${i}_${k}_start`, v.slice(0, PREFIX_MIN)]])) });
		leaked = !scan.clean;
		if (leaked) void vscode.window.showErrorMessage(`Spike: run ${runs.length}'s captures held a secret (${scan.hits.map((h) => h.what).join(', ')}); they were deleted.`);
		channel.appendLine(`run ${runs.length} done; ${leaked ? 'captures DELETED' : `captures in ${runDir}`}; leak self-scan ${scan.clean ? 'clean' : `HITS: ${scan.hits.map((h) => h.what).join(', ')}`}`);
	}
	return { outcome: leaked ? 'leak' : 'ran' };
}

/** `ANTHROPIC_API_KEY` (sent as x-api-key) unless the spike's setting asks for a bearer token. */
function authEnv(): string {
	return vscode.workspace.getConfiguration('rpcnSpike').get<string>('auth') === 'bearer' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY';
}

function isInside(ws: string, p: string): boolean {
	const abs = path.resolve(ws, p);
	let real = abs;
	// The nearest existing parent's real path, so a symlink out of the workspace does not count as inside.
	for (let d = abs; ; d = path.dirname(d)) {
		if (fs.existsSync(d)) { real = path.join(fs.realpathSync(d), path.relative(d, abs)); break; }
		if (path.dirname(d) === d) break;
	}
	const root = fs.realpathSync(ws);
	return real === root || real.startsWith(root + path.sep);
}

/** Each question as a quick pick (its options, multi-select as asked, and "Other…"). */
async function askUser(input: Record<string, unknown>, log: CaptureLog, count: () => void): Promise<PermissionResult> {
	const R = log.R;
	const questions = Array.isArray(input.questions) ? (input.questions as { question: string; header: string; options: { label: string; description: string; preview?: string }[]; multiSelect?: boolean }[]) : [];
	const answers: Record<string, string> = {};
	for (const q of questions) {
		count();
		log.event('question', { header: R.sample(q.header), question_sample: R.sample(q.question), multi_select: !!q.multiSelect, options: q.options?.map((o) => ({ label: R.sample(o.label), description_chars: o.description?.length ?? 0, preview: !!o.preview })) });
		const items = [...(q.options ?? []).map((o) => ({ label: o.label, detail: o.description })), { label: 'Other…', detail: 'Type an answer' }];
		const picked = q.multiSelect
			? await vscode.window.showQuickPick(items, { title: q.header, placeHolder: q.question, canPickMany: true, ignoreFocusOut: true })
			: await vscode.window.showQuickPick(items, { title: q.header, placeHolder: q.question, ignoreFocusOut: true });
		const list = picked === undefined ? [] : Array.isArray(picked) ? picked : [picked];
		if (!list.length) { log.event('question.dismissed', { header: R.sample(q.header) }); return { behavior: 'deny', message: 'The user dismissed the question.' }; }
		const labels: string[] = [];
		for (const p of list) {
			if (p.label === 'Other…') { const t = await vscode.window.showInputBox({ title: q.header, prompt: q.question, ignoreFocusOut: true }); if (t) labels.push(t); } else labels.push(p.label);
		}
		answers[q.question] = labels.join(', ');
		log.event('answer', { header: R.sample(q.header), picked: list.map((p) => (p.label === 'Other…' ? '<other>' : R.sample(p.label))) });
	}
	return { behavior: 'allow', updatedInput: { ...input, answers } };
}

/** One stream message by shape; the init and result messages in more detail. */
function recordMessage(m: SDKMessage, log: CaptureLog, run: Record<string, unknown>, times: Record<string, number>, tQuery: number, counts: { write_attempts: string[] }): void {
	const R = log.R;
	const any = m as Record<string, unknown> & { type: string; subtype?: string };
	if (any.type === 'system' && any.subtype === 'init') {
		const i = m as Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;
		times.init_ms = Date.now() - tQuery;
		const init = { claude_code_version: i.claude_code_version, model: i.model, api_key_source: i.apiKeySource, permission_mode: i.permissionMode, skills: i.skills, plugins: i.plugins?.map((p) => ({ name: p.name, version: p.version, path: R.text(p.path) })), plugin_errors: i.plugin_errors, mcp_servers: i.mcp_servers, tools: i.tools.length, mcp_tools: i.tools.filter((t) => t.startsWith('mcp__')), has_ask_user_question: i.tools.includes('AskUserQuestion'), slash_commands: i.slash_commands.length, output_style: i.output_style, cwd: R.text(i.cwd) };
		run.init = init;
		log.event('message.system.init', init);
		return;
	}
	if (any.type === 'assistant' || any.type === 'user') {
		const content = ((any.message as { content?: unknown })?.content ?? []) as Record<string, unknown>[];
		const blocks = Array.isArray(content) ? content : [];
		const data: Record<string, unknown> = { types: blocks.map((b) => b.type), parent_tool_use_id: any.parent_tool_use_id ? 'set' : null };
		const text = blocks.find((b) => b.type === 'text');
		if (text) data.text_sample = R.sample(text.text);
		const uses = blocks.filter((b) => b.type === 'tool_use');
		if (uses.length) data.tool_uses = uses.map((u) => ({ name: u.name, input_shape: shape(u.input) }));
		for (const u of uses) {
			const fp = (u.input as { file_path?: unknown })?.file_path;
			if ((u.name === 'Write' || u.name === 'Edit') && typeof fp === 'string') counts.write_attempts.push(R.text(fp));
		}
		const results = blocks.filter((b) => b.type === 'tool_result');
		if (results.length) data.tool_results = results.map((r) => ({ is_error: !!r.is_error, chars: JSON.stringify(r.content ?? '').length }));
		const usage = (any.message as { usage?: Record<string, unknown> })?.usage;
		if (usage) data.usage = Object.fromEntries(Object.entries(usage).filter(([, x]) => typeof x === 'number'));
		log.event(`message.${any.type}`, data);
		return;
	}
	if (any.type === 'result') {
		const r = { subtype: any.subtype, is_error: any.is_error, duration_ms: any.duration_ms, duration_api_ms: any.duration_api_ms, num_turns: any.num_turns, total_cost_usd: any.total_cost_usd, usage: any.usage, model_usage: any.modelUsage ? Object.keys(any.modelUsage as object) : null, permission_denials: Array.isArray(any.permission_denials) ? (any.permission_denials as { tool_name: string }[]).map((d) => d.tool_name) : null, result_sample: R.sample(any.result), errors: any.errors };
		run.result = r;
		times.result_ms = Date.now() - tQuery;
		log.event('message.result', r);
		return;
	}
	log.event(`message.${any.type}${any.subtype ? `.${any.subtype}` : ''}`, { shape: shape(m) });
}

/** The `*.design.md` files in the workspace and their `status` header line. */
function designNotes(ws: string, skip: string): { file: string; status: string | null }[] {
	const out: { file: string; status: string | null }[] = [];
	const walk = (d: string, depth: number) => {
		if (depth > 4 || d === skip) return;
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(p, depth + 1);
			else if (e.isFile() && e.name.endsWith('.design.md')) {
				const head = fs.readFileSync(p, 'utf8').split('\n').slice(0, 20);
				const st = head.find((l) => /^status:\s*/.test(l));
				out.push({ file: path.relative(ws, p), status: st ? st.replace(/^status:\s*/, '').replace(/^['"]|['"]$/g, '').trim() : null });
			}
		}
	};
	walk(ws, 0);
	return out;
}

function gitCommit(dir: string): { commit: string | null; dirty: boolean | null } {
	try {
		const commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
		const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
		return { commit, dirty };
	} catch { return { commit: null, dirty: null }; }
}
