// The node renderers of the graph view (ticket 3.4, DESIGN components): a component node, a group
// box (header with a chevron codicon, the component and its label; collapsed: one node-sized box
// with a count) and a route sub-box (dashed, with its caption). The chevron toggles collapse; any
// other click on a node is left to `onNodeClick`, which reports `nodeActivated`.

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { createContext, useContext, type MouseEvent } from 'react';
import type { PipelineNode } from '../../src/shared/protocol';
import { nodeKind, nodeName, type ViewNode } from './layout';

/** Toggles the collapse state of a group, by id. */
export const ToggleContext = createContext<(id: string) => void>(() => undefined);

function Handles({ node }: { readonly node: PipelineNode }) {
	return (
		<>
			{node.role !== 'input' && node.role !== 'resource' && <Handle type="target" position={Position.Left} isConnectable={false} />}
			{node.role !== 'output' && node.role !== 'resource' && <Handle type="source" position={Position.Right} isConnectable={false} />}
		</>
	);
}

function ComponentView({ data }: NodeProps<ViewNode>) {
	const { node } = data;
	return (
		<div className={`rpcn-node rpcn-node-${node.role}`} title={`${nodeKind(node)}: ${nodeName(node)}`}>
			<Handles node={node} />
			<div className="rpcn-node-kind">
				<span className="rpcn-node-role">{node.role}</span>
				{node.label !== undefined && <> · <span className="rpcn-node-label">{node.label}</span></>}
			</div>
			<div className="rpcn-node-name">{nodeName(node)}</div>
		</div>
	);
}

function GroupHeader({ node, collapsed }: { readonly node: PipelineNode; readonly collapsed: boolean }) {
	const toggle = useContext(ToggleContext);
	const onToggle = (event: MouseEvent) => {
		event.stopPropagation();
		toggle(node.id);
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
			<span className="rpcn-group-component">{node.component}</span>
			{node.label !== undefined && <span className="rpcn-group-label">{node.label}</span>}
		</div>
	);
}

function GroupView({ data }: NodeProps<ViewNode>) {
	const { node, collapsed = false, summary } = data;
	return (
		<div className={`rpcn-group${collapsed ? ' rpcn-group-collapsed' : ''}`} title={`${nodeKind(node)}: ${nodeName(node)}`}>
			<Handles node={node} />
			<GroupHeader node={node} collapsed={collapsed} />
			{collapsed && <div className="rpcn-group-summary">{summary}</div>}
		</div>
	);
}

function RouteView({ data }: NodeProps<ViewNode>) {
	const { node } = data;
	return (
		<div className="rpcn-route" title={node.caption}>
			<Handles node={node} />
			{node.caption !== undefined && <div className="rpcn-route-caption">{node.caption}</div>}
		</div>
	);
}

export const nodeTypes = { component: ComponentView, groupBox: GroupView, route: RouteView };
