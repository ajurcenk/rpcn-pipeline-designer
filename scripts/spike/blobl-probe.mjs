#!/usr/bin/env node
// Spike 4.1: run a fixed Bloblang scenario set through three execution routes on every binary
// flavor and record raw evidence plus timings. Started by scripts/spike/blobl-probe.sh.
//
// Routes:
//   A  `blobl server --no-open -p <free port>` and `POST /execute` {mapping, input, metadata}
//   B  `blobl -f <mapping file>` with the input on stdin (no bare `-`: rpk swallows it)
//   C  `run` on a temporary one-message config: a `generate` input sets the sample's content and
//      metadata, the mapping under test runs, a final step writes {content, meta} or {error}
//
// Flavors: standalone-4.100.0, standalone-4.112.0 (.cache/, from fetch-binaries.sh) and
// rpk-4.112.0 (the user's `rpk connect`, read-only; skipped unless its managed binary reports
// 4.112.0, as in run-matrix.sh; when skipped, existing rpk captures are left untouched).
//
// Outputs (re-generated on every run; a rerun changes only timings.tsv):
//   <findings>/captures/<flavor>/invocation.txt                       what <BIN> stands for
//   <findings>/captures/<flavor>/server-help.{stdout,stderr,exit}     the server-missing scenario
//   <findings>/captures/<flavor>/<route>/<scenario>.{request,stdout,stderr,exit}
//   <findings>/captures/<flavor>/B/<scenario>.parse-only.{stdout,stderr,exit}  stdin closed (ok, map-error, parse-error)
//   <findings>/captures/<flavor>/A/server.{stdout,stderr,exit,check}  the route A server child
//   <findings>/captures/summary.tsv                                    one row per flavor/route/scenario
//   <findings>/captures/diff-*.txt                                     flavor-to-flavor diffs
//   <findings>/captures/timings.tsv                                    p50/p95, cold and warm (not stable)
// Temporary mapping and config files live in .cache/blobl-probe/ (git-ignored).
//
// Normalisation: the repo root becomes <ROOT>; logfmt time="..." becomes time="<TS>"; Go log
// timestamps (2006/01/02 15:04:05) become <TS>; the route A port becomes <PORT>; any line that
// mentions a licence is dropped; `run` stderr is sorted (log lines race).
// Every child gets NO_COLOR=1 and is spawned without a shell (AD-9).
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE = path.join(ROOT, '.cache/redpanda-connect');
const TMP = path.join(ROOT, '.cache/blobl-probe');
const FINDINGS = path.join(ROOT, '_bmad-output/initiative-rpcn-vscode-designer/epic-bloblang-check-and-test/spike-4-1-findings');
const CAPS = path.join(FINDINGS, 'captures');
const VERSIONS = ['4.100.0', '4.112.0'];
const RPK_VERSION = '4.112.0';
const RPK_MANAGED = path.join(os.homedir(), '.local/bin/.rpk.managed-connect');
const TIMEOUT_MS = 60_000;     // hard cap for any one child
const READY_MS = 30_000;       // server must answer within this
const FETCH_MS = 5_000;       // abort any one HTTP request after this
const STOP_GRACE_MS = 10_000;  // SIGINT, then SIGKILL
const RUNS = Number(process.env.BLOBL_PROBE_RUNS ?? 20);

const ENV = { ...process.env, NO_COLOR: '1' };

/** The matrix scenarios (the server-missing scenario is the per-flavor server-help capture). */
const SCENARIOS = [
	{ name: 'ok', mapping: 'root.a = this.x + 1\nroot.b = "set"', input: '{"x":1}', meta: {} },
	{ name: 'meta-in', mapping: 'root.k = @key', input: '{}', meta: { key: 'k1' } },
	{ name: 'meta-out', mapping: 'meta out = "x"\nroot = this', input: '{"a":1}', meta: {} },
	{ name: 'deleted', mapping: 'root = deleted()', input: '{"a":1}', meta: {} },
	{ name: 'map-error', mapping: 'root.a = 1\nroot.b = this.nope.number()', input: '{}', meta: {} },
	{ name: 'parse-error', mapping: 'root.a = 1\nroot.b = this.foo.bar(\nroot.c = 3', input: '{}', meta: {} },
	{ name: 'bad-input', mapping: 'root = this', input: 'not json', meta: {} },
	{ name: 'raw-input', mapping: 'root = content().uppercase()', input: 'hello raw', meta: {} },
	{ name: 'multi-line', mapping: 'root = this', input: '{\n  "a": 1,\n  "b": 2\n}', meta: {} },
	// not in the matrix: tells a deleted message apart from an empty result
	{ name: 'empty-string', mapping: 'root = ""', input: '{"a":1}', meta: {} },
];

