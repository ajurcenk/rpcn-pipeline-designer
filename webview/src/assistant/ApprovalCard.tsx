// Story 8.5: an approval as a card in the current turn, under its step row (`StepRows.tsx` places it; one
// card per open approval): what the call does, its full command, URL or file (selectable, with Copy
// command, or Copy path for a write), and Allow once, Allow `<key>` for this session (only for a call with
// a session key; otherwise "This command always asks.") and Deny. Focus moves to a card when it appears,
// unless focus is already somewhere (the composer, an earlier card); Escape on it is Deny. Every text arrives masked from
// the host. Theme colours only.

import { useEffect, useRef, type KeyboardEvent } from 'react';
import {
	ALLOW_ONCE_LABEL, ALLOW_SESSION_PREFIX, ALLOW_SESSION_SUFFIX, allowSessionLabel, ALWAYS_ASKS_TEXT, COPY_COMMAND_LABEL, COPY_PATH_LABEL, DENY_LABEL,
	type AssistantApprovalDecision, type AssistantApprovalView, type AssistantWebviewMessage,
} from '../../../src/shared/assistantProtocol';
import { CopyButton } from './CopyButton';

/** The card's lead line. */
export function approvalLead(summary: string): string {
	return `The assistant asks to ${summary}.`;
}

export function ApprovalCard({ approval, post }: { readonly approval: AssistantApprovalView; readonly post: (m: AssistantWebviewMessage) => void }) {
	const ref = useRef<HTMLElement>(null);
	useEffect(() => {
		const active = ref.current?.ownerDocument.activeElement;
		if (!active || active === ref.current?.ownerDocument.body) {
			ref.current?.focus();
		}
	}, [approval.id]);
	const decide = (decision: AssistantApprovalDecision) => post({ type: 'approvalDecided', id: approval.id, decision });
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			decide('deny');
		}
	};
	const key = approval.sessionKey;
	return (
		<section
			className="rpcn-assistant-approval"
			role="group"
			aria-label={approvalLead(approval.summary)}
			data-approval={approval.id}
			tabIndex={-1}
			ref={ref}
			onKeyDown={onKeyDown}
		>
			<p className="rpcn-assistant-approval-summary">{approvalLead(approval.summary)}</p>
			{approval.detail ? (
				<div className="rpcn-assistant-approval-detail">
					<pre><code>{approval.detail}</code></pre>
					<CopyButton label={approval.write ? COPY_PATH_LABEL : COPY_COMMAND_LABEL} text={approval.detail} />
				</div>
			) : null}
			{key === null ? <p className="rpcn-assistant-approval-always">{ALWAYS_ASKS_TEXT}</p> : null}
			<div className="rpcn-assistant-approval-buttons">
				<button type="button" className="rpcn-assistant-allow-once" onClick={() => decide('once')}>{ALLOW_ONCE_LABEL}</button>
				{key !== null ? (
					<button type="button" className="rpcn-assistant-allow-session rpcn-assistant-secondary" aria-label={allowSessionLabel(key)} onClick={() => decide('session')}>
						{ALLOW_SESSION_PREFIX}<code>{key}</code>{ALLOW_SESSION_SUFFIX}
					</button>
				) : null}
				<button type="button" className="rpcn-assistant-deny rpcn-assistant-secondary" onClick={() => decide('deny')}>{DENY_LABEL}</button>
			</div>
		</section>
	);
}

/** Open approvals, oldest first. */
export function ApprovalCards({ approvals, post }: { readonly approvals: readonly AssistantApprovalView[]; readonly post: (m: AssistantWebviewMessage) => void }) {
	if (approvals.length === 0) {
		return null;
	}
	return (
		<div className="rpcn-assistant-approvals">
			{approvals.map((a) => <ApprovalCard key={a.id} approval={a} post={post} />)}
		</div>
	);
}
