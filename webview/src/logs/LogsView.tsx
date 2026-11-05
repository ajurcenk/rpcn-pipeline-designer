// The Pipeline Logs tab's view (ticket 6.2, AD-24): the header names the pipeline ("<pipeline> ·
// <cluster>") and says how reading goes; the table shows each kept record, oldest first and newest at
// the bottom: its time in local time, its level, its message followed by its further fields
// (`key=value`), and its instance; a value that is not a JSON object is its text. The footer says how
// many records are kept, and how many older ones were dropped for the cap. While the table is scrolled
// to the bottom it stays there as records arrive. The host masks every text before it is posted.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MAX_LOG_ROWS, parseLogsHostMessage, type LogRow, type LogsWebviewMessage } from '../../../src/shared/logsProtocol';

export const NO_PIPELINE_TITLE = 'No pipeline';
export const NO_RECORDS_TEXT = 'No records of this pipeline yet.';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `2026-11-05 16:49:15.510`, in the viewer's local time. */
export function localTime(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** "3 records", "1 record". */
const records = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'record' : 'records'}`;

/** The footer: how many are kept, and how many older ones were dropped for the cap. */
export function footerText(kept: number, dropped: number, cap: number): string {
	return dropped > 0
		? `${records(kept)} kept (at most ${cap.toLocaleString('en-US')}); ${dropped.toLocaleString('en-US')} older ${dropped === 1 ? 'one' : 'ones'} dropped.`
		: `${records(kept)} kept.`;
}

interface State {
	readonly title: string | null;
	readonly rows: readonly LogRow[];
	readonly dropped: number;
	readonly cap: number;
	readonly status: string;
}

const INITIAL: State = { title: null, rows: [], dropped: 0, cap: MAX_LOG_ROWS, status: '' };

function levelClass(level: string): string {
	const l = level.toUpperCase();
	return l === 'ERROR' || l === 'FATAL' ? 'rpcn-logs-level rpcn-logs-error' : l === 'WARN' || l === 'WARNING' ? 'rpcn-logs-level rpcn-logs-warn' : 'rpcn-logs-level';
}

export function LogsView({ post }: { readonly post: (message: LogsWebviewMessage) => void }) {
	const [state, setState] = useState<State>(INITIAL);
	const scroller = useRef<HTMLDivElement>(null);
	/** Whether the table was at its bottom before the last change (it then follows). */
	const atBottom = useRef(true);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const m = parseLogsHostMessage(event.data);
			if (!m) {
				return;
			}
			setState((s) => {
				switch (m.type) {
					case 'show':
						return { title: m.title, rows: m.rows.slice(-m.cap), dropped: m.dropped, cap: m.cap, status: m.status };
					case 'append': {
						const rows = [...s.rows, ...m.rows];
						return { ...s, rows: rows.length > s.cap ? rows.slice(rows.length - s.cap) : rows, dropped: m.dropped };
					}
					case 'status':
						return { ...s, status: m.status };
				}
			});
		};
		window.addEventListener('message', onMessage);
		post({ type: 'ready' });
		return () => window.removeEventListener('message', onMessage);
	}, [post]);

	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && atBottom.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [state.rows]);

	const onScroll = () => {
		const el = scroller.current;
		if (el) {
			atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
		}
	};

	return (
		<div className="rpcn-logs">
			<div className="rpcn-logs-header">
				<h1 className="rpcn-logs-title">{state.title ?? NO_PIPELINE_TITLE}</h1>
				<span className="rpcn-logs-status" role="status">{state.status}</span>
			</div>
			<div className="rpcn-logs-scroll" ref={scroller} onScroll={onScroll} tabIndex={0} aria-label="Log records">
				{state.title !== null && state.rows.length === 0 ? <p className="rpcn-logs-empty">{NO_RECORDS_TEXT}</p> : null}
				{state.rows.length > 0 ? (
					<table className="rpcn-logs-table">
						<thead>
							<tr><th scope="col">Time</th><th scope="col">Level</th><th scope="col">Message</th><th scope="col">Instance</th></tr>
						</thead>
						<tbody>
							{state.rows.map((row) => (
								<tr key={row.id} data-id={row.id}>
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
							))}
						</tbody>
					</table>
				) : null}
			</div>
			{state.title !== null ? <div className="rpcn-logs-footer">{footerText(state.rows.length, state.dropped, state.cap)}</div> : null}
		</div>
	);
}
