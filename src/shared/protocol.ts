// The host<->webview contract (AD-5): `PipelineModel` and every message, as discriminated unions
// on `type`, plus the pure validators both sides use on what they receive. Both the graph panel
// adapter and `webview/` import it; no message or model type is defined anywhere else. This
// module imports nothing (AD-15).

// ---------------------------------------------------------------------------------------------
// The model (AD-4, AD-7, AD-16): one flat list of nodes with `parent` pointers, plus edges.
// No coordinates or sizes.
// ---------------------------------------------------------------------------------------------

/** What a node stands for in the pipeline. */
export type PipelineNodeRole = 'input' | 'processor' | 'output' | 'resource' | 'route';

export const PIPELINE_NODE_ROLES: readonly PipelineNodeRole[] = ['input', 'processor', 'output', 'resource', 'route'];

/** UTF-16 document offsets `[start, end)`, from the key (or `- ` item) to the value's end (AD-16). */
export type TextRange = readonly [number, number];

/**
 * One node of the graph: a component, a resource, or a `route` (a group-internal container with
 * no component, such as a `switch` case, a broker's output list, a `try` or `catch` body).
 */
export interface PipelineNode {
	/**
	 * Assigned by the core only (AD-7): `label:<label>` for a labelled component,
	 * `res:<kind>:<label>` for a resource, `path:<yamlPath>` otherwise, for example
	 * `path:pipeline.processors[2]` or `path:output.switch.cases[0].output`.
	 */
	readonly id: string;
	readonly role: PipelineNodeRole;
	/** The component name, for example `generate` or `switch`. A `route` has none. */
	readonly component?: string;
	/** The component's `label` field, when it has one. */
	readonly label?: string;
	/** Text shown on a `route`, for example `case 0` or an excerpt of the case's `check`. */
	readonly caption?: string;
	readonly range: TextRange;
	/** The id of the enclosing group or route; absent at the top level. */
	readonly parent?: string;
	/** A component whose children name it as `parent`, for example a `switch` processor. */
	readonly group?: boolean;
	/** A later occurrence of a label already used, which therefore gets its path id (AD-7). */
	readonly duplicateLabel?: boolean;
}

export interface PipelineEdge {
	readonly id: string;
	readonly source: string;
	readonly target: string;
	readonly label?: string;
}

/** The model of one config. Groups are nodes (`group: true`), so there is no third list. */
export interface PipelineModel {
	readonly nodes: readonly PipelineNode[];
	readonly edges: readonly PipelineEdge[];
}

/** The empty model (no nodes). */
export const EMPTY_MODEL: PipelineModel = { nodes: [], edges: [] };

// ---------------------------------------------------------------------------------------------
// Host to webview.
// ---------------------------------------------------------------------------------------------

export interface ParseError {
	readonly message: string;
	readonly range: TextRange;
}

export type NodeSeverity = 'error' | 'warning';

/**
 * A node's markers (AD-17). `severity` is the worst of the node's own diagnostics and its
 * descendants' (rolled up), `own` the worst of its own only (absent when it has none, never worse
 * than `severity`), and `messages` its own messages followed by its descendants', verbatim, in
 * document order. `ownMessages`, present exactly when `own` is, holds the node's own messages
 * only, deduplicated, in document order.
 */
export interface NodeStatus {
	readonly severity: NodeSeverity;
	readonly own?: NodeSeverity;
	readonly messages: readonly string[];
	readonly ownMessages?: readonly string[];
}

/** Node status by node id (AD-17). */
export type NodeStatusById = Readonly<Record<string, NodeStatus>>;

export type BinaryStatus = 'ok' | 'missing' | 'invalid' | 'unresolved';
export type SchemaStatus = 'ok' | 'loading' | 'none';

export interface HostStatus {
	readonly binary: BinaryStatus;
	readonly schema: SchemaStatus;
}

/** The complete current state, answering `ready` (AD-1). */
export interface SnapshotMessage {
	readonly type: 'snapshot';
	readonly model: PipelineModel | null;
	readonly parseError?: ParseError;
	readonly nodeStatus: NodeStatusById;
	readonly selection: string | null;
	readonly hostStatus: HostStatus;
}

/** Messages from the host to the webview. */
export type HostMessage =
	| SnapshotMessage
	| { readonly type: 'model'; readonly model: PipelineModel }
	| ({ readonly type: 'parseError' } & ParseError)
	| { readonly type: 'nodeStatus'; readonly byId: NodeStatusById }
	| { readonly type: 'selection'; readonly nodeId: string | null }
	| ({ readonly type: 'hostStatus' } & HostStatus);

// ---------------------------------------------------------------------------------------------
// Webview to host (user intents, AD-3).
// ---------------------------------------------------------------------------------------------

export type ActivationVia = 'click' | 'keyboard';

