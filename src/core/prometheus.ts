// A pure Prometheus text (exposition format 0.0.4) parser for pipeline metrics (AD-25, ticket 7.2). It
// reads the families' types from `# TYPE` lines (a family with none takes its type from its name:
// `*_latency_ns` is a summary, the rest counters), and every sample line as its name, its labels (with
// `\\`, `\"` and `\n` escapes) and its value (exponents, `+Inf`, `-Inf`, `NaN`). Timestamps, `# HELP`
// and other comments, empty lines and lines it cannot read are skipped, never thrown on. No `vscode`.

export type MetricType = 'counter' | 'gauge' | 'summary' | 'histogram' | 'untyped';

const TYPES: readonly MetricType[] = ['counter', 'gauge', 'summary', 'histogram', 'untyped'];

export interface PromSample {
	/** The sample's own name (`processor_latency_ns_sum`, not the family's). */
	readonly name: string;
	readonly labels: Readonly<Record<string, string>>;
	readonly value: number;
}

export interface PromText {
	/** The types `# TYPE` lines gave, by family name. */
	readonly types: ReadonlyMap<string, MetricType>;
	readonly samples: readonly PromSample[];
}

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*/;

/** Parses `text`. Never throws. */
export function parsePrometheus(text: string): PromText {
	const types = new Map<string, MetricType>();
	const samples: PromSample[] = [];
	for (const raw of text.split('\n')) {
		const line = raw.replace(/\r$/, '').trim();
		if (line === '') {
			continue;
		}
		if (line.startsWith('#')) {
			const type = /^#\s*TYPE\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(\S+)\s*$/.exec(line);
			if (type && (TYPES as readonly string[]).includes(type[2])) {
				types.set(type[1], type[2] as MetricType);
			}
			continue;
		}
		const sample = parseSample(line);
		if (sample) {
			samples.push(sample);
		}
	}
	return { types, samples };
}

/** One sample line, or `undefined` when it cannot be read. */
function parseSample(line: string): PromSample | undefined {
	const name = NAME.exec(line)?.[0];
	if (!name) {
		return undefined;
	}
	let rest = line.slice(name.length);
	const labels: Record<string, string> = {};
	if (rest.startsWith('{')) {
		const parsed = parseLabels(rest);
		if (!parsed) {
			return undefined;
		}
		Object.assign(labels, parsed.labels);
		rest = rest.slice(parsed.length);
	}
	if (!/^[ \t]/.test(rest)) {
		return undefined;
	}
	const fields = rest.trim().split(/[ \t]+/);
	// A value, then at most a timestamp (ignored).
	if (fields.length < 1 || fields.length > 2) {
		return undefined;
	}
	const value = parseValue(fields[0]);
	return value === undefined ? undefined : { name, labels, value };
}

/** `{a="x",b="y"}` at the start of `text`: its labels and its length, or `undefined`. */
function parseLabels(text: string): { readonly labels: Record<string, string>; readonly length: number } | undefined {
	const labels: Record<string, string> = {};
	let i = 1;
	const skipSpaces = () => {
		while (text[i] === ' ' || text[i] === '\t') {
			i++;
		}
	};
	for (;;) {
		skipSpaces();
		if (text[i] === '}') {
			return { labels, length: i + 1 };
		}
		const key = LABEL_NAME.exec(text.slice(i))?.[0];
		if (!key) {
			return undefined;
		}
		i += key.length;
		skipSpaces();
		if (text[i] !== '=') {
			return undefined;
		}
		i++;
		skipSpaces();
		if (text[i] !== '"') {
			return undefined;
		}
		i++;
		let value = '';
		for (;;) {
			const c = text[i];
			if (c === undefined) {
				return undefined;
			}
			if (c === '"') {
				i++;
				break;
			}
			if (c === '\\') {
				const next = text[i + 1];
				value += next === 'n' ? '\n' : next === '\\' ? '\\' : next === '"' ? '"' : `\\${next ?? ''}`;
				i += 2;
				continue;
			}
			value += c;
			i++;
		}
		labels[key] = value;
		skipSpaces();
		if (text[i] === ',') {
			i++;
		} else if (text[i] !== '}') {
			return undefined;
		}
	}
}

/** A Prometheus float: decimals, exponents, `+Inf`, `-Inf`, `Inf`, `NaN`. */
function parseValue(text: string): number | undefined {
	switch (text.toLowerCase()) {
		case '+inf':
		case 'inf':
			return Infinity;
		case '-inf':
			return -Infinity;
		case 'nan':
			return NaN;
	}
	if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
		return undefined;
	}
	return Number(text);
}

/**
 * The family a sample belongs to and its type: a summary's or histogram's `_sum`, `_count` (and
 * `_bucket`) samples belong to their family. A family no `# TYPE` named is a summary when it ends in
 * `_latency_ns` (Connect's timings), else a counter.
 */
export function familyOf(name: string, types: ReadonlyMap<string, MetricType>): { readonly family: string; readonly type: MetricType } {
	const own = types.get(name);
	if (own) {
		return { family: name, type: own };
	}
	const suffix = /_(sum|count|bucket)$/.exec(name);
	if (suffix) {
		const family = name.slice(0, -suffix[0].length);
		const type = types.get(family);
		if (type === 'summary' || type === 'histogram') {
			return { family, type };
		}
		if (type === undefined && family.endsWith('_latency_ns')) {
			return { family, type: 'summary' };
		}
	}
	return { family: name, type: name.endsWith('_latency_ns') ? 'summary' : 'counter' };
}

/**
 * Ticket 7.4 (AD-25, the Cloud source): `text` (a whole cluster's metrics) with only the `#` lines and
 * the sample lines whose `pipeline_id` label is `pipelineId`; every other sample line (another
 * pipeline's, or a cluster series with no `pipeline_id`) is dropped before parsing. A line is parsed
 * only when it holds the id's text, so the cluster's other series cost a substring search each.
 */
export function onlyPipeline(text: string, pipelineId: string): string {
	const kept: string[] = [];
	for (const raw of text.split('\n')) {
		const line = raw.replace(/\r$/, '').trim();
		if (line.startsWith('#')) {
			kept.push(line);
		} else if (line.includes(pipelineId) && parseSample(line)?.labels.pipeline_id === pipelineId) {
			kept.push(line);
		}
	}
	return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}
