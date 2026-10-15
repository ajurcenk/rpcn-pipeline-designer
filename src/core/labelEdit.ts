// Add label (ticket 4.16, AD-22), pure: the label rule the binary applies, the suggestion
// `<kind>_<N>`, the labels already in a document, and the one insertion that writes `label: <name>`
// as an unlabelled processor's first key, at its key column (the existing first key moves to the
// next line at the same column). The insertion is checked by parsing the result: the processor at
// the same path must then have that label and the same kind and Bloblang. No `vscode`: the panel
// (`src/adapters/bloblangPanel/panels.ts`) shows the input box and applies the edit.

import { isMap, isSeq } from 'yaml';
import { bloblangProcessorByPath, bloblangProcessors, type BloblangProcessor } from './bloblangProcessors';
import { labelOf } from './componentId';
import { parseYaml, yamlString, type ParsedYaml } from './yamlPath';

/** The input box's errors, in the order they are checked. */
export const LABEL_RULE_ERROR = 'Use lowercase letters, digits, `_` and `-`, not starting with `_`';
export const LABEL_TAKEN_ERROR = 'Another processor has this label';
export const LABEL_IN_SAMPLES_ERROR = 'Samples already use this label';

/** The binary's label rule: `^[a-z0-9_-]+$`, not starting with `_`. */
export function isLabelName(name: string): boolean {
	return /^[a-z0-9_-]+$/.test(name) && !name.startsWith('_');
}

/**
 * Why `name` can't be the new label: the rule, a label of the document (`documentLabels`), or a
 * label entry of the samples file (`sampleLabels`); `undefined`: it can.
 */
export function labelError(name: string, documentLabels: ReadonlySet<string>, sampleLabels: ReadonlySet<string>): string | undefined {
	if (!isLabelName(name)) {
		return LABEL_RULE_ERROR;
	}
	if (documentLabels.has(name)) {
		return LABEL_TAKEN_ERROR;
	}
	return sampleLabels.has(name) ? LABEL_IN_SAMPLES_ERROR : undefined;
}

/** `<kind>_<N>`, the first N from 1 not among `labels`. */
export function suggestLabel(kind: string, labels: ReadonlySet<string>): string {
	let n = 1;
	while (labels.has(`${kind}_${n}`)) {
		n++;
	}
	return `${kind}_${n}`;
}

/** Every component label of `parsed` (a `label` of any map, at any depth, in every document). Never throws. */
export function documentLabels(parsed: ParsedYaml | undefined): Set<string> {
	const out = new Set<string>();
	const visit = (node: unknown): void => {
		if (isMap(node)) {
			const label = labelOf(node);
			if (label !== undefined) {
				out.add(label);
			}
			node.items.forEach((pair) => visit(pair.value));
		} else if (isSeq(node)) {
			node.items.forEach(visit);
		}
	};
	try {
		parsed?.docs.forEach((doc) => visit(doc.contents));
	} catch {
		// What was found so far.
	}
	return out;
}

/** One insertion into the document text. */
export interface TextInsertion {
	/** The UTF-16 offset to insert at. */
	readonly offset: number;
	readonly text: string;
}

/**
 * The insertion that writes `label: <name>` as `processor`'s first key in `text` (the text it was
 * read from), quoted with `yamlString` when needed. A block map gets the key at its first key's
 * column and a line break after it; a flow map (`{mapping: …}`) gets `label: <name>, ` after its
 * `{`. `undefined` when the processor already has a label, or when the result would not read back
 * as the same processor with that label.
 */
export function labelInsertion(text: string, processor: BloblangProcessor, name: string): TextInsertion | undefined {
	if (processor.label !== undefined) {
		return undefined;
	}
	const start = processor.range[0];
	const key = `label: ${yamlString(name)}`;
	let insertion: TextInsertion;
	if (text[start] === '{') {
		const at = start + 1 + (/^[ \t]*/.exec(text.slice(start + 1))?.[0].length ?? 0);
		insertion = { offset: at, text: `${key}, ` };
	} else {
		const lineStart = Math.max(text.lastIndexOf('\n', start - 1) + 1, 0);
		const column = start - lineStart;
		const eol = text.includes('\r\n') ? '\r\n' : '\n';
		insertion = { offset: start, text: `${key}${eol}${' '.repeat(column)}` };
	}
	const next = `${text.slice(0, insertion.offset)}${insertion.text}${text.slice(insertion.offset)}`;
	const after = bloblangProcessorByPath(bloblangProcessors(parseYaml(next)), processor.path);
	return after && after.label === name && after.kind === processor.kind && after.source === processor.source ? insertion : undefined;
}
