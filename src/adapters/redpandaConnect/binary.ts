// RedpandaConnect adapter: the single owner of binary resolution and `binaryState` (AD-9).
// Resolution order: `rpk` on PATH run as `rpk connect`, then `redpanda-connect` on PATH,
// then `redpandaConnect.binaryPath` as a fallback when PATH yields no `ok` binary.
// Processes are spawned only through `./process` (the only `child_process` import).

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	formatVersion, isRpkConnectNotInstalled, meetsMinimum, MIN_VERSION, parseVersion, parseVersionOutput,
} from '../../core/version';
import { attachBinaryNotifications, BinaryActions, BinaryNotifications, BinaryNotifier } from './notify';
import { DEFAULT_VERSION_TIMEOUT_MS, findOnPath, ProcessOutcome, readVersion } from './process';
import { errorText, firstNonEmptyLine } from './text';

const RPK_BINARY = 'rpk';
const STANDALONE_BINARY = 'redpanda-connect';

export type InvalidReason =
	| 'belowMinimum'
	| 'relativePathWithoutWorkspace'
	| 'nonZeroExit'
	| 'noVersionLine'
	| 'unparseableVersion'
	| 'timeout'
	| 'spawnError';

export type BinaryState =
	| { readonly kind: 'unresolved' }
	| {
		readonly kind: 'ok';
		readonly path: string;
		/** Normalized, without a `v` prefix: `4.112.0`. */
		readonly version: string;
		/** The argv prefix to spawn with: `[path]` or `[rpkPath, 'connect']`. */
		readonly invocation: readonly string[];
	}
	| { readonly kind: 'missing' }
	| {
		readonly kind: 'invalid';
		readonly path: string;
		readonly reason: InvalidReason;
		readonly version?: string;
		/** Human-readable detail for the log (exit code and first stderr line, timeout, …). */
		readonly detail?: string;
	};

/** Writes one line to the "Redpanda Connect" output channel owned by `src/extension.ts`. */
export type LogLine = (line: string) => void;

/** Everything resolution reads from the outside world, as plain values. */
export interface ResolveEnvironment {
	/** Raw `redpandaConnect.binaryPath` value; empty when unset. */
	readonly binaryPathSetting: string;
	readonly envPath: string | undefined;
	readonly homeDir: string;
	/** File-system path of the first workspace folder, if any. */
	readonly workspaceFolder: string | undefined;
}

export interface Resolution {
	readonly state: BinaryState;
	/** The output-channel line describing `state`. */
	readonly message: string;
}

export type SettingPath =
	| { readonly kind: 'path'; readonly path: string }
	/** No path separator and no leading `~`: a command name looked up on PATH. */
	| { readonly kind: 'command'; readonly name: string }
	| { readonly kind: 'relativeWithoutWorkspace' };

/**
 * A value without `/` or `\\` and without a leading `~` is a command name (looked up on PATH).
 * Otherwise: expands a leading `~` to `homeDir`, resolves a relative path against
 * `workspaceFolder`, and keeps an absolute path as written.
 */
export function resolveSettingPath(setting: string, homeDir: string, workspaceFolder: string | undefined): SettingPath {
	if (setting === '~' || setting.startsWith('~/') || setting.startsWith('~\\')) {
		return { kind: 'path', path: path.join(homeDir, setting.slice(1)) };
	}
	if (!setting.startsWith('~') && !setting.includes('/') && !setting.includes('\\')) {
		return { kind: 'command', name: setting };
	}
	if (path.isAbsolute(setting)) {
		return { kind: 'path', path: setting };
	}
	return workspaceFolder
		? { kind: 'path', path: path.resolve(workspaceFolder, setting) }
		: { kind: 'relativeWithoutWorkspace' };
}

type Candidate =
	| { kind: 'ok'; state: Extract<BinaryState, { kind: 'ok' }> }
	| { kind: 'invalid'; state: Extract<BinaryState, { kind: 'invalid' }> }
	| { kind: 'notFound' }
	| { kind: 'rpkNotInstalled' };

