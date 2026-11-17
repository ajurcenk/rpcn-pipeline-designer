// Pure: a config and the resources of its resource files (`redpandaConnect.resourceFiles`) as the one config
// text Redpanda Cloud is sent (story 42). A local run loads the files with `--resources`; the Cloud takes one
// `config_yaml`, so the files' top-level `*_resources` lists go into it, every resource of every file (no
// reference scan, as `--resources` loads them all). The merge is text-based, so the config's own bytes
// (comments, order, quoting, line endings) stay as written and only text is added, in the config's line ending:
//   - a kind the config already lists (a block list): the file's items, re-indented to the config list's
//     indent, inserted after its last item;
//   - a kind the config has with no value (`key:`, `~`, `[]`): the file's items as that key's value;
//   - a kind it does not list: the file's whole `<kind>_resources:` block appended at the end (before a final
//     `...` line), after a blank line (a later file's items then join that block).
// Refused, naming the file and why: a file that is not valid YAML, holds more than one document, is not a
// map or does not resolve alone (an alias without its anchor); a list that can't be joined (a flow list, or a
// value that is not a list); a resource that is not a map or has no label; a label of one kind defined twice
// (in the config and a file, in two files, or twice in one file), with both places. After each file the
// result is read again: every key of the config must read as before, and each joined list as the config's
// items followed by each file's (as the file reads alone); otherwise refused (an anchor, an alias or a block
// scalar the added text would change). No files: the config text unchanged.

import { isDeepStrictEqual } from 'util';
import { type Document, isMap, isScalar, isSeq, type Node, type Pair, type YAMLMap } from 'yaml';
import { labelOf, pairOf } from './componentId';
import { lineOf } from './textLines';
import { parseYaml } from './yamlPath';

/** The five top-level resource lists (as `DETECTION_KEYS` names them), in that order. */
export const RESOURCE_KEYS: readonly string[] = ['cache_resources', 'rate_limit_resources', 'processor_resources', 'input_resources', 'output_resources'];

const BOM = '﻿';

/** A resource file: how messages name it, and its text. */
export interface ResourceFileText {
	readonly path: string;
	readonly text: string;
}

export interface MergeProblem {
	/** The text shown, the file (and line) included. */
	readonly message: string;
}

export type MergedResources =
	/** `from`: the files that added resources (none: `text` is the config's). */
	| { readonly kind: 'merged'; readonly text: string; readonly from: readonly string[] }
	| { readonly kind: 'refused'; readonly problems: readonly MergeProblem[] };

/** `cache_resources` → `cache`, `rate_limit_resources` → `rate limit`. */
function kindName(key: string): string {
	return key.replace(/_resources$/, '').replace(/_/g, ' ');
}

type Read = { readonly doc: Document.Parsed; readonly map: YAMLMap } | { readonly empty: true } | { readonly problem: string };

/** The one map document of `text`, or why there is none (`empty`: no content at all). */
function mapOf(text: string, name: string): Read {
	const parsed = parseYaml(text);
	if (!parsed) {
		return { problem: `${name} is not valid YAML` };
	}
	const errors = parsed.docs.flatMap((d) => d.errors);
	if (errors.length > 0) {
		const first = errors[0];
		return { problem: `${name} is not valid YAML (line ${lineOf(text, first.pos[0])}: ${first.message.split('\n')[0]})` };
	}
	const docs = parsed.docs.filter((d) => d.contents !== null);
	if (docs.length === 0) {
		return { empty: true };
	}
	if (docs.length > 1) {
		return { problem: `${name} holds more than one YAML document` };
	}
	const contents = docs[0].contents;
	return isMap(contents) ? { doc: docs[0], map: contents } : { problem: `${name} is not a YAML map` };
}

