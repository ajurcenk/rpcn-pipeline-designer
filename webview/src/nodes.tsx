// The node renderers of the graph view (ticket 3.4, DESIGN components): a component node, a group
// box (header with a chevron codicon, the component and its label; collapsed: one node-sized box
// with a count) and a route sub-box (dashed, with its caption). The chevron toggles collapse; a
// click on a group's header label activates the group (its whole block, ticket 3.7); any other
// click on a node is left to `onNodeClick`, which reports `nodeActivated`. The node under the cursor
// in the driving editor (`data.selected`, 3.7) gets DESIGN's pipeline-node-selected style. A node
// with a marker (`data.marker`, 3.8) gets DESIGN's pipeline-node-error / -warning treatment: a 2px
// border and its own codicon in the top-right corner, never colour alone, and its hover text lists
// the messages verbatim. While a local run is live (7.3), a component box shows its figures line
// (`data.figures`) under its name, and its hover text carries it too. Ticket 7.7 (board 2): the slowest
// box shows the band "SLOWEST · N% of the time" under its figures, with its border and latency in a
// warning-like theme colour; a box whose component had errors shows an "ERRORS" mark and its errors in
// an error-like one. Both are text as well as colour, and never AD-17's lint marker classes.

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { createContext, useContext, type MouseEvent } from 'react';
import type { PipelineNode } from '../../src/shared/protocol';
import { markerClass, markerIcon, nodeKind, nodeName, nodeTitle, type Marker, type ViewNode } from './layout';

/** Toggles the collapse state of a group, by id. */
export const ToggleContext = createContext<(id: string) => void>(() => undefined);

/** Reports a node's activation (a click), by id. */
export const ActivateContext = createContext<(id: string) => void>(() => undefined);

/** The class list of a node's box: `base`, plus its selected modifier when `selected`, plus its marker's. */
function boxClass(base: string, selected: boolean | undefined, extra = '', marker?: Marker): string {
	const status = markerClass(marker);
	return `${base}${extra}${selected === true ? ` ${base}-selected` : ''}${status === undefined ? '' : ` ${status}`}`;
}

/** The marker's icon (DESIGN: codicon-error / codicon-warning, top-right). */
function MarkerIcon({ marker }: { readonly marker: Marker | undefined }) {
	const icon = markerIcon(marker);
	if (!marker || icon === undefined) {
		return null;
	}
	return (
		<span
			className={`codicon ${icon} rpcn-status-icon`}
			role="img"
			aria-label={marker.severity === 'error' ? 'Error' : 'Warning'}
		/>
	);
}

function Handles({ node }: { readonly node: PipelineNode }) {
	return (
		<>
			{node.role !== 'input' && node.role !== 'resource' && <Handle type="target" position={Position.Left} isConnectable={false} />}
			{node.role !== 'output' && node.role !== 'resource' && <Handle type="source" position={Position.Right} isConnectable={false} />}
		</>
	);
}

/** Ticket 7.7: the errors mark's text on a box. */
export const ERRORS_MARK = 'ERRORS';

/** The figures line, its parts (rate, latency, errors) in their own spans so the marks can colour them. */
function FiguresLine({ figures }: { readonly figures: string }) {
	const parts = figures.split(' · ');
	const names = parts.length === 3 ? ['rate', 'latency', 'errors'] : parts.map(() => 'rate');
	return (
		<div className="rpcn-node-figures">
			{parts.map((part, i) => (
				<span key={i}>{i > 0 && ' · '}<span className={`rpcn-node-figures-${names[i]}`}>{part}</span></span>
			))}
		</div>
	);
}

function ComponentView({ data }: NodeProps<ViewNode>) {
	const { node, selected, marker, figures, slowest, metricErrors } = data;
	const base = `${nodeKind(node)}: ${nodeName(node)}`;
	const marks = [...(slowest !== undefined ? [slowest] : []), ...(metricErrors ? [ERRORS_MARK] : [])];
	const hover = figures === undefined ? base : `${base}\n${figures}${marks.length > 0 ? `\n${marks.join(' · ')}` : ''}`;
	const metricsClass = `${slowest !== undefined ? ' rpcn-node-slowest' : ''}${metricErrors ? ' rpcn-node-metric-errors' : ''}`;
	return (
		<div className={boxClass('rpcn-node', selected, ` rpcn-node-${node.role}${metricsClass}`, marker)} title={nodeTitle(hover, marker)}>
			<Handles node={node} />
			<MarkerIcon marker={marker} />
			<div className="rpcn-node-kind">
				<span className="rpcn-node-role">{node.role}</span>
				{node.label !== undefined && <> · <span className="rpcn-node-label">{node.label}</span></>}
			</div>
			<div className="rpcn-node-name">{nodeName(node)}</div>
			{figures !== undefined && <FiguresLine figures={figures} />}
			{marks.length > 0 && (
				<div className="rpcn-node-band">
					{slowest !== undefined && <span className="rpcn-node-band-slowest">{slowest}</span>}
					{metricErrors && <span className="rpcn-node-band-errors">{ERRORS_MARK}</span>}
				</div>
			)}
		</div>
	);
}

function GroupHeader({ node, collapsed }: { readonly node: PipelineNode; readonly collapsed: boolean }) {
	const toggle = useContext(ToggleContext);
	const activate = useContext(ActivateContext);
	const onToggle = (event: MouseEvent) => {
		event.stopPropagation();
		toggle(node.id);
	};
	// HEADER: the label stands for the whole group, whatever else the click would hit.
	const onTitle = (event: MouseEvent) => {
		event.stopPropagation();
		activate(node.id);
	};
	return (
		<div className="rpcn-group-header">
			<button
				type="button"
				className="rpcn-group-toggle nopan"
				aria-label={collapsed ? `Expand ${node.component ?? 'group'}` : `Collapse ${node.component ?? 'group'}`}
				aria-expanded={!collapsed}
				tabIndex={-1}
				onClick={onToggle}
			>
				<span className={`codicon codicon-${collapsed ? 'chevron-right' : 'chevron-down'}`} aria-hidden="true" />
			</button>
			<span className="rpcn-group-title" onClick={onTitle}>
				<span className="rpcn-group-component">{node.component}</span>
				{node.label !== undefined && <span className="rpcn-group-label">{node.label}</span>}
			</span>
		</div>
	);
}

function GroupView({ data }: NodeProps<ViewNode>) {
	const { node, collapsed = false, summary, selected, marker } = data;
	return (
		<div
			className={boxClass('rpcn-group', selected, collapsed ? ' rpcn-group-collapsed' : '', marker)}
			title={nodeTitle(`${nodeKind(node)}: ${nodeName(node)}`, marker)}
		>
			<Handles node={node} />
			<MarkerIcon marker={marker} />
			<GroupHeader node={node} collapsed={collapsed} />
			{collapsed && <div className="rpcn-group-summary">{summary}</div>}
		</div>
	);
}

function RouteView({ data }: NodeProps<ViewNode>) {
	const { node, selected, marker } = data;
	return (
		<div className={boxClass('rpcn-route', selected, '', marker)} title={nodeTitle(node.caption, marker)}>
			<Handles node={node} />
			<MarkerIcon marker={marker} />
			{node.caption !== undefined && <div className="rpcn-route-caption">{node.caption}</div>}
		</div>
	);
}

export const nodeTypes = { component: ComponentView, groupBox: GroupView, route: RouteView };
