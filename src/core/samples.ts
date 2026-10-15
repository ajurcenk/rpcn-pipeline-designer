// The saved samples file (ticket 4.9, AD-22), pure: each config's samples live in one JSON file beside
// it, `<config without .yaml/.yml>.samples.json`, as `{"version": 1, "mappings": [{label?, path?,
// selected, samples: [{name, content, meta}]}]}`. A labelled processor links to the entry with its
// `label`; an unlabelled one to the entry with its `path` (and no label). New entries are written with
// the label when there is one. Every update returns the next file value, or `undefined` once no entry
// is left (the file is then deleted); an entry left with no samples is removed. No `vscode`: the
// store (`src/adapters/bloblangPanel/sampleStore.ts`) reads and writes the file.

import { isSampleName, type BloblangSample, type InputMeta } from '../shared/bloblangProtocol';

export const SAMPLES_FILE_VERSION = 1;

/** One mapping's samples in the file. */
export interface SampleEntry {
	readonly label?: string;
	readonly path?: string;
	/** The selected sample's name; `null`: none. */
	readonly selected: string | null;
	readonly samples: readonly BloblangSample[];
}

/** The samples file's value. */
export interface SamplesFile {
	readonly version: typeof SAMPLES_FILE_VERSION;
	readonly mappings: readonly SampleEntry[];
}

/** What links a processor to its entry: its label, else its path. */
export interface SampleRef {
	readonly label?: string;
	readonly path: string;
}

/** A change to one mapping's samples. */
export type SampleChange =
	/** Adds the sample and selects it. */
	| { readonly type: 'add'; readonly sample: BloblangSample }
	| { readonly type: 'rename'; readonly from: string; readonly to: string }
	/** Removes the sample; when it was selected, its neighbour (the next, else the previous) is. */
	| { readonly type: 'delete'; readonly name: string }
	| { readonly type: 'select'; readonly name: string }
	/** Saves the content and metadata into the selected sample. */
	| { readonly type: 'edit'; readonly content: string; readonly meta: InputMeta };

/** A parsed samples file, or why it can't be read. */
export type SamplesParse =
	| { readonly ok: true; readonly file: SamplesFile }
	| { readonly ok: false; readonly reason: string };

/** The samples file's name for a config's file name (`orders.yaml` → `orders.samples.json`). */
export function samplesFileName(configName: string): string {
	return `${configName.replace(/\.ya?ml$/i, '')}.samples.json`;
}

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

class ShapeError extends Error {}

function fail(message: string): never {
	throw new ShapeError(message);
}

function readMeta(v: unknown, at: string): InputMeta {
	if (!isObject(v)) {
		fail(`${at} must be an object`);
	}
	const entries: [string, string][] = [];
	for (const key of Object.keys(v)) {
		const value = v[key];
		if (key === '' || typeof value !== 'string') {
			fail(`${at} must map non-empty keys to strings`);
		}
		entries.push([key, value]);
	}
	return Object.fromEntries(entries);
}

function readSample(v: unknown, at: string): BloblangSample {
	if (!isObject(v)) {
		fail(`${at} must be an object`);
	}
	if (!isSampleName(v.name)) {
		fail(`${at}.name must be a string of 1–100 characters`);
	}
	if (typeof v.content !== 'string') {
		fail(`${at}.content must be a string`);
	}
	return { name: v.name, content: v.content, meta: readMeta(v.meta, `${at}.meta`) };
}

function readEntry(v: unknown, at: string): SampleEntry {
	if (!isObject(v)) {
		fail(`${at} must be an object`);
	}
	const { label, path, selected } = v;
	if (label !== undefined && (typeof label !== 'string' || label === '')) {
		fail(`${at}.label must be a non-empty string`);
	}
	if (path !== undefined && (typeof path !== 'string' || path === '')) {
		fail(`${at}.path must be a non-empty string`);
	}
	if (label === undefined && path === undefined) {
		fail(`${at} needs a label or a path`);
	}
	if (!Array.isArray(v.samples)) {
		fail(`${at}.samples must be an array`);
	}
	const samples = v.samples.map((s, i) => readSample(s, `${at}.samples[${i}]`));
	const names = new Set<string>();
	for (const s of samples) {
		if (names.has(s.name)) {
			fail(`${at} has two samples named "${s.name}"`);
		}
		names.add(s.name);
	}
	if (selected !== null && (typeof selected !== 'string' || !names.has(selected))) {
		fail(`${at}.selected must be null or the name of one of its samples`);
	}
	return {
		...(label !== undefined ? { label: label as string } : {}),
		...(path !== undefined ? { path: path as string } : {}),
		selected: selected as string | null,
		samples,
	};
}

