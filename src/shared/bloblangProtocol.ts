// The host<->webview contract of the Bloblang test panel (AD-5, tickets 4.2 and 4.4; 4.16 adds
// `addLabelRequested` and the snapshot's `unlabelledPath`; 4.10 its `removed`; 4.17 its `fileName` and
// `samplesFile`; 4.11 `focusEditorRequested`, the graph's): every message of the second webview,
// as discriminated unions on `type`, plus the pure validators both sides use on what they receive.
// The panel adapter (`src/adapters/bloblangPanel`), the core run parser and `webview/src/bloblang` import it; no Bloblang panel message is defined anywhere else. This
// module imports nothing but the graph protocol's `BinaryStatus` type (AD-15).

import type { BinaryStatus } from './protocol';

export type { BinaryStatus };

/** The processor kinds the panel tests (AD-21). */
export type BloblangProcessorKind = 'mapping' | 'mutation';

/** A JSON value: what a message's metadata values are after a run. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Metadata after a run: keys (non-empty) to JSON values. */
export type ResultMeta = Readonly<Record<string, JsonValue>>;

/** Metadata the panel sets on its input (what the `generate` input sets): keys (non-empty) to strings. */
export type InputMeta = Readonly<Record<string, string>>;

/** Top-level keys that the run added, changed and removed, each in document order. */
export interface KeyChanges {
	readonly added: readonly string[];
	readonly changed: readonly string[];
	readonly removed: readonly string[];
}

/**
 * What a run changed, top-level keys only: of the content (`null` when the input or the output is
 * not a JSON object) and of the metadata.
 */
export interface BloblangChanges {
	readonly fields: KeyChanges | null;
	readonly meta: KeyChanges;
}

/**
 * The outcome of one test run (AD-21). Lines and chars are 1-based; `mapping*` positions are in the
 * Bloblang, `file*` positions in the YAML document (a `vscode.Position`'s line and character plus 1).
 * - `ok`: the output content, its metadata and what changed;
 * - `failed`: the mapping's own error on the input, with where it happened when known;
 * - `parseError`: the Bloblang does not parse;
 * - `invalidInput`: the input could not be used;
 * - `deleted`: the mapping deleted the message;
 * - `error`: any other failure (the binary's stderr, verbatim).
 */
export type BloblangResult =
	| { readonly kind: 'ok'; readonly content: string; readonly meta: ResultMeta; readonly changes: BloblangChanges }
	| { readonly kind: 'failed'; readonly message: string; readonly mappingLine?: number; readonly fileLine?: number }
	| {
		readonly kind: 'parseError';
		readonly message: string;
		readonly excerpt: string;
		readonly mappingLine: number;
		readonly mappingChar: number;
		readonly fileLine: number;
		readonly fileChar: number;
	}
	| { readonly kind: 'invalidInput'; readonly message: string }
	| { readonly kind: 'deleted' }
	| { readonly kind: 'error'; readonly message: string };

/** The longest sample name. */
export const MAX_SAMPLE_NAME_LENGTH = 100;

/** A saved input: its name (1 to MAX_SAMPLE_NAME_LENGTH characters), content and metadata. */
export interface BloblangSample {
	readonly name: string;
	readonly content: string;
	readonly meta: InputMeta;
}

/** host→webview */
export type BloblangHostMessage =
	/**
	 * The panel's whole state, sent on `ready`: its title, the processor's kind and Bloblang, the
	 * binary's status, the samples and the selected one (`null`: none). `samplesError` (4.9): the
	 * samples file can't be read, and why (the samples are then `[]` and `null`). `unlabelledPath`
	 * (4.16): the processor has no label and the config is saved, so its samples are linked by this
	 * path (the panel offers Add label). `removed` (4.10): the processor is not in the file any more;
	 * the panel shows the removed notice (title, kind and source are the last ones it had).
	 * `fileName` and `samplesFile` (4.17): the config's file name and its samples file's name now
	 * (a rename changes them); the webview prefers them over the page's `data-file` and `data-samples`.
	 */
	| {
		readonly type: 'snapshot';
		readonly title: string;
		readonly kind: BloblangProcessorKind;
		readonly source: string;
		readonly binary: BinaryStatus;
		readonly samples: readonly BloblangSample[];
		readonly selected: string | null;
		readonly samplesError?: string;
		readonly unlabelledPath?: string;
		readonly removed?: true;
		readonly fileName?: string;
		readonly samplesFile?: string;
	}
	/** The result of the latest `run`, how long it took, and the binary that ran it (`null`: none). */
	| { readonly type: 'result'; readonly result: BloblangResult; readonly durationMs: number; readonly binary: string | null }
	/** The samples changed; `samplesError` as in `snapshot`. */
	| { readonly type: 'samples'; readonly samples: readonly BloblangSample[]; readonly selected: string | null; readonly samplesError?: string }
	/** The binary's status changed. */
	| { readonly type: 'binary'; readonly status: BinaryStatus };

