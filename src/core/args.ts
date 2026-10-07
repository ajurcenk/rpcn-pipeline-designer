// Pure argv construction for `lint` and `run` (AD-9): the one place where their flags live.
// Spike 1.1 (Q1, Q3, Q5, Q6):
//   - rpk consumes `-v`, `--verbose` and a bare `-`, so they are never passed.
//   - `lint` with no paths exits 0 silently, so lint always gets at least one path.
//   - `run` refuses configs with lint errors; `--chilled` would hide them, so it is never passed.
//   - Every run binds 0.0.0.0:4195; `--set http.enabled=false` keeps per-file runs from colliding.
//   - Lint echoes paths as given, so every path passed here is expected to be absolute.
// Long flag forms only.

/** Lint flags: deprecations become warnings (AD-17); env vars are not required to be set. */
export const LINT_FLAGS: readonly string[] = ['--deprecated', '--skip-env-var-check'];
/** Run flags: the local HTTP server is off so concurrent per-file runs never collide on port 4195. */
export const RUN_FLAGS: readonly string[] = ['--set', 'http.enabled=false'];
/** Never part of a built argv (spike 1.1). */
export const FORBIDDEN_ARGS: readonly string[] = ['--verbose', '-v', '-', '--chilled'];

export interface ArgvInput {
	/** The argv prefix from `binaryState.ok.invocation`: `[path]` or `[rpkPath, 'connect']`. */
	readonly invocation: readonly string[];
	/** Absolute target config paths, in order. */
	readonly targets: readonly string[];
	/** Absolute resource file paths from the `redpandaConnect.resourceFiles` setting, in order; duplicates are removed here. */
	readonly resourceFiles: readonly string[];
	/** Absolute env file path, if any. */
	readonly envFile?: string;
	/** `process.platform`; on anything but `win32`, lint targets are glob-escaped. Default: POSIX. */
	readonly platform?: string;
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

/** `[...invocation, 'run', --set, http.enabled=false, …resources/env…, target]`. */
export function buildRunArgs(input: ArgvInput): ArgvResult {
	if (input.targets.length !== 1) {
		return { kind: 'targetCount', expected: 'exactlyOne', actual: input.targets.length };
	}
	return build('run', RUN_FLAGS, input);
}

/** `--resources <path>` per unique resource file (first occurrence wins), then `--env-file <path>`. */
export function fileFlags(resourceFiles: readonly string[], envFile: string | undefined): string[] {
	const flags: string[] = [];
	for (const resource of dedupe(resourceFiles)) {
		flags.push('--resources', resource);
	}
	if (envFile) {
		flags.push('--env-file', envFile);
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
			...fileFlags(input.resourceFiles, input.envFile),
			...input.targets,
		],
	};
}

function dedupe(values: readonly string[]): string[] {
	return [...new Set(values)];
}
