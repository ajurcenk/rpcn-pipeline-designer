// Manual check (8.3): the running turn's live activity line, under its step card: a spinner, what is
// happening now, and its own timer, which restarts at each change (the header's clock keeps the whole turn's).
//   - a tool step running: its label + "…" (a shell step: its label, never the command);
//   - after the run's first tool step, between steps: "Thinking…";
//   - before any tool step (nothing yet, or only info lines such as "Started (model)"): "Waiting for the model…";
//   - while question or approval cards are open: no line (the cards are the activity); an ended turn: none.
// The spinner is VS Code's `codicon-loading` with `codicon-modifier-spin` (static under reduced motion,
// in `assistant.css`); the running step row's mark uses it too.

import { useEffect, useRef, useState } from 'react';
import { formatClock, type AssistantTurnView } from '../../../src/shared/assistantProtocol';

export const THINKING_TEXT = 'Thinking…';
export const WAITING_MODEL_TEXT = 'Waiting for the model…';

/** What the turn is doing now (`key` changes when the activity does), or `null`: no line. */
export function activityOf(turn: AssistantTurnView, cardsOpen: boolean): { readonly key: string; readonly text: string } | null {
	if (turn.outcome !== 'running' || cardsOpen || turn.approvals.length > 0) {
		return null;
	}
	const tools = turn.steps.filter((s) => s.mark !== 'info');
	const running = [...tools].reverse().find((s) => s.mark === 'running');
	if (running) {
		return { key: `step:${running.id}`, text: `${running.label.replace(/[.…]+$/, '')}…` };
	}
	if (tools.length > 0 || turn.reply !== '') {
		return { key: `thinking:${tools.at(-1)?.id ?? 'reply'}`, text: THINKING_TEXT };
	}
	return { key: 'waiting', text: WAITING_MODEL_TEXT };
}

/** The spinning `codicon-loading` (aria-hidden; the caller names what it stands for). */
export function Spinner({ className = '' }: { readonly className?: string }) {
	return <span className={`codicon codicon-loading codicon-modifier-spin rpcn-assistant-spinner${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}

/** The line itself: its timer counts from when its activity began (as this view saw it), each second. */
export function ActivityLine({ turn, cardsOpen }: { readonly turn: AssistantTurnView; readonly cardsOpen: boolean }) {
	const activity = activityOf(turn, cardsOpen);
	const since = useRef<{ key: string; at: number } | null>(null);
	const [, setTick] = useState(0);
	if (activity && since.current?.key !== activity.key) {
		since.current = { key: activity.key, at: Date.now() };
	}
	useEffect(() => {
		if (!activity) {
			return undefined;
		}
		const timer = setInterval(() => setTick((n) => n + 1), 1000);
		return () => clearInterval(timer);
	}, [activity?.key]);
	if (!activity) {
		since.current = null;
		return null;
	}
	const shown = Date.now() - (since.current?.at ?? Date.now());
	return (
		<p className="rpcn-assistant-activity" role="status" aria-live="polite">
			<Spinner />
			<span className="rpcn-assistant-activity-text">{activity.text}</span>
			<span className="rpcn-assistant-activity-time" role="timer">{formatClock(shown)}</span>
		</p>
	);
}