/** webview→host */
export type BloblangWebviewMessage =
	| { readonly type: 'ready' }
	/** Run the mapping on this input: the message content as typed, and its metadata. */
	| { readonly type: 'run'; readonly content: string; readonly meta: InputMeta }
	/** The input was edited (saved into the selected sample, if any). */
	| { readonly type: 'inputEdited'; readonly content: string; readonly meta: InputMeta }
	| { readonly type: 'sampleAdded'; readonly name: string }
	| { readonly type: 'sampleRenamed'; readonly from: string; readonly to: string }
	| { readonly type: 'sampleDeleted'; readonly name: string }
	| { readonly type: 'sampleSwitched'; readonly name: string }
	/** Reveal this (1-based) line of the YAML document. */
	| { readonly type: 'goToLine'; readonly line: number }
	| { readonly type: 'installGuideRequested' }
	| { readonly type: 'setPathRequested' }
	| { readonly type: 'retryRequested' }
	/** Add label (4.16): ask for a label for the unlabelled processor and relink its samples. */
	| { readonly type: 'addLabelRequested' }
	/** Esc in the panel (4.11): focus the YAML editor, its cursor unchanged (the graph's message). */
	| { readonly type: 'focusEditorRequested' };

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isKind = (v: unknown): v is BloblangProcessorKind => v === 'mapping' || v === 'mutation';
const isBinaryStatus = (v: unknown): v is BinaryStatus => v === 'ok' || v === 'missing' || v === 'invalid' || v === 'unresolved';
/** A 1-based line or char. */
const isPosition = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const isOptionalPosition = (v: unknown): boolean => v === undefined || isPosition(v);
/** Absent, or a non-empty string (a file name). */
const isOptionalName = (v: unknown): boolean => v === undefined || (isString(v) && v !== '');
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

/** A valid sample name: a non-empty string of at most MAX_SAMPLE_NAME_LENGTH characters. */
export function isSampleName(v: unknown): v is string {
	return isString(v) && v.length > 0 && v.length <= MAX_SAMPLE_NAME_LENGTH;
}

/** A JSON value; `ancestors` holds the objects and arrays above it, so a cycle is rejected. */
function isJsonValue(v: unknown, ancestors: unknown[] = []): v is JsonValue {
	if (v === null || isString(v) || typeof v === 'boolean') {
		return true;
	}
	if (typeof v === 'number') {
		return Number.isFinite(v);
	}
	if (typeof v !== 'object' || ancestors.includes(v)) {
		return false;
	}
	ancestors.push(v);
	const ok = Array.isArray(v)
		? v.every((item) => isJsonValue(item, ancestors))
		: Object.keys(v).every((key) => isJsonValue((v as Obj)[key], ancestors));
	ancestors.pop();
	return ok;
}

function isResultMeta(v: unknown): v is ResultMeta {
	return isObject(v) && Object.keys(v).every((key) => key !== '' && isJsonValue(v[key]));
}

function isInputMeta(v: unknown): v is InputMeta {
	return isObject(v) && Object.keys(v).every((key) => key !== '' && isString(v[key]));
}

function isKeyChanges(v: unknown): v is KeyChanges {
	return isObject(v) && isStringArray(v.added) && isStringArray(v.changed) && isStringArray(v.removed);
}

function isChanges(v: unknown): v is BloblangChanges {
	return isObject(v) && (v.fields === null || isKeyChanges(v.fields)) && isKeyChanges(v.meta);
}