/** Interprets one `--version` probe of `invocation` (whose binary is `binaryPath`). */
function classify(probe: ProcessOutcome, binaryPath: string, invocation: readonly string[], isRpk: boolean): Candidate {
	const invalid = (reason: InvalidReason, detail?: string, version?: string): Candidate => ({
		kind: 'invalid',
		state: {
			kind: 'invalid', path: binaryPath, reason,
			...(version !== undefined ? { version } : {}),
			...(detail !== undefined ? { detail } : {}),
		},
	});

	switch (probe.kind) {
		case 'notFound':
			return { kind: 'notFound' };
		case 'spawnError':
			return invalid('spawnError', probe.message);
		case 'timeout':
			return invalid('timeout', `timed out after ${probe.timeoutMs} ms`);
		case 'exited': {
			// rpk without its managed plugin exits 0 and prints the hint on stdout (spike, 2026-10-06).
			if (isRpk && isRpkConnectNotInstalled(`${probe.stdout}\n${probe.stderr}`)) {
				return { kind: 'rpkNotInstalled' };
			}
			const stderr = firstNonEmptyLine(probe.stderr);
			const exit = probe.exitCode === null ? 'no exit code' : `exit code ${probe.exitCode}`;
			const exitDetail = stderr ? `${exit}: ${stderr}` : exit;
			if (probe.exitCode !== 0) {
				return invalid('nonZeroExit', exitDetail);
			}
			const token = parseVersionOutput(probe.stdout);
			if (token === undefined) {
				return invalid('noVersionLine', exitDetail);
			}
			const version = parseVersion(token);
			if (!version) {
				return invalid('unparseableVersion', `"Version: ${token}"`);
			}
			const printed = formatVersion(version);
			if (!meetsMinimum(version)) {
				return invalid('belowMinimum', undefined, printed);
			}
			return { kind: 'ok', state: { kind: 'ok', path: binaryPath, version: printed, invocation: [...invocation] } };
		}
	}
}

/** True when the binary is rpk, which runs Redpanda Connect as `rpk connect`. */
function isRpkBinary(binaryPath: string): boolean {
	const base = path.basename(binaryPath).toLowerCase();
	return base === RPK_BINARY || base === `${RPK_BINARY}.exe`;
}

/** Probes one binary: rpk runs as `[path, 'connect']`, anything else as `[path]`. */
async function probeBinary(binaryPath: string, timeoutMs: number): Promise<Candidate> {
	const isRpk = isRpkBinary(binaryPath);
	const invocation = isRpk ? [binaryPath, 'connect'] : [binaryPath];
	return classify(await readVersion(invocation, timeoutMs), binaryPath, invocation, isRpk);
}

const rpkNotInstalledNote = (rpk: string) => `rpk was found at ${rpk} but "rpk connect install" has not been run`;

/**
 * Resolves the binary in AD-9 order and checks its version. Never rejects.
 * `rpk` on PATH (as `rpk connect`), then `redpanda-connect` on PATH; only when neither is
 * `ok`, `redpandaConnect.binaryPath`. If nothing is `ok`, the first `invalid` seen (PATH
 * before setting) is the state, else `missing`.
 */
