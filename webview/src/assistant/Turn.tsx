// One turn of the chat (story 8.12, option A): "You" with its avatar and the message in a box (its slash
// command highlighted), the rpcn header (its sparkle badge) with `· <skill>`, the step rows (folded on an earlier turn) with story 8.5's
// approval cards under their rows (one per open approval), what the run needs now (the question cards; the parent's), the reply as Markdown, the stopped or error line, the
// file rows, Keep and Undo (once the turn has ended, on the latest turn that wrote files), the next-step
// buttons and the chips.

import { useEffect, useState, type ReactNode } from 'react';
import {
	failedAfterText, formatClock, KEEP_LABEL, stoppedText, UNDO_LABEL, UNDONE_TEXT, type AssistantCommand, type AssistantTurnView, type AssistantWebviewMessage,
} from '../../../src/shared/assistantProtocol';
import { ActivityLine } from './Activity';
import { CopyButton } from './CopyButton';
import { FileRows } from './FileRows';
import { Markdown } from './Markdown';
import { StepRows } from './StepRows';

export const FAILED_TURN_TEXT = 'This run failed.';
/** Manual check (8.3): the header's model, after the skill. */
export const TURN_MODEL_TITLE = 'Model used for this request';
export const COPY_REPLY_LABEL = 'Copy reply';
/**
 * Manual check 1: Keep and Undo take no click for this long after they appear: they show as the run ends,
 * when the reply and the file rows push the transcript about, so a click meant for something else could
 * land on them.
 */
export const SETTLE_ARM_MS = 800;

/** Whether buttons shown (`shown`) take a click yet: `SETTLE_ARM_MS` after they appear. */
function useArmed(shown: boolean): boolean {
	const [armed, setArmed] = useState(false);
	useEffect(() => {
		setArmed(false);
		if (!shown) {
			return undefined;
		}
		const timer = setTimeout(() => setArmed(true), SETTLE_ARM_MS);
		return () => clearTimeout(timer);
	}, [shown]);
	return armed;
}

/**
 * Manual check 4: a running turn's clock: the last posted elapsed time, ticking on each second from when it
 * arrived (no re-post per second).
 */
function LiveClock({ elapsedMs }: { readonly elapsedMs: number }) {
	const [base, setBase] = useState(() => ({ elapsedMs, at: Date.now() }));
	const [, setTick] = useState(0);
	if (base.elapsedMs !== elapsedMs) {
		setBase({ elapsedMs, at: Date.now() });
	}
	useEffect(() => {
		const timer = setInterval(() => setTick((n) => n + 1), 1000);
		return () => clearInterval(timer);
	}, []);
	const shown = base.elapsedMs + (Date.now() - base.at);
	return <span className="rpcn-assistant-clock" role="timer" aria-label={`Running for ${formatClock(shown)}`}>· {formatClock(shown)}</span>;
}

/** Option A's rpcn badge: a sparkle in a rounded square. */
function RpcnBadge() {
	return (
		<span className="rpcn-assistant-badge" aria-hidden="true">
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15.5l-1.8-4.7L5.5 9l4.7-1.3z" /></svg>
		</span>
	);
}

/** The message as typed, with its leading slash command apart (`null`: none). */
export function splitCommand(text: string): { readonly command: string | null; readonly rest: string } {
	const m = /^(\s*)(\/(?:design|build|test))(?=\s|$)/.exec(text);
	return m ? { command: m[2], rest: text.slice(m[0].length) } : { command: null, rest: text };
}

