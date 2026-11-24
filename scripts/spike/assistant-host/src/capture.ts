// Spike 65: the capture log. Every stream message, question, approval, hook decision and tool call
// is recorded by shape (types, field names, counts, token counts, timings, short redacted samples)
// to the "Spike: assistant host" output channel and to `<workspace>/.spike-65/run-<time>/events.jsonl`.
// Redactor, shape and errInfo are copied from scripts/spike/adp-probe.mjs (itself from
// metrics-probe.mjs); keep them in step.
import * as fs from 'fs';
import * as path from 'path';

export const SAMPLE_CHARS = 80;
/** Any prefix of a key or a header value this long is redacted (an echoed start of a key). */
export const PREFIX_MIN = 8;
const SECRET_KEY = /^(authorization|x-api-key|api_key|apikey|token|access_token|password|secret|anthropic_api_key|anthropic_auth_token)$/i;

export class Redactor {
	private readonly scrub = new Set<string>();
	private readonly ids = new Map<string, string>();
	secret(v: string | undefined | null): void { if (v != null && String(v).length >= 3) this.scrub.add(String(v)); }
	/** The value and every prefix of it of PREFIX_MIN or more characters. */
	secretWithPrefixes(v: string): void {
		this.secret(v);
		for (let n = PREFIX_MIN; n < v.length; n++) this.scrub.add(v.slice(0, n));
	}
	id(v: string | undefined | null, ph: string): void { if (typeof v === 'string' && v.length >= 3 && !this.ids.has(v)) this.ids.set(v, ph); }
	text(s: unknown): string {
		let out = String(s);
		for (const v of [...this.scrub].sort((a, b) => b.length - a.length)) out = out.split(v).join('<redacted>');
		out = out.replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '<redacted-jwt>');
		out = out.replace(/Bearer\s+(?!<redacted)[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer <redacted>');
		out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<redacted-key>');
		for (const [v, ph] of [...this.ids].sort((a, b) => b[0].length - a[0].length)) out = out.split(v).join(ph);
		out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => (ip === '127.0.0.1' ? ip : '<ip>'));
		out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
		return out;
	}
	value(v: unknown): unknown {
		if (Array.isArray(v)) return v.map((x) => this.value(x));
		if (typeof v === 'bigint') return v.toString();
		if (v && typeof v === 'object') {
			const out: Record<string, unknown> = {};
			for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) && x != null && x !== '' ? '<redacted>' : this.value(x);
			return out;
		}
		if (typeof v === 'string') return this.text(v);
		return v;
	}
	sample(s: unknown): string | null { return s == null ? null : this.text(String(s).slice(0, SAMPLE_CHARS)); }
}

/** Body shape: leaves become their type, arrays their length and first element's shape. */
export function shape(v: unknown, depth = 0): unknown {
	if (depth > 6) return '…';
	if (Array.isArray(v)) return v.length ? [`length ${v.length}`, shape(v[0], depth + 1)] : [];
	if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
	return v === null ? 'null' : typeof v;
}

/** An error as data: name, code, message and nested causes; never a stack. */
export function errInfo(e: unknown, depth = 0): Record<string, unknown> | null {
	if (e == null) return null;
	if (typeof e !== 'object') return { message: String(e) };
	const x = e as Record<string, unknown> & { name?: string; message?: string; cause?: unknown };
	const o: Record<string, unknown> = { name: x.name ?? x.constructor?.name, message: String(x.message ?? e) };
	for (const k of ['code', 'errno', 'syscall', 'reason']) {
		if (x[k] != null && typeof x[k] !== 'object' && typeof x[k] !== 'function') o[k] = x[k];
	}
	if (x.cause && depth < 4) o.cause = errInfo(x.cause, depth + 1);
	return o;
}

export interface Channel { appendLine(line: string): void }

/** One run's events, redacted, as JSON lines and output channel lines. */
export class CaptureLog {
	readonly t0 = Date.now();
	private n = 0;
	private readonly file: string | undefined;
	private stopped = false;
	constructor(readonly dir: string | undefined, private readonly channel: Channel, readonly R: Redactor) {
		if (dir) {
			fs.mkdirSync(dir, { recursive: true });
			this.file = path.join(dir, 'events.jsonl');
			fs.writeFileSync(this.file, '');
		}
	}
	/** Records one event; `data` is redacted before it is written anywhere. */
	event(kind: string, data: Record<string, unknown> = {}): void {
		const rec = this.R.value({ n: ++this.n, ms: Date.now() - this.t0, kind, ...data }) as Record<string, unknown>;
		const line = JSON.stringify(rec);
		if (this.file && !this.stopped && fs.existsSync(this.dir as string)) fs.appendFileSync(this.file, `${line}\n`);
		this.channel.appendLine(`[${String(rec.ms).padStart(7)} ms] ${kind} ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`);
	}
	/** Writes `run.json` (redacted) and scans the run's files for each secret, by name. On a hit the
	 * run's files are deleted (nothing of it is kept) and `clean` is false. */
	finish(run: Record<string, unknown>, secrets: Record<string, string | undefined>): { clean: boolean; hits: { what: string; files: string[] }[] } {
		if (!this.dir) return { clean: true, hits: [] };
		fs.writeFileSync(path.join(this.dir, 'run.json'), `${JSON.stringify(this.R.value(run), null, 2)}\n`);
		const files = fs.readdirSync(this.dir).map((f) => [f, fs.readFileSync(path.join(this.dir as string, f), 'utf8')] as const);
		const hits: { what: string; files: string[] }[] = [];
		for (const [what, v] of Object.entries(secrets)) {
			if (v == null || v.length < 3) continue;
			const inFiles = files.filter(([, t]) => t.includes(v)).map(([f]) => f);
			if (inFiles.length) hits.push({ what, files: inFiles });
		}
		const scan = { clean: hits.length === 0, hits };
		if (!scan.clean) {
			this.stopped = true;
			fs.rmSync(this.dir, { recursive: true, force: true });
			this.channel.appendLine(`leak self-scan HIT (${hits.map((h) => h.what).join(', ')}): this run's capture files were deleted`);
			return scan;
		}
		fs.writeFileSync(path.join(this.dir, 'run.json'), `${JSON.stringify(this.R.value({ ...run, leak_scan: scan }), null, 2)}\n`);
		return scan;
	}
}
