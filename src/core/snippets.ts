// Pipeline snippets (ticket 2.10, CAP-5): hand-written starters for a whole config, its sections,
// and common components. Each body is a VS Code snippet whose placeholder defaults make a
// config that lints clean as inserted (the corpus harness lints every one with both pinned
// binaries). Bodies are relative to the line the cursor is on: VS Code adds that line's
// indentation to every following line, so a component in a block nests its fields by 2, and a
// component after a list item's `- ` by 4.

import type { Slot } from './gapCompletion';

/** Where a snippet goes: the top of the file, a component slot, or a processor list item. */
export type SnippetSlot = 'root' | 'input' | 'output' | 'processor';

export interface PipelineSnippet {
	/** What the user types to find it. */
	readonly prefix: string;
	readonly label: string;
	readonly description: string;
	readonly slot: SnippetSlot;
	/** VS Code snippet syntax. */
	readonly body: string;
	/** For root snippets: top-level keys it adds (not offered when the file already has one). */
	readonly topKeys?: readonly string[];
}

export const PIPELINE_SNIPPETS: readonly PipelineSnippet[] = [
	{
		prefix: 'rpcn-pipeline', label: 'Redpanda Connect pipeline', slot: 'root', topKeys: ['input', 'pipeline', 'output'],
		description: 'A whole config: a generate input, a mapping processor and a stdout output.',
		body: [
			'input:',
			'  generate:',
			'    interval: ${1:1s}',
			'    mapping: |',
			'      root = {"id": uuid_v4(), "at": now()}',
			'',
			'pipeline:',
			'  processors:',
			'    - mapping: |',
			'        root = this$0',
			'',
			'output:',
			'  stdout: {}',
		].join('\n'),
	},
	{
		prefix: 'rpcn-input', label: 'input section', slot: 'root', topKeys: ['input'],
		description: 'An input section with a generate input.',
		body: 'input:\n  generate:\n    interval: ${1:1s}\n    mapping: |\n      root = ${2:{"id": uuid_v4()\\}}$0',
	},
	{
		prefix: 'rpcn-processors', label: 'pipeline section', slot: 'root', topKeys: ['pipeline'],
		description: 'A pipeline section with one mapping processor.',
		body: 'pipeline:\n  processors:\n    - mapping: |\n        root = this$0',
	},
	{
		prefix: 'rpcn-output', label: 'output section', slot: 'root', topKeys: ['output'],
		description: 'An output section with a stdout output.',
		body: 'output:\n  stdout: {}$0',
	},
	{
		prefix: 'generate', label: 'generate input', slot: 'input',
		description: 'Creates messages from a Bloblang mapping on an interval.',
		body: 'generate:\n  interval: ${1:1s}\n  count: ${2:0}\n  mapping: |\n    root = ${3:{"id": uuid_v4(), "at": now()\\}}$0',
	},
	{
		prefix: 'redpanda', label: 'redpanda input', slot: 'input',
		description: 'Consumes topics from Redpanda or Kafka with a consumer group.',
		body: 'redpanda:\n  seed_brokers: [ ${1:localhost:9092} ]\n  topics: [ ${2:events} ]\n  consumer_group: ${3:rpcn}$0',
	},
	{
		prefix: 'redpanda', label: 'redpanda output', slot: 'output',
		description: 'Writes messages to a Redpanda or Kafka topic.',
		body: 'redpanda:\n  seed_brokers: [ ${1:localhost:9092} ]\n  topic: ${2:events}$0',
	},
	{
		prefix: 'stdout', label: 'stdout output', slot: 'output',
		description: 'Prints each message on its own line.',
		body: 'stdout:\n  codec: ${1:lines}$0',
	},
	{
		prefix: 'mapping', label: 'mapping processor', slot: 'processor',
		description: 'Transforms each message with Bloblang.',
		body: 'mapping: |\n    root = this$0',
	},
	{
		prefix: 'switch', label: 'switch processor', slot: 'processor',
		description: 'Runs processors for the first case whose check is true.',
		body: [
			'switch:',
			'    - check: ${1:this.type == "a"}',
			'      processors:',
			'        - mapping: |',
			'            root = this$0',
			'    - processors:',
			'        - log:',
			'            message: ${2:other}',
		].join('\n'),
	},
	{
		prefix: 'branch', label: 'branch processor', slot: 'processor',
		description: 'Runs processors on a copy of the message and maps the result back.',
		body: [
			'branch:',
			'    request_map: ${1:root = this}',
			'    processors:',
			'      - mapping: |',
			'          root = this$0',
			'    result_map: ${2:root.result = this}',
		].join('\n'),
	},
	{
		prefix: 'log', label: 'log processor', slot: 'processor',
		description: 'Writes a log line for each message.',
		body: 'log:\n    level: ${1:INFO}\n    message: ${2:\\${! content() \\}}$0',
	},
];

/** The snippet slot for a cursor slot, if snippets apply there. */
export function snippetSlotOf(slot: Slot | undefined): SnippetSlot | undefined {
	if (!slot) {
		return undefined;
	}
	if (slot.kind === 'root') {
		return 'root';
	}
	if (slot.kind === 'block' && slot.path.length === 1 && (slot.path[0] === 'input' || slot.path[0] === 'output')) {
		return slot.path[0];
	}
	// A list item of any `processors:` list: the pipeline's, a switch case's, a branch's, batching's, …
	if (slot.kind === 'item' && slot.path.length >= 2 && slot.path[slot.path.length - 2] === 'processors') {
		return 'processor';
	}
	return undefined;
}

/** The snippets for `slot`; root snippets only for sections the file does not have yet. */
export function snippetsFor(slot: SnippetSlot, topLevelKeys: readonly string[]): PipelineSnippet[] {
	return PIPELINE_SNIPPETS.filter((s) => s.slot === slot && !(s.topKeys ?? []).some((k) => topLevelKeys.includes(k)));
}

/** A snippet body as plain text with every placeholder's default (and `$0` removed). */
export function renderSnippet(body: string): string {
	let out = body;
	for (let i = 0; i < 5 && /\$\{\d+:/.test(out); i++) {
		out = out.replace(/\$\{\d+:((?:[^}\\]|\\.)*)\}/g, '$1'); // in a default only `}` (and `$`, `\`) are escaped
	}
	return out.replace(/\$\d+/g, '').replace(/\\([$}\\])/g, '$1');
}