export async function resolveBinaryState(
	env: ResolveEnvironment,
	timeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
): Promise<Resolution> {
	let fallback: Extract<BinaryState, { kind: 'invalid' }> | undefined;
	let rpkWithoutPlugin: string | undefined;

	for (const name of [RPK_BINARY, STANDALONE_BINARY]) {
		const found = findOnPath(name, env.envPath);
		if (!found) {
			continue;
		}
		const candidate = await probeBinary(found, timeoutMs);
		if (candidate.kind === 'ok') {
			return { state: candidate.state, message: describeState(candidate.state) };
		}
		if (candidate.kind === 'invalid') {
			fallback ??= candidate.state;
		} else if (candidate.kind === 'rpkNotInstalled') {
			rpkWithoutPlugin ??= found;
		}
	}

	// Fallback: the setting (bare name on PATH, `~`, relative to the workspace).
	const setting = env.binaryPathSetting.trim();
	let settingNote = 'redpandaConnect.binaryPath is not set';
	let settingRpkWithoutPlugin = false;
	if (setting) {
		const target = resolveSettingPath(setting, env.homeDir, env.workspaceFolder);
		if (target.kind === 'relativeWithoutWorkspace') {
			fallback ??= { kind: 'invalid', path: setting, reason: 'relativePathWithoutWorkspace' };
		} else {
			const binaryPath = target.kind === 'command' ? findOnPath(target.name, env.envPath) : target.path;
			if (!binaryPath) {
				settingNote = `redpandaConnect.binaryPath "${setting}" is not on PATH`;
			} else {
				const candidate = await probeBinary(binaryPath, timeoutMs);
				if (candidate.kind === 'ok') {
					return { state: candidate.state, message: describeState(candidate.state) };
				}
				if (candidate.kind === 'invalid') {
					fallback ??= candidate.state;
				} else if (candidate.kind === 'rpkNotInstalled') {
					settingNote = `redpandaConnect.binaryPath "${setting}" is rpk, but "rpk connect install" has not been run`;
					settingRpkWithoutPlugin = true;
				} else {
					const resolvedNote = binaryPath === setting ? '' : ` (resolved to ${binaryPath})`;
					settingNote = `no binary was found at redpandaConnect.binaryPath "${setting}"${resolvedNote}`;
				}
			}
		}
	}

	if (fallback) {
		const notes = [
			...(rpkWithoutPlugin ? [rpkNotInstalledNote(rpkWithoutPlugin)] : []),
			...(settingRpkWithoutPlugin ? [settingNote] : []),
		];
		const suffix = notes.length ? ` (${notes.join('; ')}.)` : '';
		return { state: fallback, message: describeState(fallback) + suffix };
	}
	const pathNote = rpkWithoutPlugin
		? `${rpkNotInstalledNote(rpkWithoutPlugin)}, "${STANDALONE_BINARY}" is not on PATH`
		: `neither "${RPK_BINARY}" nor "${STANDALONE_BINARY}" is on PATH`;
	return { state: { kind: 'missing' }, message: `No Redpanda Connect binary found: ${pathNote}, and ${settingNote}.` };
}

/** The output-channel line for a state (the `missing` line is built by `resolveBinaryState`). */
export function describeState(state: BinaryState): string {
	switch (state.kind) {
		case 'unresolved':
			return 'Redpanda Connect binary not resolved yet.';
		case 'missing':
			return 'No Redpanda Connect binary found.';
		case 'ok':
			return `Redpanda Connect ${state.version} (${state.invocation.join(' ')})`;
		case 'invalid': {
			switch (state.reason) {
				case 'belowMinimum':
					return `Redpanda Connect ${state.version} (${state.path}) is older than the minimum supported version `
						+ `${formatVersion(MIN_VERSION)}.`;
				case 'relativePathWithoutWorkspace':
					return `redpandaConnect.binaryPath "${state.path}" is a relative path, but no workspace folder is open.`;
				case 'noVersionLine':
					return `Redpanda Connect version check failed (${state.path}): no "Version:" line in output, ${state.detail}`;
				case 'unparseableVersion':
					return `Redpanda Connect version check failed (${state.path}): unrecognised version ${state.detail}`;
				case 'nonZeroExit':
					return `Redpanda Connect version check failed (${state.path}): non-zero exit, ${state.detail}`;
				case 'timeout':
				case 'spawnError':
					return `Redpanda Connect version check failed (${state.path}): ${state.detail}`;
			}
		}
	}
}

/** Equality of state values; `invalid.detail` is ignored. */
function statesEqual(a: BinaryState, b: BinaryState): boolean {
	switch (a.kind) {
		case 'unresolved':
		case 'missing':
			return b.kind === a.kind;
		case 'ok':
			return b.kind === 'ok' && a.path === b.path && a.version === b.version
				&& a.invocation.length === b.invocation.length && a.invocation.every((arg, i) => arg === b.invocation[i]);
		case 'invalid':
			// `detail` (stderr / error text) may vary between runs and is not part of the state value.
			return b.kind === 'invalid' && a.path === b.path && a.reason === b.reason && a.version === b.version;
	}
}

export interface RedpandaConnectOptions {
	readonly log: LogLine;
	/** Per `--version` probe. */
	readonly timeoutMs?: number;
	/** Reads the inputs for one resolution run; defaults to VS Code settings, PATH, home and workspace. */
	readonly environment?: () => ResolveEnvironment;
	/**
	 * Shows the binary-missing / invalid warning, once per transition into `missing` or
	 * `invalid` (AD-9). Omitted: no notifications.
	 */
	readonly notifier?: BinaryNotifier;
}

/** File-system path of the first `file:` workspace folder, if any (relative setting paths resolve against it). */
export function firstWorkspaceFolderPath(): string | undefined {
	return vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri.fsPath;
}