/** The document's value as a plain object, or why it can't be read (an alias without its anchor). */
function valueOf(doc: Document.Parsed): { readonly value: Record<string, unknown> } | { readonly error: string } {
	try {
		const value: unknown = doc.toJS();
		return { value: value !== null && typeof value === 'object' ? value as Record<string, unknown> : {} };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/** The pair of top-level `key`, with its value as a node, if the map has it. */
function topPair(map: YAMLMap, key: string): Pair<Node | null, Node | null> | undefined {
	return pairOf(map, key) as Pair<Node | null, Node | null> | undefined;
}

/** Whether a value is no list at all: `key:` with nothing, `~`/`null`, or `[]`. */
function isNoList(value: Node | null): boolean {
	return value === null || (isScalar(value) && value.value === null) || (isSeq(value) && value.flow === true && value.items.length === 0);
}

/** The offset of the start of the line holding `offset`. */
function lineStart(text: string, offset: number): number {
	return text.lastIndexOf('\n', offset - 1) + 1;
}

/** The text from `start` to the end of the line holding `end - 1` (its line break included, when there is one). */
function toLineEnd(text: string, start: number, end: number): string {
	if (end > start && text[end - 1] === '\n') {
		return text.slice(start, end);
	}
	const eol = text.indexOf('\n', end);
	return text.slice(start, eol < 0 ? text.length : eol + 1);
}

/** `block` (LF line breaks) with each non-empty line indented at least `from` re-indented to `to`. */
function reindent(block: string, from: number, to: number): string {
	if (from === to) {
		return block;
	}
	const fromPad = ' '.repeat(from);
	const pad = ' '.repeat(to);
	return block.split('\n').map((line) => (line !== '' && line.startsWith(fromPad) ? pad + line.slice(from) : line)).join('\n');
}

/** Where a block is appended: the end of the text, or the start of a final `...` line (only blanks and comments after it). */
function appendPoint(text: string): number {
	let end = text.length;
	while (end > 0) {
		const start = text.lastIndexOf('\n', end - 2) + 1;
		const line = text.slice(start, end).replace(/\r?\n$/, '');
		if (line.trim() === '' || /^\s*#/.test(line)) {
			end = start;
			continue;
		}
		return /^\.\.\.(?:[ \t]|$)/.test(line) ? start : text.length;
	}
	return text.length;
}

/** A defined resource: where (the file's name) and the line of its label. */
interface Defined {
	readonly where: string;
	readonly line: number;
}

/**
 * The 1-based line ranges of the top-level `*_resources` blocks of `text`, as the merge takes them (the key's
 * line to its value's end); `undefined` when the text is not one valid YAML map. Never throws.
 */
export function resourceBlockLines(text: string): { readonly start: number; readonly end: number }[] | undefined {
	const body = text.startsWith(BOM) ? text.slice(1) : text;
	const read = mapOf(body, '');
	if ('problem' in read) {
		return undefined;
	}
	if ('empty' in read) {
		return [];
	}
	const out: { start: number; end: number }[] = [];
	for (const key of RESOURCE_KEYS) {
		const pair = topPair(read.map, key);
		const keyStart = pair?.key?.range?.[0];
		if (pair === undefined || keyStart === undefined) {
			continue;
		}
		const end = pair.value?.range?.[2] ?? pair.key?.range?.[1] ?? keyStart;
		out.push({ start: lineOf(body, keyStart), end: lineOf(body, Math.max(end - 1, keyStart)) });
	}
	return out;
}

/**
 * `config` (named `configName` in messages) with every resource of `files` added, or why it can't be. Pure;
 * never throws. No files: `config` itself, byte for byte.
 */
export function mergeResources(config: string, files: readonly ResourceFileText[], configName = 'the config'): MergedResources {
	if (files.length === 0) {
		return { kind: 'merged', text: config, from: [] };
	}
	const eol = config.includes('\r\n') ? '\r\n' : '\n';
	const withEol = (block: string) => {
		const lf = block.replace(/\r\n/g, '\n');
		return (lf.endsWith('\n') ? lf : `${lf}\n`).replace(/\n/g, eol);
	};
	const problems: MergeProblem[] = [];
	const refuse = (message: string) => problems.push({ message });
	const configRead = mapOf(config, configName);
	if ('problem' in configRead) {
		return { kind: 'refused', problems: [{ message: configRead.problem }] };
	}
	const configValue = 'doc' in configRead ? valueOf(configRead.doc) : { value: {} };
	if ('error' in configValue) {
		return { kind: 'refused', problems: [{ message: `${configName} could not be read: ${configValue.error}` }] };
	}
	/** What the result must read as: the config's value, each joined list grown by each file's items. */
	const expected: Record<string, unknown> = { ...configValue.value };
	// The labels defined so far, by kind.
	const defined = new Map<string, Map<string, Defined>>(RESOURCE_KEYS.map((k) => [k, new Map()]));
	const define = (key: string, label: string, where: string, line: number, inConfig: boolean) => {
		const byLabel = defined.get(key)!;
		const first = byLabel.get(label);
		if (first === undefined) {
			byLabel.set(label, { where, line });
		} else if (!inConfig) {
			refuse(`the ${kindName(key)} resource "${label}" is defined in ${first.where} (line ${first.line}) and in ${where} (line ${line})`);
		}
	};
	if ('map' in configRead) {
		for (const key of RESOURCE_KEYS) {
			const value = topPair(configRead.map, key)?.value ?? null;
			if (isSeq(value)) {
				for (const item of value.items) {
					const label = isMap(item) ? labelOf(item) : undefined;
					if (label !== undefined) {
						define(key, label, configName, lineOf(config, (pairOf(item as YAMLMap, 'label')?.value as Node | undefined)?.range?.[0] ?? 0), true);
					}
				}
			}
		}
	}
	let text = config;
	const from: string[] = [];
	/** Who wrote each kind's list in `text` now (the config, or the file whose block was appended). */
	const owner = new Map<string, string>(RESOURCE_KEYS.map((k) => [k, configName]));
	for (const file of files) {
		const fileText = file.text.startsWith(BOM) ? file.text.slice(1) : file.text;
		const read = mapOf(fileText, file.path);
		if ('problem' in read) {
			refuse(read.problem);
			continue;
		}
		if ('empty' in read) {
			continue;
		}
		const fileValue = valueOf(read.doc);
		if ('error' in fileValue) {
			refuse(`${file.path} could not be read: ${fileValue.error}`);
			continue;
		}
		const contributed: string[] = [];
		for (const key of RESOURCE_KEYS) {
			const pair = topPair(read.map, key);
			if (pair === undefined || isNoList(pair.value)) {
				continue;
			}
			const fileSeq = pair.value;
			if (!isSeq(fileSeq)) {
				refuse(`${key} in ${file.path} is not a list`);
				continue;
			}
			let itemsOk = true;
			for (const item of fileSeq.items) {
				const line = lineOf(fileText, (item as Node | null)?.range?.[0] ?? fileSeq.range?.[0] ?? 0);
				if (!isMap(item)) {
					refuse(`${file.path}: the ${kindName(key)} resource at line ${line} is not a map`);
					itemsOk = false;
					continue;
				}
				const label = labelOf(item);
				if (label === undefined) {
					refuse(`${file.path}: the ${kindName(key)} resource at line ${line} has no label`);
					itemsOk = false;
					continue;
				}
				define(key, label, file.path, lineOf(fileText, (pairOf(item, 'label')?.value as Node | undefined)?.range?.[0] ?? 0), false);
			}
			if (!itemsOk || problems.length > 0) {
				continue; // refused already: only the problems are still looked for
			}
			const current = mapOf(text, configName);
			const target = 'map' in current ? topPair(current.map, key) : undefined;
			const fileStart = fileSeq.range?.[0] ?? 0;
			const fileIndent = fileStart - lineStart(fileText, fileStart);
			const items = toLineEnd(fileText, lineStart(fileText, fileStart), fileSeq.range?.[1] ?? fileText.length).replace(/\r\n/g, '\n');
			if (target === undefined) {
				// Not listed yet: the file's whole block (its comments too), after a blank line, before a final `...`.
				const keyStart = pair.key?.range?.[0] ?? 0;
				const block = withEol(toLineEnd(fileText, lineStart(fileText, keyStart), fileSeq.range?.[2] ?? fileText.length));
				const at = appendPoint(text);
				const before = text.slice(0, at);
				const sep = before === '' ? '' : before.endsWith('\n') ? eol : eol + eol;
				text = `${before}${sep}${block}${text.slice(at)}`;
				owner.set(key, file.path);
			} else if (isNoList(target.value)) {
				// `key:` with no value, `~` or `[]`: the file's items become its value.
				if (fileSeq.flow) {
					refuse(`${key} in ${file.path} is a flow list ([…]), so its ${kindName(key)} resources can't be added to ${key} in ${owner.get(key)}; write it as a block list (- …)`);
					continue;
				}
				const value = target.value;
				let t = text;
				if (value?.range && value.range[1] > value.range[0]) {
					t = `${t.slice(0, value.range[0])}${t.slice(value.range[1])}`;
				}
				const nl = t.indexOf('\n', target.key?.range?.[0] ?? 0);
				const at = nl < 0 ? t.length : nl + 1;
				text = `${t.slice(0, at)}${nl < 0 ? eol : ''}${withEol(reindent(items, fileIndent, 2))}${t.slice(at)}`;
			} else {
				const list = target.value;
				if (!isSeq(list) || list.flow) {
					refuse(`${key} in ${owner.get(key)} is ${isSeq(list) ? 'a flow list ([…])' : 'not a list'}, so the ${kindName(key)} resources of ${file.path} can't be added to it; write it as a block list (- …)`);
					continue;
				}
				if (fileSeq.flow) {
					refuse(`${key} in ${file.path} is a flow list ([…]), so its ${kindName(key)} resources can't be added to the list in ${owner.get(key)}; write it as a block list (- …)`);
					continue;
				}
				const listStart = list.range?.[0] ?? 0;
				const added = withEol(reindent(items, fileIndent, listStart - lineStart(text, listStart)));
				const at = list.range?.[1] ?? text.length;
				const before = at > 0 && text[at - 1] !== '\n' ? eol : '';
				text = `${text.slice(0, at)}${before}${added}${text.slice(at)}`;
			}
			contributed.push(key);
		}
		if (problems.length > 0 || contributed.length === 0) {
			continue;
		}
		from.push(file.path);
		for (const key of contributed) {
			const own = expected[key];
			expected[key] = [...(Array.isArray(own) ? own : []), ...(fileValue.value[key] as unknown[])];
		}
		const changed = changeIn(text, expected, configName);
		if (changed !== undefined) {
			refuse(`${file.path}'s resources could not be added to ${configName} without changing it: ${changed}`);
		}
	}
	return problems.length > 0 ? { kind: 'refused', problems } : { kind: 'merged', text, from };
}

/** How `text` does not read as `expected` (the first key that differs), or `undefined` when it does. */
function changeIn(text: string, expected: Record<string, unknown>, configName: string): string | undefined {
	const read = mapOf(text, 'the result');
	if ('problem' in read) {
		return read.problem;
	}
	const value = 'doc' in read ? valueOf(read.doc) : { value: {} };
	if ('error' in value) {
		return `the result could not be read (${value.error})`;
	}
	for (const key of new Set([...Object.keys(expected), ...Object.keys(value.value)])) {
		if (!isDeepStrictEqual(value.value[key], expected[key])) {
			return RESOURCE_KEYS.includes(key)
				? `${key} would not read as the resources of ${configName} and its resource files`
				: `${key} would read differently`;
		}
	}
	return undefined;
}
