// The graph model's one id map and one ancestor walk (story 55), shared by the core and the
// webview layout. Each caller keeps its own edge rule on top: whether the node itself is
// included, whether an id the model does not have is yielded, and where a cycle stops. Pure; this
// layer imports nothing from `src/core`, `src/adapters` or `vscode` (AD-15).

import type { PipelineNode } from './protocol';

/** The nodes of `model` by id; when two nodes share an id, the later one wins. */
export function nodesById(model: { readonly nodes: readonly PipelineNode[] }): ReadonlyMap<string, PipelineNode> {
	return new Map(model.nodes.map((n) => [n.id, n]));
}

/**
 * The strict ancestors of `id`, nearest first: `parentOf(id)`, its `parentOf`, and so on, until
 * `parentOf` gives `undefined` or an id already yielded (a parent cycle, never in a built model).
 * `id` itself is not yielded first, but is yielded once if it is its own ancestor. An id that
 * `parentOf` gives is yielded whether or not the model has it.
 */
export function* ancestorIds(parentOf: (id: string) => string | undefined, id: string): Generator<string> {
	const seen = new Set<string>();
	for (let p = parentOf(id); p !== undefined && !seen.has(p); p = parentOf(p)) {
		seen.add(p);
		yield p;
	}
}