/** Messages from the webview to the host. */
export type WebviewMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'nodeActivated'; readonly nodeId: string; readonly via: ActivationVia }
	| { readonly type: 'bannerClicked' }
	| { readonly type: 'installGuideRequested' }
	| { readonly type: 'setPathRequested' }
	| { readonly type: 'retryRequested' };

// ---------------------------------------------------------------------------------------------
// Validators: pure, never throw; the typed message, or `undefined` for anything malformed.
// ---------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOffset(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRange(value: unknown): value is TextRange {
	return Array.isArray(value) && value.length === 2 && isOffset(value[0]) && isOffset(value[1]) && value[0] <= value[1];
}

function isOptional(value: unknown, check: (v: unknown) => boolean): boolean {
	return value === undefined || check(value);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isTrue = (v: unknown): boolean => v === true;

function isNode(value: unknown): value is PipelineNode {
	return isObject(value)
		&& isString(value.id)
		&& (PIPELINE_NODE_ROLES as readonly unknown[]).includes(value.role)
		&& isOptional(value.component, isString)
		&& isOptional(value.label, isString)
		&& isOptional(value.caption, isString)
		&& isRange(value.range)
		&& isOptional(value.parent, isString)
		&& isOptional(value.group, isTrue)
		&& isOptional(value.duplicateLabel, isTrue);
}

function isEdge(value: unknown): value is PipelineEdge {
	return isObject(value)
		&& isString(value.id)
		&& isString(value.source)
		&& isString(value.target)
		&& isOptional(value.label, isString);
}

/** A structurally valid `PipelineModel` (it does not check that ids resolve). */
export function isPipelineModel(value: unknown): value is PipelineModel {
	return isObject(value)
		&& Array.isArray(value.nodes) && value.nodes.every(isNode)
		&& Array.isArray(value.edges) && value.edges.every(isEdge);
}

function isParseError(value: Obj): boolean {
	return isString(value.message) && isRange(value.range);
}

const isSeverity = (v: unknown): v is NodeSeverity => v === 'error' || v === 'warning';

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

function isNodeStatus(s: unknown): s is NodeStatus {
	return isObject(s)
		&& isSeverity(s.severity)
		&& isOptional(s.own, isSeverity)
		// `own` is never worse than the roll-up.
		&& !(s.own === 'error' && s.severity === 'warning')
		&& isStrings(s.messages)
		// `ownMessages` only with `own` (old messages without either still validate).
		&& (s.ownMessages === undefined || (s.own !== undefined && isStrings(s.ownMessages)));
}

function isNodeStatusById(value: unknown): value is NodeStatusById {
	return isObject(value) && Object.values(value).every(isNodeStatus);
}

function isHostStatus(value: unknown): value is HostStatus {
	return isObject(value)
		&& (value.binary === 'ok' || value.binary === 'missing' || value.binary === 'invalid' || value.binary === 'unresolved')
		&& (value.schema === 'ok' || value.schema === 'loading' || value.schema === 'none');
}

const isNodeIdOrNull = (v: unknown): boolean => v === null || isString(v);

function isValidHostMessage(m: Obj): boolean {
	switch (m.type) {
		case 'snapshot':
			return (m.model === null || isPipelineModel(m.model))
				&& isOptional(m.parseError, (e) => isObject(e) && isParseError(e))
				&& isNodeStatusById(m.nodeStatus)
				&& isNodeIdOrNull(m.selection)
				&& isHostStatus(m.hostStatus);
		case 'model':
			return isPipelineModel(m.model);
		case 'parseError':
			return isParseError(m);
		case 'nodeStatus':
			return isNodeStatusById(m.byId);
		case 'selection':
			return isNodeIdOrNull(m.nodeId);
		case 'hostStatus':
			return isHostStatus(m);
		default:
			return false;
	}
}

/** Validates a message from the host; it is returned unchanged when well formed. */
export function parseHostMessage(message: unknown): HostMessage | undefined {
	try {
		return isObject(message) && isValidHostMessage(message) ? message as unknown as HostMessage : undefined;
	} catch {
		return undefined;
	}
}

/** Validates a message from the webview; a fresh, typed copy with only the message's own fields. */
export function parseWebviewMessage(message: unknown): WebviewMessage | undefined {
	try {
		if (!isObject(message)) {
			return undefined;
		}
		switch (message.type) {
			case 'ready':
			case 'bannerClicked':
			case 'installGuideRequested':
			case 'setPathRequested':
			case 'retryRequested':
				return { type: message.type };
			case 'nodeActivated':
				return isString(message.nodeId) && (message.via === 'click' || message.via === 'keyboard')
					? { type: 'nodeActivated', nodeId: message.nodeId, via: message.via }
					: undefined;
			default:
				return undefined;
		}
	} catch {
		return undefined;
	}
}
