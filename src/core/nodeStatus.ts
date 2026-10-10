// Node status (AD-17, ticket 3.8): the editor's diagnostics for a file, already turned into
// document offsets by the adapter, mapped to the graph's nodes through `nodeAt` (AD-16) only.
// Error beats warning; a node's severity rolls up to every ancestor (groups and routes). Pure
// (AD-15) and never throws.

import type { NodeSeverity, NodeStatus, NodeStatusById, PipelineModel, PipelineNode } from '../shared/protocol';
import { nodeAt } from './nodeAt';

/** A diagnostic's severity, as named by the editor; only `error` and `warning` mark nodes. */
export type StatusSeverity = NodeSeverity | 'information' | 'hint';

/** One diagnostic, located by the UTF-16 document offset it maps at. */
export interface StatusDiagnostic {
	readonly offset: number;
	readonly severity: StatusSeverity;
	readonly message: string;
}

function worse(a: NodeSeverity | undefined, b: NodeSeverity | undefined): NodeSeverity | undefined {
	return a === 'error' || b === 'error' ? 'error' : a ?? b;
}

/**
 * The status of every node with a diagnostic on it or under it. A diagnostic maps to the
 * innermost node at its offset; one that maps to no node, or whose severity is `information` or
 * `hint`, is dropped. For each node, `own` is the worst severity of its own diagnostics (absent
 * when it has none), `severity` the worst of its own and its descendants', `messages` its own
 * messages, then its descendants', each in document order, without duplicates, and `ownMessages`
 * (exactly when `own` is set) its own messages only, likewise. Keys follow the
 * model's node order, so equal inputs give equal (and equally serialised) results.
 */
export function nodeStatusOf(model: PipelineModel | null | undefined, diagnostics: readonly StatusDiagnostic[]): NodeStatusById {
	try {
		const nodes = model?.nodes ?? [];
		const byId = new Map<string, PipelineNode>(nodes.map((n) => [n.id, n]));
		const own = new Map<string, { severity?: NodeSeverity; messages: string[] }>();
		const below = new Map<string, { severity?: NodeSeverity; messages: string[] }>();
		const entry = (map: typeof own, id: string) => {
			let e = map.get(id);
			if (!e) {
				e = { messages: [] };
				map.set(id, e);
			}
			return e;
		};
		const sorted = diagnostics
			.map((d, i) => ({ d, i }))
			.filter(({ d }) => d !== null && typeof d === 'object' && (d.severity === 'error' || d.severity === 'warning')
				&& typeof d.offset === 'number' && Number.isFinite(d.offset) && typeof d.message === 'string')
			.sort((a, b) => a.d.offset - b.d.offset || a.i - b.i);
		for (const { d } of sorted) {
			const id = nodeAt(model, d.offset);
			if (id === undefined) {
				continue;
			}
			const severity = d.severity as NodeSeverity;
			const mine = entry(own, id);
			mine.severity = worse(mine.severity, severity);
			mine.messages.push(d.message);
			const seen = new Set<string>([id]);
			for (let p = byId.get(id)?.parent; p !== undefined && !seen.has(p) && byId.has(p); p = byId.get(p)?.parent) {
				seen.add(p);
				const up = entry(below, p);
				up.severity = worse(up.severity, severity);
				up.messages.push(d.message);
			}
		}
		const result: Record<string, NodeStatus> = {};
		for (const node of nodes) {
			const mine = own.get(node.id);
			const under = below.get(node.id);
			const severity = worse(mine?.severity, under?.severity);
			if (severity === undefined || result[node.id] !== undefined) {
				continue;
			}
			const messages = [...new Set([...(mine?.messages ?? []), ...(under?.messages ?? [])])];
			result[node.id] = mine?.severity === undefined
				? { severity, messages }
				: { severity, own: mine.severity, messages, ownMessages: [...new Set(mine.messages)] };
		}
		return result;
	} catch {
		return {};
	}
}
