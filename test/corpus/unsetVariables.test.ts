// Ticket 46 (MATCHES_BINARY): the names the extension computes as unset for a config and its
// resource files (`requiredReferences` + `unsetNames`, the Warnings' and Run's check) equal the
// names each pinned binary lists in `required environment variables were not set: [...]` when it
// runs the same files with the same sources: VS Code's environment and the secrets as the child's
// environment, the env file and `redpandaConnect.env`'s generated file as `--env-file`s (in the
// commands' order). One list per file, in the file's order, each use as the binary lists it.
//
// The binaries come from scripts/spike/fetch-binaries.sh, as in corpus.test.ts: a missing one
// skips its version locally and fails it in CI. Two cases are left out on purpose: a
// `${secrets.NAME}` that VS Code's environment happens to set is still warned (user decision,
// 2026-11-10: only Redpanda Cloud sets it), though the binary would read it; and an env file the
// binary rejects (it stops on the file before it lists anything; the extension counts the file's
// variables as not set, as the Environment view shows them ignored).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { buildRunArgs } from '../../src/core/args';
import { readEnvFile } from '../../src/core/envFileRead';
import { requiredReferences } from '../../src/core/envUsage';
import { type EnvironmentInputs, unsetNames } from '../../src/adapters/vscode/environmentModel';
import { runProcess } from '../../src/adapters/redpandaConnect/process';
import { expandResourceEntry } from '../../src/adapters/redpandaConnect/resourceGlob';

const VERSIONS = ['4.100.0', '4.112.0'] as const;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const binaryOf = (ver: string) => path.join(ROOT, '.cache', 'redpanda-connect', ver, 'redpanda-connect');
const IN_CI = !!process.env.CI && process.env.CI !== 'false';
const RUN_TIMEOUT_MS = 30_000;

/** A pipeline that ends on its own once everything is set; `refs` go into a mapping and a comment. */
const config = (...refs: string[]) => [
	'# a comment: ' + refs.join(' '),
	'input:',
	'  generate:',
	'    count: 1',
	'    interval: ""',
	'    mapping: |',
	...refs.map((r, i) => `      root.f${i} = "${r}"`),
	'output:',
	'  drop: {}',
	'',
].join('\n');
const resource = (...refs: string[]) => labelled('c', ...refs);
const labelled = (label: string, ...refs: string[]) => [
	'# ' + refs.join(' '),
	'cache_resources:',
	`  - label: ${label}`,
	'    memory: {}',
	'',
].join('\n');

interface Case {
	readonly name: string;
	readonly config: string;
	readonly resource?: string;
	/** More resource files, by name (beside `resource`, written as `resources.yaml`). */
	readonly resources?: Readonly<Record<string, string>>;
	/** The `resourceFiles` entries, relative to the case's directory (glob patterns too); default: every resource file. */
	readonly entries?: readonly string[];
	/** VS Code's environment plus the secrets with a value (the child's environment). */
	readonly processEnv?: Readonly<Record<string, string>>;
	/** `redpandaConnect.envFile`'s content. */
	readonly envFile?: string;
	/** `redpandaConnect.env`'s variables (its generated env file comes last). */
	readonly setting?: Readonly<Record<string, string>>;
	/** Declared secrets: they reach the child as its environment (`processEnv` here), so the model gets them as secrets. */
	readonly secrets?: Readonly<Record<string, string>>;
}

const CASES: readonly Case[] = [
	{ name: 'UNSET: each use, in comments too', config: config('${A}', '${B}', '${A}') },
	{ name: 'SET: in each source, empty values included', config: config('${S1}', '${S2}', '${S3}', '${S4}', '${U}'),
		processEnv: { S1: '' }, envFile: 'S2=\n', setting: { S3: '' }, secrets: { S4: 'x' } },
	{ name: 'SET: the setting over the env file', config: config('${S5}'), envFile: 'S5=1\n', setting: { S5: '2' } },
	{ name: 'DEFAULT: ${A:x}, ${A:}', config: config('${D1:x}', '${D2:}') },
	{ name: 'NOT_REF: env("A"), ${! A }, ${A:${B}}', config: [
		'# ${! N0 } ${N1:${N2}}',
		'input:',
		'  generate:',
		'    count: 1',
		'    interval: ""',
		'    mapping: |',
		'      root.a = env("N3")',
		'      root.b = "${N4:${N5}}"',
		'output:',
		'  drop: {}',
		'',
	].join('\n') },
	{ name: 'COMMENT_ESCAPED: $${A}', config: config('$${E1}') },
	{ name: 'SECRETS_REF and other names the binary takes', config: config('${secrets.C1}', '${a.b}', '${1A}'), processEnv: { 'a.b': '1' } },
	{ name: 'NO_COLOR: set by the extension', config: config('${NO_COLOR}') },
	{ name: 'RESOURCES: their own list', config: config('${R0}'), resource: resource('${R1}', '${R2:x}', '${R1}') },
	{ name: 'RESOURCES: only the resource file', config: config('${OK:1}'), resource: resource('${R3}') },
	{ name: 'RESOURCES: a glob entry reads every match', config: config('${OK:1}'),
		resources: { 'r1.yaml': labelled('c1', '${G1}'), 'r2.yaml': labelled('c2', '${G2}'), 'x9.yaml': labelled('c3', '${G3}') }, entries: ['r[1-2].yaml'] },
	{ name: 'RESOURCES: * and ? globs', config: config('${OK:1}'),
		resources: { 'r1.yaml': labelled('c1', '${G1}'), 'r2.yaml': labelled('c2', '${G2}') }, entries: ['*1.yaml', 'r?.yam?'] },
	{ name: 'RESOURCES: a glob that matches nothing reads nothing', config: config('${G0}'),
		resources: { 'r1.yaml': labelled('c1', '${G1}') }, entries: ['none*.yaml'] },
];