function defaultEnvironment(): ResolveEnvironment {
	return {
		binaryPathSetting: vscode.workspace.getConfiguration('redpandaConnect').get<string>('binaryPath', '') ?? '',
		envPath: process.env.PATH,
		homeDir: os.homedir(),
		workspaceFolder: firstWorkspaceFolderPath(),
	};
}

/**
 * Owns `binaryState`. Re-resolves on `refresh()` and when `redpandaConnect.binaryPath` changes.
 * `onDidChange` fires only when the state value changes. A line is logged on each state
 * change and, while `missing`, whenever the message differs from the last one logged.
 */
export class RedpandaConnect implements vscode.Disposable {
	private current: BinaryState = { kind: 'unresolved' };
	private lastLogged: string | undefined;
	private readonly emitter = new vscode.EventEmitter<BinaryState>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private inFlight: Promise<BinaryState> | undefined;
	private rerunRequested = false;
	private disposed = false;
	private readonly notifications: BinaryNotifications | undefined;

	readonly onDidChange: vscode.Event<BinaryState> = this.emitter.event;

	constructor(private readonly options: RedpandaConnectOptions) {
		this.subscriptions.push(
			this.emitter,
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('redpandaConnect.binaryPath')) {
					this.scheduleRefresh();
				}
			}),
		);
		if (options.notifier) {
			// Subscribed before the first resolution, so activation's `unresolved` → `missing` notifies.
			this.notifications = attachBinaryNotifications(this, options.notifier, options.log);
			this.subscriptions.push(this.notifications);
		}
	}

	/**
	 * Shows the binary warning for the current state again (a user-triggered command needs a
	 * binary). Returns whether a warning was shown; `false` when the state is usable or there is
	 * no notifier.
	 */
	showBinaryWarning(): boolean {
		return this.notifications?.showAgain(this.current) ?? false;
	}

	/**
	 * The binary warning's actions (Install guide, Set path, Retry), the same ones the warning
	 * runs; `undefined` when there is no notifier.
	 */
	get actions(): BinaryActions | undefined {
		return this.notifications?.actions;
	}

	get state(): BinaryState {
		return this.current;
	}

	/**
	 * Re-resolves the binary. Single-flight: a call made while a run is in progress
	 * shares that run (and any run already queued behind it) and gets its result.
	 */
	refresh(): Promise<BinaryState> {
		if (this.disposed) {
			return Promise.resolve(this.current);
		}
		if (!this.inFlight) {
			this.inFlight = this.runLoop();
		}
		return this.inFlight;
	}

	/**
	 * For change triggers (a setting changed): starts a run, or, if one is in progress,
	 * queues exactly one more run after it, however many triggers arrive meanwhile.
	 */
	scheduleRefresh(): void {
		if (this.inFlight) {
			this.rerunRequested = true;
			return;
		}
		void this.refresh();
	}

	dispose(): void {
		this.disposed = true;
		for (const d of this.subscriptions.splice(0)) {
			d.dispose();
		}
	}

	private async runLoop(): Promise<BinaryState> {
		try {
			do {
				this.rerunRequested = false;
				await this.runOnce();
			} while (this.rerunRequested && !this.disposed);
		} finally {
			this.inFlight = undefined;
		}
		return this.current;
	}

	private async runOnce(): Promise<void> {
		let resolution: Resolution;
		try {
			const env = (this.options.environment ?? defaultEnvironment)();
			resolution = await resolveBinaryState(env, this.options.timeoutMs);
		} catch (err) {
			// Not expected (resolution never rejects); keep the previous state.
			this.options.log(`Redpanda Connect binary resolution failed: ${errorText(err)}`);
			return;
		}
		if (this.disposed) {
			return;
		}
		// Log on a state change; while `missing`, also when the line differs (e.g. a new rpk hint).
		// An unchanged `invalid` whose detail varies (stderr with a PID) is not logged again.
		const changed = !statesEqual(this.current, resolution.state);
		if (changed || (resolution.state.kind === 'missing' && resolution.message !== this.lastLogged)) {
			this.lastLogged = resolution.message;
			this.options.log(resolution.message);
		}
		if (!changed) {
			return;
		}
		this.current = resolution.state;
		this.emitter.fire(resolution.state);
	}
}
