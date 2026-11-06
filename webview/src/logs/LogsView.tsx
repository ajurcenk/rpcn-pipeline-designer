// The Pipeline Logs tab's view (tickets 6.2, 6.3, AD-24): the header names the pipeline ("<pipeline> ·
// <cluster>"), says how reading goes, and holds the Live toggle and the time-range menu (board 5: Live,
// Last 15 minutes then live, Last hour, Last 24 hours, Last 7 days, Since the last deploy, Custom
// range… with From and To in local time, and the topic's retention). The table shows each kept record,
// oldest first and newest at the bottom: its time in local time, its level, its message followed by its
// further fields (`key=value`), and its instance; a value that is not a JSON object is its text. A note
// row marks 30 minutes or more without a record between two shown ones, and a read range with no records
// says so. **Load older records** sits at the top of the list ("No older records" once the log's first
// record is shown). The footer says how many records are kept, and how many older ones were left out
// or newer ones dropped for the cap. While the table is scrolled to the bottom it stays there as records
// arrive. The host masks every text before it is posted.

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
	customRangeError, gapsIn, localMinute, MAX_LOG_ROWS, noRecordsText, parseLocalDateTime, parseLogsHostMessage, RANGE_KINDS, RANGE_LABELS,
	type LogRow, type LogsViewState, type LogsWebviewMessage, type RangeKind,
} from '../../../src/shared/logsProtocol';

