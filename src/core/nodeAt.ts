// The one offset -> node lookup (AD-16): selection (AD-8) and node status (AD-17) both resolve a
// document offset to a node through `nodeAt`, so they can never disagree. Pure (AD-15).

import { ancestorIds, nodesById } from '../shared/graphModel';
import type { PipelineModel, PipelineNode } from '../shared/protocol';

/**
 * The id of the innermost node of `model` whose range contains `offset` (`start <= offset < end`,
 * UTF-16 offsets), or `undefined` when no node contains it. Among the containing nodes the deepest
 * in the `parent` chain wins (a node is deeper than its ancestors); on equal depth, the one that
 * starts last. Linear in the node count. Never throws.
 */
export function nodeAt(model: PipelineModel | null | undefined, offset: number): string | undefined {
	try {
		const nodes = model?.nodes ?? [];
		const byId = nodesById({ nodes });
		const parentOf = (id: string) => byId.get(id)?.parent;
		const depths = new Map<string, number>();
		const depthOf = (node: PipelineNode): number => {
			const memo = depths.get(node.id);
			if (memo !== undefined) {
				return memo;
			}
			// Walk up from the node's own parent to the first ancestor with a known depth (or the top:
			// a parent the model does not have), then fill in the path.
			const path: string[] = [node.id];
			const seen = new Set<string>(path);
			let base = -1;
			const up = node.parent === undefined ? [] : [node.parent, ...ancestorIds(parentOf, node.parent)];
			for (const p of up) {
				if (!byId.has(p)) {
					break;
				}
				const known = depths.get(p);
				if (known !== undefined) {
					base = known;
					break;
				}
				if (seen.has(p)) {
					break; // a parent cycle: never in a built model; treat the rest as the top
				}
				seen.add(p);
				path.push(p);
			}
			for (let i = path.length - 1; i >= 0; i--) {
				base += 1;
				depths.set(path[i], base);
			}
			return depths.get(node.id) ?? 0;
		};
		let best: PipelineNode | undefined;
		let bestDepth = -1;
		for (const node of nodes) {
			const [start, end] = node.range;
			if (!(start <= offset && offset < end)) {
				continue;
			}
			const depth = depthOf(node);
			if (!best || depth > bestDepth || (depth === bestDepth && start > best.range[0])) {
				best = node;
				bestDepth = depth;
			}
		}
		return best?.id;
	} catch {
		return undefined;
	}
}
