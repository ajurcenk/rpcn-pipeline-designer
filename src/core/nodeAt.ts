// The one offset -> node lookup (AD-16): selection (AD-8) and node status (AD-17) both resolve a
// document offset to a node through `nodeAt`, so they can never disagree. Pure (AD-15).

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
		const byId = new Map<string, PipelineNode>();
		for (const node of nodes) {
			byId.set(node.id, node);
		}
		const depths = new Map<string, number>();
		const depthOf = (node: PipelineNode): number => {
			// Walk up to the first ancestor with a known depth (or the top), then fill in the path.
			const path: PipelineNode[] = [];
			const seen = new Set<string>();
			let current: PipelineNode | undefined = node;
			let base = -1;
			while (current) {
				const known = depths.get(current.id);
				if (known !== undefined) {
					base = known;
					break;
				}
				if (seen.has(current.id)) {
					break; // a parent cycle: never in a built model; treat the rest as the top
				}
				seen.add(current.id);
				path.push(current);
				current = current.parent === undefined ? undefined : byId.get(current.parent);
			}
			for (let i = path.length - 1; i >= 0; i--) {
				base += 1;
				depths.set(path[i].id, base);
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