export const NO_PIPELINE_TITLE = 'No pipeline';
export const NO_RECORDS_TEXT = 'No records of this pipeline yet.';
export const NO_OLDER_TEXT = 'No older records';
export const LOADING_OLDER_TEXT = 'Loading older records…';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `2026-11-05 16:49:15.510`, in the viewer's local time. */
export function localTime(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** "3 records", "1 record". */
const records = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'record' : 'records'}`;

/** The footer: how many are kept; how many older ones were left out, newer ones dropped, for the cap. */
export function footerText(kept: number, dropped: number, cap: number, newerDropped = 0): string {
	const parts = [`${records(kept)} kept${dropped > 0 || newerDropped > 0 ? ` (at most ${cap.toLocaleString('en-US')})` : ''}`];
	if (dropped > 0) {
		parts.push(`${dropped.toLocaleString('en-US')} older ${dropped === 1 ? 'record' : 'records'} left out; Load older to page back`);
	}
	if (newerDropped > 0) {
		parts.push(`${newerDropped.toLocaleString('en-US')} newer ${newerDropped === 1 ? 'record' : 'records'} dropped`);
	}
	return `${parts.join('; ')}.`;
}

/** The range button's text: the choice, or a custom range's From – To. */
export function rangeButtonText(state: LogsViewState): string {
	const { range } = state;
	if (range.kind === 'custom') {
		return `${localMinute(range.from)} – ${localMinute(range.to ?? range.from)}`;
	}
	return range.kind === 'deploy' ? `Since the last deploy (${localMinute(range.from)})` : RANGE_LABELS[range.kind];
}

/** A menu entry's text: Since the last deploy names its time when it is known. */
function optionText(kind: RangeKind, state: LogsViewState): string {
	return kind === 'deploy' && state.deployedAt !== null ? `${RANGE_LABELS.deploy} (${localMinute(state.deployedAt)})` : RANGE_LABELS[kind];
}

interface State {
	readonly title: string | null;
	readonly rows: readonly LogRow[];
	readonly dropped: number;
	readonly cap: number;
	readonly status: string;
	readonly view: LogsViewState;
}

const INITIAL_VIEW: LogsViewState = { range: { kind: 'recent', from: 0, to: null }, live: true, done: false, older: 'more', olderError: null, newerDropped: 0, retention: null, deployedAt: null };
const INITIAL: State = { title: null, rows: [], dropped: 0, cap: MAX_LOG_ROWS, status: '', view: INITIAL_VIEW };

function levelClass(level: string): string {
	const l = level.toUpperCase();
	return l === 'ERROR' || l === 'FATAL' ? 'rpcn-logs-level rpcn-logs-error' : l === 'WARN' || l === 'WARNING' ? 'rpcn-logs-level rpcn-logs-warn' : 'rpcn-logs-level';
}

/** The time-range menu: the choices, Custom range's From and To (checked here first), the retention line. */
function RangeMenu({ state, post, close }: { readonly state: LogsViewState; readonly post: (m: LogsWebviewMessage) => void; readonly close: () => void }) {
	const initialFrom = state.range.kind === 'custom' ? localMinute(state.range.from) : localMinute(Date.now() - 24 * 60 * 60_000);
	const initialTo = state.range.kind === 'custom' && state.range.to !== null ? localMinute(state.range.to) : localMinute(Date.now());
	const [custom, setCustom] = useState(state.range.kind === 'custom');
	const [from, setFrom] = useState(initialFrom);
	const [to, setTo] = useState(initialTo);
	const [error, setError] = useState<string | undefined>(undefined);
	const choose = (kind: RangeKind) => {
		if (kind === 'custom') {
			setCustom(true);
			return;
		}
		post({ type: 'rangeChosen', range: { kind } });
		close();
	};
	const applyCustom = () => {
		const why = customRangeError(from, to, Date.now());
		setError(why);
		if (why) {
			return;
		}
		post({ type: 'rangeChosen', range: { kind: 'custom', from: parseLocalDateTime(from)!, to: parseLocalDateTime(to)! } });
		close();
	};
	return (
		<div className="rpcn-logs-menu" role="dialog" aria-label="Time range" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
			<div role="listbox" aria-label="Time range">
				{RANGE_KINDS.map((kind) => (
					<Fragment key={kind}>
						{kind === 'custom' ? <div className="rpcn-logs-menu-sep" role="separator" /> : null}
						<button type="button" role="option" aria-selected={state.range.kind === kind} data-kind={kind}
							className={state.range.kind === kind ? 'rpcn-logs-option rpcn-logs-option-selected' : 'rpcn-logs-option'} onClick={() => choose(kind)}>
							{optionText(kind, state)}
						</button>
					</Fragment>
				))}
			</div>
			{custom ? (
				<form className="rpcn-logs-custom" onSubmit={(e) => { e.preventDefault(); applyCustom(); }}>
					<label>From<input type="text" name="from" value={from} onChange={(e) => setFrom(e.target.value)} aria-invalid={error?.startsWith('From') ?? false} /></label>
					<label>To<input type="text" name="to" value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={error?.startsWith('To') ?? false} /></label>
					<button type="submit" className="rpcn-logs-button">Show</button>
					{error ? <p className="rpcn-logs-custom-error" role="alert">{error}</p> : null}
				</form>
			) : null}
			<p className="rpcn-logs-retention">{state.retention ?? 'Reading the topic\'s retention…'}</p>
		</div>
	);
}

export function LogsView({ post }: { readonly post: (message: LogsWebviewMessage) => void }) {
	const [state, setState] = useState<State>(INITIAL);
	const [menuOpen, setMenuOpen] = useState(false);
	const scroller = useRef<HTMLDivElement>(null);
	/** Whether the table was at its bottom before the last change (it then follows). */
	const atBottom = useRef(true);
	/** Rows were put before the shown ones: keep the view where it was, not at the bottom. */
	const prepended = useRef<{ readonly height: number; readonly top: number } | undefined>(undefined);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const m = parseLogsHostMessage(event.data);
			if (!m) {
				return;
			}
			if (m.type === 'prepend' && scroller.current) {
				prepended.current = { height: scroller.current.scrollHeight, top: scroller.current.scrollTop };
			}
			setState((s) => {
				switch (m.type) {
					case 'show':
						return { title: m.title, rows: m.rows.slice(-m.cap), dropped: m.dropped, cap: m.cap, status: m.status, view: m.state };
					case 'append': {
						const rows = [...s.rows, ...m.rows];
						return { ...s, rows: rows.length > s.cap ? rows.slice(rows.length - s.cap) : rows, dropped: m.dropped };
					}
					case 'prepend':
						return { ...s, rows: [...m.rows, ...s.rows].slice(0, s.cap), dropped: m.dropped };
					case 'status':
						return { ...s, status: m.status };
					case 'state':
						return { ...s, view: m.state };
				}
			});
		};
		window.addEventListener('message', onMessage);
		post({ type: 'ready' });
		return () => window.removeEventListener('message', onMessage);
	}, [post]);

	useLayoutEffect(() => {
		const el = scroller.current;
		const before = prepended.current;
		prepended.current = undefined;
		if (el && before) {
			el.scrollTop = before.top + (el.scrollHeight - before.height);
		} else if (el && atBottom.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [state.rows]);

	const onScroll = () => {
		const el = scroller.current;
		if (el) {
			atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
		}
	};

	const openMenu = () => {
		const next = !menuOpen;
		setMenuOpen(next);
		if (next && state.view.retention === null) {
			post({ type: 'retentionRequested' });
		}
	};

	const { view } = state;
	const shown = state.title !== null;
	const gaps = new Map(gapsIn(state.rows).map((g) => [g.before, g]));
	const emptyText = view.range.to !== null && view.done ? noRecordsText(view.range.from, view.range.to) : NO_RECORDS_TEXT;
	const oldest = state.rows[0]?.time ?? view.range.from;
	/** A bounded range still being read: Load older waits until it is read (the host refuses it too). */
	const rangeReading = view.range.to !== null && !view.done;

	return (
		<div className="rpcn-logs">
			<div className="rpcn-logs-header">
				<h1 className="rpcn-logs-title">{state.title ?? NO_PIPELINE_TITLE}</h1>
				<span className="rpcn-logs-status" role="status">{state.status}</span>
				{shown ? (
					<div className="rpcn-logs-tools">
						<button type="button" className="rpcn-logs-button rpcn-logs-live" aria-pressed={view.live} onClick={() => post({ type: 'liveToggled', live: !view.live })}>
							<span className={view.live ? 'rpcn-logs-dot rpcn-logs-dot-on' : 'rpcn-logs-dot'} aria-hidden="true" />Live
						</button>
						<div className="rpcn-logs-range">
							<button type="button" className="rpcn-logs-button rpcn-logs-range-button" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={openMenu}>
								{rangeButtonText(view)} ▾
							</button>
							{menuOpen ? <RangeMenu state={view} post={post} close={() => setMenuOpen(false)} /> : null}
						</div>
					</div>
				) : null}
			</div>
			<div className="rpcn-logs-scroll" ref={scroller} onScroll={onScroll} tabIndex={0} aria-label="Log records">
				{shown ? (
					<div className="rpcn-logs-older">
						{view.older === 'none'
							? <span className="rpcn-logs-no-older">{NO_OLDER_TEXT}</span>
							: (
								<button type="button" className="rpcn-logs-button rpcn-logs-older-button" disabled={view.older === 'reading' || rangeReading} onClick={() => post({ type: 'olderRequested' })}>
									{view.older === 'reading' ? LOADING_OLDER_TEXT : `Load older records (before ${localMinute(oldest)})`}
								</button>
							)}
						{view.olderError ? <span className="rpcn-logs-older-error" role="alert">{view.olderError}</span> : null}
					</div>
				) : null}
				{shown && state.rows.length === 0 ? <p className="rpcn-logs-empty rpcn-logs-gap">{emptyText}</p> : null}
				{state.rows.length > 0 ? (
					<table className="rpcn-logs-table">
						<thead>
							<tr><th scope="col">Time</th><th scope="col">Level</th><th scope="col">Message</th><th scope="col">Instance</th></tr>
						</thead>
						<tbody>
							{state.rows.map((row, i) => {
								const gap = gaps.get(i);
								return (
									<Fragment key={row.id}>
										{gap ? <tr className="rpcn-logs-gap-row"><td colSpan={4} className="rpcn-logs-gap">{noRecordsText(gap.from, gap.to)}</td></tr> : null}
										<tr data-id={row.id}>
											<td className="rpcn-logs-time">{localTime(row.time)}</td>
											<td className={levelClass(row.level)}>{row.level}</td>
											<td className={row.raw ? 'rpcn-logs-message rpcn-logs-raw' : 'rpcn-logs-message'}>
												{row.message}
												{row.fields.map(([key, value]) => (
													<span key={key} className="rpcn-logs-field"> <span className="rpcn-logs-key">{key}</span>=<span className="rpcn-logs-value">{value}</span></span>
												))}
											</td>
											<td className="rpcn-logs-instance">{row.instance}</td>
										</tr>
									</Fragment>
								);
							})}
						</tbody>
					</table>
				) : null}
			</div>
			{shown ? <div className="rpcn-logs-footer">{footerText(state.rows.length, state.dropped, state.cap, view.newerDropped)}</div> : null}
		</div>
	);
}
