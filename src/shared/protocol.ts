// The host<->webview contract (AD-5): `PipelineModel` and every message, as discriminated unions
// on `type`. Both the graph panel adapter and `webview/` import it; no message type is defined
// anywhere else. This module imports nothing (AD-15).

/** What a node stands for in the pipeline. */
export type PipelineNodeKind = 'input' | 'processor' | 'output';

/** One component in the graph. No coordinates or sizes (AD-4). */
export interface PipelineNode {
	/** Stable, kind-prefixed id assigned by the core (AD-7): `input:<name>`, `processor:<index>:<name>`, `output:<name>`. */
	readonly id: string;
	readonly kind: PipelineNodeKind;
	/** The component name, for example `generate` or `mapping`. */
	readonly name: string;
	/** UTF-16 document offsets `[start, end)`, from the key (or `- ` item) to the value's end (AD-16). */
	readonly range: readonly [number, number];
}

export interface PipelineEdge {
	readonly id: string;
	readonly source: string;
	readonly target: string;
}

/** The flat model of one config: input, `pipeline.processors` in order, output. */
export interface PipelineModel {
	readonly nodes: readonly PipelineNode[];
	readonly edges: readonly PipelineEdge[];
}

/** Messages from the host to the webview. */
export type HostMessage =
	| { readonly type: 'snapshot'; readonly model: PipelineModel };

/** Messages from the webview to the host (user intents, AD-3). */
export type WebviewMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'nodeActivated'; readonly nodeId: string; readonly via: 'click' };

/** The empty model (no nodes), for example for an unparseable file. */
export const EMPTY_MODEL: PipelineModel = { nodes: [], edges: [] };