function isResult(r: unknown): r is BloblangResult {
	if (!isObject(r)) {
		return false;
	}
	switch (r.kind) {
		case 'ok':
			return isString(r.content) && isResultMeta(r.meta) && isChanges(r.changes);
		case 'failed':
			return isString(r.message) && isOptionalPosition(r.mappingLine) && isOptionalPosition(r.fileLine);
		case 'parseError':
			return isString(r.message) && isString(r.excerpt)
				&& isPosition(r.mappingLine) && isPosition(r.mappingChar) && isPosition(r.fileLine) && isPosition(r.fileChar);
		case 'invalidInput':
		case 'error':
			return isString(r.message);
		case 'deleted':
			return true;
		default:
			return false;
	}
}

function isSample(v: unknown): v is BloblangSample {
	return isObject(v) && isSampleName(v.name) && isString(v.content) && isInputMeta(v.meta);
}

/**
 * Samples with distinct names, `selected` either `null` or one of them, and `samplesError` absent or
 * a string.
 */
function isSamples(samples: unknown, selected: unknown, samplesError: unknown): boolean {
	if (!Array.isArray(samples) || !samples.every(isSample) || !(samplesError === undefined || isString(samplesError))) {
		return false;
	}
	const names = samples.map((s: BloblangSample) => s.name);
	return new Set(names).size === names.length && (selected === null || (isString(selected) && names.includes(selected)));
}

/** Validates a message from the host; it is returned unchanged when well formed. */
export function parseBloblangHostMessage(message: unknown): BloblangHostMessage | undefined {
	try {
		if (!isObject(message)) {
			return undefined;
		}
		let ok: boolean;
		switch (message.type) {
			case 'snapshot':
				ok = isString(message.title) && isKind(message.kind) && isString(message.source)
					&& isBinaryStatus(message.binary) && isSamples(message.samples, message.selected, message.samplesError)
					&& (message.unlabelledPath === undefined || (isString(message.unlabelledPath) && message.unlabelledPath !== ''))
					&& (message.removed === undefined || message.removed === true)
					&& isOptionalName(message.fileName) && isOptionalName(message.samplesFile);
				break;
			case 'result':
				ok = isResult(message.result)
					&& typeof message.durationMs === 'number' && Number.isFinite(message.durationMs) && message.durationMs >= 0
					&& (message.binary === null || isString(message.binary));
				break;
			case 'samples':
				ok = isSamples(message.samples, message.selected, message.samplesError);
				break;
			case 'binary':
				ok = isBinaryStatus(message.status);
				break;
			default:
				ok = false;
		}
		return ok ? message as unknown as BloblangHostMessage : undefined;
	} catch {
		return undefined;
	}
}

/** A fresh copy of input metadata (own keys as data, so `__proto__` stays a key), or `undefined`. */
function copyInputMeta(v: unknown): InputMeta | undefined {
	if (!isObject(v)) {
		return undefined;
	}
	const entries: [string, string][] = [];
	for (const key of Object.keys(v)) {
		const value = v[key];
		if (key === '' || !isString(value)) {
			return undefined;
		}
		entries.push([key, value]);
	}
	return Object.fromEntries(entries);
}

/** Validates a message from the webview; a fresh, typed copy with only the message's own fields. */
export function parseBloblangWebviewMessage(message: unknown): BloblangWebviewMessage | undefined {
	try {
		if (!isObject(message)) {
			return undefined;
		}
		switch (message.type) {
			case 'ready':
			case 'installGuideRequested':
			case 'setPathRequested':
			case 'retryRequested':
			case 'addLabelRequested':
			case 'focusEditorRequested':
				return { type: message.type };
			case 'run':
			case 'inputEdited': {
				const content = message.content;
				const meta = copyInputMeta(message.meta);
				return isString(content) && meta ? { type: message.type, content, meta } : undefined;
			}
			case 'sampleAdded':
			case 'sampleDeleted':
			case 'sampleSwitched': {
				const name = message.name;
				return isSampleName(name) ? { type: message.type, name } : undefined;
			}
			case 'sampleRenamed': {
				const { from, to } = message;
				return isSampleName(from) && isSampleName(to) ? { type: 'sampleRenamed', from, to } : undefined;
			}
			case 'goToLine': {
				const line = message.line;
				return isPosition(line) ? { type: 'goToLine', line } : undefined;
			}
			default:
				return undefined;
		}
	} catch {
		return undefined;
	}
}