function die(msg) {
	console.error(`blobl-probe: ${msg}`);
	process.exit(1);
}

let currentPort = 0;
function normalize(text, { sort = false } = {}) {
	let out = text.split(ROOT).join('<ROOT>')
		.replace(/time="[^"]*"/g, 'time="<TS>"')
		.replace(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/g, '<TS>');
	if (currentPort) out = out.split(`:${currentPort}`).join(':<PORT>');
	let lines = out.split('\n').filter((l) => !/licen[cs]e/i.test(l));
	if (sort) {
		const trailing = lines.at(-1) === '';
		if (trailing) lines.pop();
		lines = lines.sort();
		if (trailing) lines.push('');
	}
	return lines.join('\n');
}

function write(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

/** Spawn without a shell; resolves {code, signal, stdout, stderr, ms}. */
function runChild(cmd, args, { stdin } = {}) {
	return new Promise((resolve) => {
		const t0 = performance.now();
		const child = spawn(cmd, args, { env: ENV, cwd: TMP, shell: false, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c; });
		child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c; });
		const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
		child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr: stderr + String(err), ms: performance.now() - t0 }); });
		child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, ms: performance.now() - t0 }); });
		if (stdin !== undefined) child.stdin.end(stdin);
	});
}

function freePort() {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.once('error', reject);
		s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts `blobl server`; resolves once POST /execute answers. */
async function startServer(inv) {
	const port = await freePort();
	const t0 = performance.now();
	const child = spawn(inv[0], [...inv.slice(1), 'blobl', 'server', '--no-open', '-p', String(port)], { env: ENV, cwd: TMP, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
	const srv = { child, port, t0, stdout: '', stderr: '', exited: false };
	child.stdout.setEncoding('utf8').on('data', (c) => { srv.stdout += c; });
	child.stderr.setEncoding('utf8').on('data', (c) => { srv.stderr += c; });
	srv.done = new Promise((resolve) => child.on('close', (code, signal) => { srv.exited = true; resolve({ code, signal }); }));
	child.on('error', () => { srv.exited = true; });
	while (performance.now() - t0 < READY_MS) {
		if (srv.exited) return srv;
		try {
			await execute(srv, { mapping: 'root = this', input: '{}' });
			srv.ready = true;
			return srv;
		} catch {
			await sleep(2);
		}
	}
	return srv;
}

async function stopServer(srv) {
	if (!srv.exited) {
		srv.child.kill('SIGINT');
		const killer = setTimeout(() => srv.child.kill('SIGKILL'), STOP_GRACE_MS);
		const r = await srv.done;
		clearTimeout(killer);
		return r;
	}
	return srv.done;
}

async function execute(srv, body) {
	const res = await fetch(`http://localhost:${srv.port}/execute`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(FETCH_MS) });
	return { status: res.status, text: await res.text() };
}

function quantile(sorted, q) {
	if (sorted.length === 0) return NaN;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
	return sorted[i];
}

const timings = [];
function recordTiming(flavor, route, scenario, mode, samples) {
	const s = [...samples].sort((a, b) => a - b);
	timings.push([flavor, route, scenario, mode, String(s.length), quantile(s, 0.5).toFixed(1), quantile(s, 0.95).toFixed(1)]);
}

const summary = [];
function firstLine(text) {
	const l = text.split('\n').find((x) => x.trim() !== '') ?? '';
	return l.length > 120 ? `${l.slice(0, 117)}...` : l;
}

/** Route C config: a generate input sets content and metadata; the mapping; a reporting step. */
function routeCConfig(sc) {
	const ind = (text, n) => text.split('\n').map((l) => ' '.repeat(n) + l).join('\n');
	const gen = [`root = ${JSON.stringify(sc.input)}`, ...Object.entries(sc.meta).map(([k, v]) => `meta ${k} = ${JSON.stringify(v)}`)].join('\n');
	return [
		'http:',
		'  enabled: false',
		'logger:',
		'  level: warn',
		'input:',
		'  generate:',
		'    count: 1',
		'    interval: ""',
		'    mapping: |',
		ind(gen, 6),
		'pipeline:',
		'  processors:',
		'    - mapping: |',
		ind(sc.mapping, 8),
		'    - mapping: |',
		'        root = if errored() { {"error": error()} } else { {"content": content().string(), "meta": @} }',
		'output:',
		'  stdout:',
		'    codec: lines',
		'',
	].join('\n');
}

async function runFlavor(flavor, inv) {
	const out = path.join(CAPS, flavor);
	fs.rmSync(out, { recursive: true, force: true });
	fs.mkdirSync(out, { recursive: true });
	console.log(`[${flavor}] probing`);
	const [cmd, ...pre] = inv;
	// requests show the invocation as <BIN> so flavor diffs show only behaviour differences
	write(path.join(out, 'invocation.txt'), normalize(`<BIN> = ${inv.join(' ')}\n`));

	// server-missing: does `blobl server` exist on this flavor?
	const help = await runChild(cmd, [...pre, 'blobl', 'server', '--help']);
	write(path.join(out, 'server-help.stdout'), normalize(help.stdout));
	write(path.join(out, 'server-help.stderr'), normalize(help.stderr));
	write(path.join(out, 'server-help.exit'), `${help.code}\n`);
	const serverAvailable = help.code === 0 && /blobl server/.test(help.stdout);
	summary.push([flavor, 'A', 'server-missing', String(help.code), serverAvailable ? 'available' : 'unavailable']);

	// --- Route A ---
	const dirA = path.join(out, 'A');
	fs.mkdirSync(dirA, { recursive: true });
	if (!serverAvailable) {
		write(path.join(dirA, 'UNAVAILABLE'), 'blobl server --help did not succeed on this flavor; route A unavailable\n');
	} else {
		const srv = await startServer(inv);
		currentPort = srv.port;
		const passed = srv.ready === true;
		write(path.join(dirA, 'server.check'), `ready=${passed ? 'yes' : 'no'}\nport_passed_through=${passed ? 'yes' : 'no'}\n`);
		for (const sc of SCENARIOS) {
			const body = { mapping: sc.mapping, input: sc.input, metadata: sc.meta };
			write(path.join(dirA, `${sc.name}.request`), `POST /execute\n${JSON.stringify(body, null, 2)}\n`);
			if (!passed) continue;
			const r = await execute(srv, body);
			write(path.join(dirA, `${sc.name}.stdout`), normalize(r.text));
			write(path.join(dirA, `${sc.name}.exit`), `http=${r.status}\n`);
			summary.push([flavor, 'A', sc.name, `http=${r.status}`, firstLine(r.text)]);
			const warm = [];
			for (let i = 0; i < RUNS; i++) {
				const t0 = performance.now();
				await execute(srv, body);
				warm.push(performance.now() - t0);
			}
			recordTiming(flavor, 'A', sc.name, 'warm', warm);
		}
		const ended = await stopServer(srv);
		write(path.join(dirA, 'server.stdout'), normalize(srv.stdout));
		write(path.join(dirA, 'server.stderr'), normalize(srv.stderr));
		write(path.join(dirA, 'server.exit'), `${ended.code ?? ended.signal}\n`);
		currentPort = 0;

		// cold: launch, wait until /execute answers, run the scenario, stop
		for (const sc of SCENARIOS) {
			const cold = [];
			for (let i = 0; i < RUNS; i++) {
				const s = await startServer(inv);
				if (s.ready) {
					await execute(s, { mapping: sc.mapping, input: sc.input, metadata: sc.meta });
					cold.push(performance.now() - s.t0);
				}
				await stopServer(s);
			}
			recordTiming(flavor, 'A', sc.name, 'cold', cold);
		}
	}

	// --- Route B ---
	const dirB = path.join(out, 'B');
	fs.mkdirSync(dirB, { recursive: true });
	for (const sc of SCENARIOS) {
		const mf = path.join(TMP, `${sc.name}.blobl`);
		fs.writeFileSync(mf, sc.mapping);
		const args = [...pre, 'blobl', '-f', mf];
		const metaNote = Object.keys(sc.meta).length ? `# metadata ${JSON.stringify(sc.meta)}: not expressible on this route\n` : '';
		write(path.join(dirB, `${sc.name}.request`), normalize(`argv: <BIN> ${args.slice(pre.length).join(' ')}\n${metaNote}--- mapping file ---\n${sc.mapping}\n--- stdin ---\n${sc.input}\n`));
		const r = await runChild(cmd, args, { stdin: sc.input });
		write(path.join(dirB, `${sc.name}.stdout`), normalize(r.stdout));
		write(path.join(dirB, `${sc.name}.stderr`), normalize(r.stderr));
		write(path.join(dirB, `${sc.name}.exit`), `${r.code}\n`);
		summary.push([flavor, 'B', sc.name, String(r.code), firstLine(r.stdout) || `stderr: ${firstLine(r.stderr)}`]);
		const cold = [];
		for (let i = 0; i < RUNS; i++) cold.push((await runChild(cmd, args, { stdin: sc.input })).ms);
		recordTiming(flavor, 'B', sc.name, 'cold', cold);
		// parse-only: stdin closed (the AD-9 runners' stdio 'ignore'), so no message is mapped
		if (sc.name === 'ok' || sc.name === 'parse-error' || sc.name === 'map-error') {
			const p = await runChild(cmd, args);
			write(path.join(dirB, `${sc.name}.parse-only.stdout`), normalize(p.stdout));
			write(path.join(dirB, `${sc.name}.parse-only.stderr`), normalize(p.stderr));
			write(path.join(dirB, `${sc.name}.parse-only.exit`), `${p.code}\n`);
			summary.push([flavor, 'B', `${sc.name} (parse-only)`, String(p.code), firstLine(p.stdout) || `stderr: ${firstLine(p.stderr)}`]);
		}
	}

	// --- Route C ---
	const dirC = path.join(out, 'C');
	fs.mkdirSync(dirC, { recursive: true });
	for (const sc of SCENARIOS) {
		const cf = path.join(TMP, `${sc.name}.yaml`);
		const config = routeCConfig(sc);
		fs.writeFileSync(cf, config);
		const args = [...pre, 'run', cf];
		write(path.join(dirC, `${sc.name}.request`), normalize(`argv: <BIN> ${args.slice(pre.length).join(' ')}\n--- config ---\n${config}`));
		const r = await runChild(cmd, args);
		write(path.join(dirC, `${sc.name}.stdout`), normalize(r.stdout));
		write(path.join(dirC, `${sc.name}.stderr`), normalize(r.stderr, { sort: true }));
		write(path.join(dirC, `${sc.name}.exit`), `${r.code}\n`);
		summary.push([flavor, 'C', sc.name, String(r.code), firstLine(r.stdout) || `stderr: ${firstLine(normalize(r.stderr, { sort: true }))}`]);
		const cold = [];
		for (let i = 0; i < RUNS; i++) cold.push((await runChild(cmd, args)).ms);
		recordTiming(flavor, 'C', sc.name, 'cold', cold);
	}
}

function diffDirs(a, b, file) {
	const r = spawnSync('diff', ['-r', a, b], { cwd: CAPS, encoding: 'utf8', env: ENV });
	if (r.status === null || r.status > 1) die(`diff ${a} ${b} failed: ${r.stderr}`);
	write(path.join(CAPS, file), r.stdout);
}

async function main() {
	for (const v of VERSIONS) {
		const bin = path.join(CACHE, v, 'redpanda-connect');
		try { fs.accessSync(bin, fs.constants.X_OK); } catch { die(`missing ${bin}; run scripts/spike/fetch-binaries.sh`); }
	}
	fs.rmSync(TMP, { recursive: true, force: true });
	fs.mkdirSync(TMP, { recursive: true });
	fs.mkdirSync(CAPS, { recursive: true });

	for (const v of VERSIONS) await runFlavor(`standalone-${v}`, [path.join(CACHE, v, 'redpanda-connect')]);

	const hasRpk = spawnSync('rpk', ['version'], { env: ENV, stdio: 'ignore' }).status === 0;
	const managed = spawnSync(RPK_MANAGED, ['--version'], { env: ENV, encoding: 'utf8' });
	const rpkOk = hasRpk && managed.status === 0 && managed.stdout.split('\n').includes(`Version: ${RPK_VERSION}`);
	if (rpkOk) {
		await runFlavor(`rpk-${RPK_VERSION}`, ['rpk', 'connect']);
	} else {
		console.log(`[rpk-${RPK_VERSION}] skipped: rpk or its managed connect ${RPK_VERSION} binary not present (nothing installed; existing rpk captures left untouched)`);
	}

	// summary and timings only describe the flavors probed in this run
	summary.sort((x, y) => x.join('\t').localeCompare(y.join('\t')));
	write(path.join(CAPS, 'summary.tsv'), ['flavor\troute\tscenario\texit\tfirst_output_line', ...summary.map((r) => r.join('\t'))].join('\n') + '\n');
	write(path.join(CAPS, 'timings.tsv'), [`# ${RUNS} runs per row; ms; ${new Date().toISOString().slice(0, 10)}; ${os.platform()} ${os.arch()}`, 'flavor\troute\tscenario\tmode\tn\tp50_ms\tp95_ms', ...timings.map((r) => r.join('\t'))].join('\n') + '\n');

	diffDirs('standalone-4.100.0', 'standalone-4.112.0', 'diff-standalone-4.100.0-vs-standalone-4.112.0.txt');
	if (rpkOk) diffDirs(`standalone-${RPK_VERSION}`, `rpk-${RPK_VERSION}`, `diff-standalone-${RPK_VERSION}-vs-rpk-${RPK_VERSION}.txt`);

	fs.rmSync(TMP, { recursive: true, force: true });
	console.log(`done: captures in ${path.relative(ROOT, CAPS)}`);
}

main().catch((err) => die(err?.stack ?? String(err)));
