// Pure argv construction for `lint` and `run` (AD-9): the one place where their flags live.
// Spike 1.1 (Q1, Q3, Q5, Q6):
//   - rpk consumes `-v`, `--verbose` and a bare `-`, so they are never passed.
//   - `lint` with no paths exits 0 silently, so lint always gets at least one path.
//   - `run` refuses configs with lint errors; `--chilled` would hide them, so it is never passed.
//   - Every run binds 0.0.0.0:4195 by default. A Run (AD-25, ticket 7.2) passes the port the extension
//     picked free for it, so its HTTP server serves `/metrics` on 127.0.0.1 only and parallel runs
//     never collide; every other `run` (the Bloblang test run, the license check) keeps it off.
//   - Lint echoes paths as given, so every path passed here is expected to be absolute.
// Long flag forms only.

/** Lint flags: deprecations become warnings (AD-17); env vars are not required to be set. */
export const LINT_FLAGS: readonly string[] = ['--deprecated', '--skip-env-var-check'];
/** Run flags without a metrics port: the local HTTP server is off, so concurrent runs never collide on port 4195. */
export const RUN_FLAGS: readonly string[] = ['--set', 'http.enabled=false'];

/**
 * Run flags with a metrics port (AD-25): the HTTP server on, on 127.0.0.1 at `port` only. A config's
 * own `http` section is always overridden (ticket 7.2 decision).
 */
export function metricsRunFlags(port: number): string[] {
	return ['--set', 'http.enabled=true', '--set', `http.address=127.0.0.1:${port}`];
}
/** Never part of a built argv (spike 1.1). */
export const FORBIDDEN_ARGS: readonly string[] = ['--verbose', '-v', '-', '--chilled'];

export interface ArgvInput {
	/** The argv prefix from `binaryState.ok.invocation`: `[path]` or `[rpkPath, 'connect']`. */
	readonly invocation: readonly string[];
	/** Absolute target config paths, in order. */
	readonly targets: readonly string[];
	/** Absolute resource file paths from the `redpandaConnect.resourceFiles` setting, in order; duplicates are removed here. */
	readonly resourceFiles: readonly string[];
	/**
	 * Absolute env file paths, in order: `redpandaConnect.envFile`'s, then the one generated from
	 * `redpandaConnect.env` (ticket 29). The binary lets the last one win. Empty entries are skipped.
	 */
	readonly envFiles?: readonly (string | undefined)[];
	/** `process.platform`; on anything but `win32`, lint targets are glob-escaped. Default: POSIX. */
	readonly platform?: string;
	/**
	 * `run` only (AD-25): the 127.0.0.1 port the run serves its metrics on. Absent: the HTTP server
	 * stays off (`RUN_FLAGS`).
	 */
	readonly httpPort?: number;
}

export type ArgvResult =
	| { readonly kind: 'ok'; readonly argv: readonly string[] }
	/** `lint` was given no target, or `run` was not given exactly one. */
	| { readonly kind: 'targetCount'; readonly expected: 'atLeastOne' | 'exactlyOne'; readonly actual: number }
	/** The invocation is empty. */
	| { readonly kind: 'emptyInvocation' };

/**
 * `[...invocation, 'lint', --deprecated, --skip-env-var-check, …resources/env…, ...targets]`.
 * Lint expands each target as a glob (`run` does not; 2.4 review): on POSIX the targets are
 * escaped, so `[client]/a.yaml` names that file. Lint still prints the unescaped path.
 */
export function buildLintArgs(input: ArgvInput): ArgvResult {
	if (input.targets.length < 1) {
		return { kind: 'targetCount', expected: 'atLeastOne', actual: input.targets.length };
	}
	const targets = input.platform === 'win32' ? input.targets : input.targets.map(escapeGlob);
	return build('lint', LINT_FLAGS, { ...input, targets });
}

/** Escapes Go `filepath.Match` metacharacters (`\`, `*`, `?`, `[`) with a backslash (POSIX only). */
export function escapeGlob(value: string): string {
	return value.replace(/[\\*?[]/g, (c) => `\\${c}`);
}

/**
 * `[...invocation, 'run', --set, http.enabled=false, …resources/env…, target]`; with `httpPort`,
 * `--set http.enabled=true --set http.address=127.0.0.1:<port>` in place of the first `--set`.
 */
export function buildRunArgs(input: ArgvInput): ArgvResult {
	if (input.targets.length !== 1) {
		return { kind: 'targetCount', expected: 'exactlyOne', actual: input.targets.length };
	}
	return build('run', input.httpPort === undefined ? RUN_FLAGS : metricsRunFlags(input.httpPort), input);
}

export interface BloblArgvInput {
	/** The argv prefix from `binaryState.ok.invocation`. */
	readonly invocation: readonly string[];
	/** Absolute path of the file holding the mapping. */
	readonly mappingFile: string;
	/** Absolute env file paths, in order (see `ArgvInput.envFiles`). */
	readonly envFiles?: readonly (string | undefined)[];
}

/**
 * `[...invocation, 'blobl', (--env-file <path>)*, --file <mappingFile>]`: the AD-21 live parse. With
 * stdin closed (the spawn site's), `blobl` only parses (spike 4.1, B parse-only). `blobl` takes no
 * `--resources`.
 */
export function buildBloblArgs(input: BloblArgvInput): ArgvResult {
	if (input.invocation.length === 0) {
		return { kind: 'emptyInvocation' };
	}
	return {
		kind: 'ok',
		argv: [...input.invocation, 'blobl', ...fileFlags([], input.envFiles), '--file', input.mappingFile],
	};
}

/**
 * `--resources <path>` per unique resource file (first occurrence wins), then `--env-file <path>`
 * per env file, in order (the binary lets the last one win).
 */
export function fileFlags(resourceFiles: readonly string[], envFiles: readonly (string | undefined)[] = []): string[] {
	const flags: string[] = [];
	for (const resource of dedupe(resourceFiles)) {
		flags.push('--resources', resource);
	}
	for (const envFile of envFiles) {
		if (envFile) {
			flags.push('--env-file', envFile);
		}
	}
	return flags;
}

function build(subcommand: string, subcommandFlags: readonly string[], input: ArgvInput): ArgvResult {
	if (input.invocation.length === 0) {
		return { kind: 'emptyInvocation' };
	}
	return {
		kind: 'ok',
		argv: [
			...input.invocation,
			subcommand,
			...subcommandFlags,
			...fileFlags(input.resourceFiles, input.envFiles),
			...input.targets,
		],
	};
}

function dedupe(values: readonly string[]): string[] {
	return [...new Set(values)];
}