/** The binary's `not set` lists, one per file, sorted (the files' order in its log is not fixed). */
function binaryLists(output: string): string[] {
	return [...output.matchAll(/required environment variables were not set: \[([^\]]*)\]/g)].map((m) => m[1]).sort();
}

/** The extension's lists: per file, each unset use in order; `entries` expanded as Run's check expands them. */
function extensionLists(c: Case, entries: readonly string[]): string[] {
	const inputs: EnvironmentInputs = {
		setting: Object.entries(c.setting ?? {}).map(([name, value]) => ({ name, value, level: 'user' as const })),
		secrets: Object.entries(c.secrets ?? {}).map(([name, value]) => ({ name, value })),
		...(c.envFile !== undefined ? { envFile: { path: '/env', read: readEnvFile(c.envFile) } } : {}),
		processEnv: c.processEnv ?? {},
		usage: [],
	};
	const texts = [c.config, ...[...new Set(entries.flatMap(expandResourceEntry))].map((f) => fs.readFileSync(f, 'utf8'))];
	const names = texts.map((t) => requiredReferences(t).map((r) => r.name));
	const unset = unsetNames(inputs, names.flat());
	return names.map((n) => n.filter((x) => unset.has(x)).join(' ')).filter((l) => l !== '').sort();
}

for (const ver of VERSIONS) {
	const present = fs.existsSync(binaryOf(ver));
	if (!present && !IN_CI) {
		describe.skip(`unset variables vs redpanda-connect ${ver} (binary missing)`, () => {
			it('matches', () => {});
		});
		continue;
	}
	describe(`unset variables vs redpanda-connect ${ver} (ticket 46, MATCHES_BINARY)`, () => {
		for (const c of CASES) {
			it(c.name, async () => {
				expect(present, `${binaryOf(ver)} is missing; run scripts/spike/fetch-binaries.sh`).toBe(true);
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unset-vars-'));
				try {
					const write = (name: string, text: string) => {
						const file = path.join(dir, name);
						fs.writeFileSync(file, text);
						return file;
					};
					const target = write('config.yaml', c.config);
					const files = { ...(c.resource !== undefined ? { 'resources.yaml': c.resource } : {}), ...c.resources };
					for (const [name, text] of Object.entries(files)) {
						write(name, text);
					}
					const entries = (c.entries ?? Object.keys(files)).map((e) => path.join(dir, e));
					const built = buildRunArgs({
						invocation: [binaryOf(ver)],
						targets: [target],
						resourceFiles: entries,
						envFiles: [
							c.envFile !== undefined ? write('user.env', c.envFile) : undefined,
							c.setting ? write('setting.env', Object.entries(c.setting).map(([k, v]) => `${k}=${v}\n`).join('')) : undefined,
						],
					});
					if (built.kind !== 'ok') {
						throw new Error(JSON.stringify(built));
					}
					const [command, ...args] = built.argv;
					const outcome = await runProcess([command], args, RUN_TIMEOUT_MS, {
						env: { HOME: dir, ...c.processEnv, ...c.secrets },
						cwd: dir,
					});
					expect(outcome.kind === 'exited' || outcome.kind === 'timeout', JSON.stringify(outcome)).toBe(true);
					// The binary logs to stdout by default.
					const output = outcome.kind === 'exited' ? `${outcome.stdout}\n${outcome.stderr}` : outcome.kind === 'timeout' ? outcome.stderr : '';
					expect(extensionLists(c, entries), output).toEqual(binaryLists(output));
				} finally {
					fs.rmSync(dir, { recursive: true, force: true });
				}
			});
		}
	});
}