export function Turn({ turn, latest, live, error, after, post, insert }: {
	readonly turn: AssistantTurnView;
	/** The last turn of the conversation (the run's error line). */
	readonly latest: boolean;
	/** What the current run needs now (question cards), shown in this turn. */
	readonly live?: ReactNode;
	/** The run's error line, on the latest turn. */
	readonly error: string | null;
	/** Story 8.3: shown after the error line (the unreachable state's panel). */
	readonly after?: ReactNode;
	readonly post: (m: AssistantWebviewMessage) => void;
	readonly insert: (command: AssistantCommand) => void;
}) {
	const { command, rest } = splitCommand(turn.text);
	const ended = turn.outcome !== 'running';
	const armed = useArmed(ended && turn.review === 'pending');
	return (
		<article className="rpcn-assistant-turn" aria-label={`Turn ${turn.id}`} data-turn={turn.id}>
			<div className="rpcn-assistant-you">
				<p className="rpcn-assistant-who">
					<span className="rpcn-assistant-avatar" aria-hidden="true">You</span>
					<span className="rpcn-assistant-who-name">You</span>
				</p>
				<p className="rpcn-assistant-user">
					{command ? <span className="rpcn-assistant-command">{command}</span> : null}
					{rest}
				</p>
			</div>
			<div className="rpcn-assistant-rpcn">
				<p className="rpcn-assistant-rpcn-header">
					<RpcnBadge />
					<span className="rpcn-assistant-rpcn-name">rpcn</span>
					<span className="rpcn-assistant-rpcn-skill">· {turn.skill}</span>
					{turn.model ? <span className="rpcn-assistant-rpcn-model" title={TURN_MODEL_TITLE}>· {turn.model}</span> : null}
					{turn.outcome === 'running' ? <LiveClock elapsedMs={turn.elapsedMs} /> : null}
				</p>
				<StepRows steps={turn.steps} outcome={turn.outcome} elapsedMs={turn.elapsedMs} waitingMs={turn.waitingMs} approvals={turn.approvals} post={post} />
				<ActivityLine turn={turn} cardsOpen={live !== undefined && live !== null} />
				{live}
				{turn.reply ? (
					<div className="rpcn-assistant-reply-wrap">
						<Markdown text={turn.reply} openLink={(href) => post({ type: 'openLink', href })} />
						<div className="rpcn-assistant-reply-tools">
							<CopyButton label={COPY_REPLY_LABEL} text={turn.reply} />
						</div>
					</div>
				) : null}
				{turn.outcome === 'stopped' ? <p className="rpcn-assistant-stopped" role="status">{stoppedText(turn.elapsedMs)}</p> : null}
				{turn.outcome === 'error' ? (
					latest && error ? <p className="rpcn-assistant-error" role="alert">{error}</p> : <p className="rpcn-assistant-stopped">{FAILED_TURN_TEXT}</p>
				) : null}
				{turn.outcome === 'error' ? <p className="rpcn-assistant-time">{failedAfterText(turn.elapsedMs)}</p> : null}
				{after}
				<FileRows files={turn.files} note={turn.note} clickable={turn.review === 'pending'} open={(path) => post({ type: 'openFileDiff', turn: turn.id, path })} />
				{turn.notice ? <p className="rpcn-assistant-error" role="alert">{turn.notice}</p> : null}
				{ended && (turn.review === 'pending' || turn.review === 'undone' || turn.actions.length > 0) ? (
					<div className="rpcn-assistant-actions">
						{turn.review === 'pending' ? (
							<>
								<button type="button" className="rpcn-assistant-keep" aria-disabled={!armed || undefined} onClick={() => armed && post({ type: 'keepTurn', turn: turn.id })}>{KEEP_LABEL}</button>
								<button type="button" className="rpcn-assistant-undo rpcn-assistant-secondary" aria-disabled={!armed || undefined} onClick={() => armed && post({ type: 'undoTurn', turn: turn.id })}>{UNDO_LABEL}</button>
							</>
						) : null}
						{turn.review === 'undone' ? <span className="rpcn-assistant-undone" role="status">{UNDONE_TEXT}</span> : null}
						{turn.actions.map((a) => (
							<button
								type="button"
								key={a.id}
								className="rpcn-assistant-secondary"
								disabled={!a.enabled}
								title={a.hint ?? undefined}
								onClick={() => post({ type: 'turnAction', turn: turn.id, action: a.id })}
							>
								{a.label}
							</button>
						))}
					</div>
				) : null}
				{ended && turn.chips.length > 0 ? (
					<div className="rpcn-assistant-chips" aria-label="Next steps">
						{turn.chips.map((c) => (
							<button
								type="button"
								key={c.label}
								className="rpcn-assistant-chip"
								disabled={!c.enabled}
								title={c.hint ?? undefined}
								aria-description={c.hint ?? undefined}
								onClick={() => insert(c.command)}
							>
								{c.label}
							</button>
						))}
					</div>
				) : null}
			</div>
		</article>
	);
}