/** Parses and validates the samples file's text. Never throws. */
export function parseSamplesFile(text: string): SamplesParse {
	let value: unknown;
	try {
		value = JSON.parse(text.replace(/^﻿/, ''));
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : String(e) };
	}
	try {
		if (!isObject(value)) {
			fail('the file must hold a JSON object');
		}
		if (value.version !== SAMPLES_FILE_VERSION) {
			fail(`version must be ${SAMPLES_FILE_VERSION}`);
		}
		if (!Array.isArray(value.mappings)) {
			fail('mappings must be an array');
		}
		const mappings = value.mappings.map((m, i) => readEntry(m, `mappings[${i}]`));
		const keys = new Set<string>();
		for (const m of mappings) {
			const key = m.label !== undefined ? `label ${JSON.stringify(m.label)}` : `path ${JSON.stringify(m.path)}`;
			if (keys.has(key)) {
				fail(`two mappings have the ${key}`);
			}
			keys.add(key);
		}
		return { ok: true, file: { version: SAMPLES_FILE_VERSION, mappings } };
	} catch (e) {
		return { ok: false, reason: e instanceof ShapeError ? e.message : String(e) };
	}
}

/** The file's text: 2-space indentation and a trailing newline. */
export function serializeSamplesFile(file: SamplesFile): string {
	const mappings = file.mappings.map((m) => ({
		...(m.label !== undefined ? { label: m.label } : {}),
		...(m.path !== undefined ? { path: m.path } : {}),
		selected: m.selected,
		samples: m.samples.map((s) => ({ name: s.name, content: s.content, meta: s.meta })),
	}));
	return `${JSON.stringify({ version: file.version, mappings }, null, 2)}\n`;
}

/** The index of `ref`'s entry in `file`: by label when it has one, else by path (an unlabelled entry). */
function indexOf(file: SamplesFile | undefined, ref: SampleRef): number {
	if (!file) {
		return -1;
	}
	return ref.label !== undefined
		? file.mappings.findIndex((m) => m.label === ref.label)
		: file.mappings.findIndex((m) => m.label === undefined && m.path === ref.path);
}

/** `ref`'s entry in `file`, if any. */
export function entryFor(file: SamplesFile | undefined, ref: SampleRef): SampleEntry | undefined {
	const i = indexOf(file, ref);
	return i < 0 ? undefined : file!.mappings[i];
}

/** `ref`'s samples and selected one (none: `[]` and `null`). */
export function samplesFor(file: SamplesFile | undefined, ref: SampleRef): Pick<SampleEntry, 'samples' | 'selected'> {
	const entry = entryFor(file, ref);
	return entry ? { samples: entry.samples, selected: entry.selected } : { samples: [], selected: null };
}

function sameMeta(a: InputMeta, b: InputMeta): boolean {
	const ka = Object.keys(a);
	return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

/** The entry after `change`; `undefined`: the change does not apply (nothing to write). */
function changed(entry: SampleEntry, change: SampleChange): SampleEntry | undefined {
	const { samples } = entry;
	const has = (name: string) => samples.some((s) => s.name === name);
	switch (change.type) {
		case 'add': {
			if (!isSampleName(change.sample.name) || has(change.sample.name)) {
				return undefined;
			}
			return { ...entry, samples: [...samples, change.sample], selected: change.sample.name };
		}
		case 'rename': {
			const to = change.to.trim();
			if (!has(change.from) || !isSampleName(to) || to === change.from || has(to)) {
				return undefined;
			}
			return {
				...entry,
				samples: samples.map((s) => (s.name === change.from ? { ...s, name: to } : s)),
				selected: entry.selected === change.from ? to : entry.selected,
			};
		}
		case 'delete': {
			const i = samples.findIndex((s) => s.name === change.name);
			if (i < 0) {
				return undefined;
			}
			const rest = samples.filter((_, j) => j !== i);
			const neighbour = rest[i] ?? rest[i - 1];
			const selected = entry.selected !== change.name ? entry.selected : neighbour ? neighbour.name : null;
			return { ...entry, samples: rest, selected };
		}
		case 'select':
			return has(change.name) && entry.selected !== change.name ? { ...entry, selected: change.name } : undefined;
		case 'edit': {
			const at = samples.findIndex((s) => s.name === entry.selected);
			const s = samples[at];
			if (!s || (s.content === change.content && sameMeta(s.meta, change.meta))) {
				return undefined;
			}
			return { ...entry, samples: samples.map((x, j) => (j === at ? { ...x, content: change.content, meta: change.meta } : x)) };
		}
	}
}

/**
 * Applies `change` to `ref`'s samples in `file` (`undefined`: no file yet). `undefined`: nothing
 * changes; else `{file}`, the next file value, `undefined` once it has no entry left.
 */
export function applySampleChange(
	file: SamplesFile | undefined, ref: SampleRef, change: SampleChange,
): { readonly file: SamplesFile | undefined } | undefined {
	const i = indexOf(file, ref);
	const mappings = file?.mappings ?? [];
	const entry: SampleEntry = i >= 0
		? mappings[i]
		: { ...(ref.label !== undefined ? { label: ref.label } : { path: ref.path }), selected: null, samples: [] };
	const next = changed(entry, change);
	if (!next) {
		return undefined;
	}
	const rest = next.samples.length === 0
		? mappings.filter((_, j) => j !== i)
		: i >= 0 ? mappings.map((m, j) => (j === i ? next : m)) : [...mappings, next];
	return { file: rest.length === 0 ? undefined : { version: SAMPLES_FILE_VERSION, mappings: rest } };
}
