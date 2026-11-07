// The Pipeline Logs tab's view (tickets 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, AD-24): the header names the pipeline ("<pipeline> ·
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
//
// Ticket 6.4 (board 4): under the header, the level chips (Error, Warn, Info, Debug, Other, each with
// its count of the records read), the search box (Match case `Aa`, regular expression `.*`; an invalid
// one is refused at the box with its error and nothing is posted; posted once typing pauses), the field
// chips made by clicking a field's value or an instance in a record (× removes one) and "N of M records
// match". The host applies the filter while it reads; the view highlights the search's matches. A
// record's ▸ expands it in place: its whole JSON, **Copy JSON** (the webview's clipboard, else the
// host's) and **Show records around this one**.
//
// Ticket 6.5: opened from an Error, the ERROR records are highlighted (`highlightErrors`); around the
// error, the record found (`focusId`) is scrolled to once and marked, and a note above the records says
// when none was found ("No ERROR record in the last 24 hours").
//
// Ticket 6.6 (board 6): the host's `panelState` fills the list area under the toolbar (the header and
// the filter bar stay): No log access (Set up log access…), Sign-in refused (Set up log access again…,
// Retry), Not allowed (Retry, Use another user…), No records (Last 24 hours, Show every level when
// levels are hidden), Reading (the count so far, Stop reading) and Connection lost (the wait counted
// down, Retry now). The rows already shown stay below Reading and Connection lost. 6.4's "No records
// match" stays its own line.
//
// Ticket 6.7 (board 5): above the list, for a bounded range (and Since the last deploy), the host's
// records-per-time strip: a bar per slot (a button in a flex row, no chart library), its height the
// slot's records against the largest slot's, its ERROR and WARN records marked on top in the theme's
// error and warning colours, and with a filter on the matching part drawn darker; its accessible name
// says the slot and its counts. The axis under it, "Records per <size>" over it. A bar's click (or Enter)
// reads that slot; the arrow keys, Home and End move between the bars (one tab stop).
//
// Ticket 6.8 (board 3): **Export…** at the end of the toolbar asks the host to save the rows it shows
// (`exportRequested`); disabled while no row is shown. The host has the save dialog and the messages.

import { Fragment, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
	customRangeError, filterActive, gapsIn, LEVEL_LABELS, levelOfText, localMinute, LOG_LEVELS, MAX_FIELD_FILTERS, MAX_LOG_ROWS, NO_COUNTS, NO_FILTER, NO_PANEL_STATE,
	noRecordsText, panelStateTexts, parseLocalDateTime, parseLogsHostMessage, RANGE_KINDS, RANGE_LABELS, retryText, searchError, searchPattern, shortTime, slotBounds,
	slotLabel, slotSizeText, soFarText, type LogFilter, type LogLevel, type LogRow, type LogsPanelState, type LogStrip, type LogsViewState, type LogsWebviewMessage,
	type RangeKind,
} from '../../../src/shared/logsProtocol';

export const NO_PIPELINE_TITLE = 'No pipeline';
export const NO_RECORDS_TEXT = 'No records of this pipeline yet.';
export const NO_OLDER_TEXT = 'No older records';
export const LOADING_OLDER_TEXT = 'Loading older records…';
export const NO_MATCH_TEXT = 'No records match';
/** Ticket 6.6: Stop reading came before any record. */
export const STOPPED_EMPTY_TEXT = 'Reading stopped before any record';
/** The search is posted once typing pauses this long. */
export const SEARCH_DEBOUNCE_MS = 300;
/** Ticket 6.8: the toolbar's Export… button and its accessible name. */
export const EXPORT_TEXT = 'Export…';
export const EXPORT_LABEL = 'Export the shown records';
/** The field chip that stands for the instance column (as the host's `filter.ts`). */
const INSTANCE_FIELD = 'instance_id';

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

/** "40 of 20,000 records match". */
export function matchText(matched: number, total: number): string {
	return `${matched.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${total === 1 ? 'record matches' : 'records match'}`;
}

/** A field chip's text: "instance …c1gjg", "path=/config/connect.yaml" (long values cut). */
export function chipText(key: string, value: string): string {
	if (key === INSTANCE_FIELD) {
		return `instance ${value.length > 8 ? `…${value.slice(-5)}` : value}`;
	}
	return `${key}=${value.length > 24 ? `${value.slice(0, 23)}…` : value}`;
}

/** `text` split at the matches of `re` (a global pattern; empty matches skipped). */
export function highlightParts(text: string, re: RegExp | undefined): { readonly text: string; readonly match: boolean }[] {
	if (!re || text === '') {
		return [{ text, match: false }];
	}
	const parts: { text: string; match: boolean }[] = [];
	let at = 0;
	re.lastIndex = 0;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		if (m[0].length === 0) {
			re.lastIndex++;
			continue;
		}
		if (m.index > at) {
			parts.push({ text: text.slice(at, m.index), match: false });
		}
		parts.push({ text: m[0], match: true });
		at = m.index + m[0].length;
	}
	if (at < text.length) {
		parts.push({ text: text.slice(at), match: false });
	}
	return parts.length > 0 ? parts : [{ text, match: false }];
}

function Highlighted({ text, re }: { readonly text: string; readonly re: RegExp | undefined }): ReactNode {
	const parts = highlightParts(text, re);
	if (parts.length === 1 && !parts[0].match) {
		return text;
	}
	return parts.map((p, i) => (p.match ? <mark key={i} className="rpcn-logs-mark">{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>));
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

const INITIAL_VIEW: LogsViewState = {
	range: { kind: 'recent', from: 0, to: null }, live: true, done: false, older: 'more', olderError: null, olderNote: null, newerDropped: 0, retention: null, deployedAt: null,
	olderBefore: 0, filter: NO_FILTER, counts: NO_COUNTS, highlightErrors: false, focusId: null, note: null, panelState: NO_PANEL_STATE,
	stoppedShort: false, settingUp: false, strip: null,
};
const INITIAL: State = { title: null, rows: [], dropped: 0, cap: MAX_LOG_ROWS, status: '', view: INITIAL_VIEW };

function levelClass(level: string): string {
	const l = levelOfText(level);
	return l === 'error' ? 'rpcn-logs-level rpcn-logs-error' : l === 'warn' ? 'rpcn-logs-level rpcn-logs-warn' : 'rpcn-logs-level';
}

/** Board 4's bar: the level chips with their counts, the search box and its toggles, the field chips, "N of M records match". */
function FilterBar({ draft, view, change }: {
	readonly draft: LogFilter;
	readonly view: LogsViewState;
	readonly change: (filter: LogFilter, debounce?: boolean) => void;
}) {
	const error = searchError(draft);
	const toggleLevel = (level: LogLevel) => {
		const on = draft.levels.includes(level);
		change({ ...draft, levels: LOG_LEVELS.filter((l) => (l === level ? !on : draft.levels.includes(l))) });
	};
	return (
		<div className="rpcn-logs-filters">
			<div className="rpcn-logs-levels" role="group" aria-label="Levels">
				{LOG_LEVELS.map((level) => (
					<button key={level} type="button" data-level={level} aria-pressed={draft.levels.includes(level)}
						className={`rpcn-logs-chip rpcn-logs-level-chip rpcn-logs-level-${level}`} onClick={() => toggleLevel(level)}>
						<span className="rpcn-logs-level-label">{LEVEL_LABELS[level]}</span> <span className="rpcn-logs-count">{view.counts.levels[level].toLocaleString('en-US')}</span>
					</button>
				))}
			</div>
			<div className="rpcn-logs-search">
				<input type="text" className="rpcn-logs-search-input" aria-label="Search the message and every field" placeholder="Search"
					value={draft.text} aria-invalid={error !== undefined} onChange={(e) => change({ ...draft, text: e.target.value }, true)} />
				<button type="button" className="rpcn-logs-toggle rpcn-logs-match-case" title="Match case" aria-label="Match case" aria-pressed={draft.matchCase}
					onClick={() => change({ ...draft, matchCase: !draft.matchCase })}>Aa</button>
				<button type="button" className="rpcn-logs-toggle rpcn-logs-regex" title="Use regular expression" aria-label="Use regular expression" aria-pressed={draft.regex}
					onClick={() => change({ ...draft, regex: !draft.regex })}>.*</button>
			</div>
			{draft.fields.map(([key, value], i) => (
				<span key={`${key}=${value}`} className="rpcn-logs-chip rpcn-logs-field-chip" title={`${key}=${value}`}>
					{chipText(key, value)}
					<button type="button" className="rpcn-logs-chip-remove" aria-label={`Remove the filter ${key}=${value}`}
						onClick={() => change({ ...draft, fields: draft.fields.filter((_f, j) => j !== i) })}>×</button>
				</span>
			))}
			{filterActive(view.filter) ? <span className="rpcn-logs-match-count">{matchText(view.counts.matched, view.counts.total)}</span> : null}
			{error ? <p className="rpcn-logs-search-error" role="alert">{error}</p> : null}
		</div>
	);
}

/** The seconds a lost connection's countdown shows at `now` (at least 1, at most the state's wait); `null`: trying now. */
export function secondsLeft(state: Extract<LogsPanelState, { kind: 'connectionLost' }>, now: number): number | null {
	if (state.retryAt === null) {
		return null;
	}
	return Math.max(1, Math.min(state.retryInS, Math.ceil((state.retryAt - now) / 1000)));
}

/** A state's buttons (board 6): the label, the message it posts, whether it is the primary one. */
export function stateActions(state: LogsPanelState): readonly { readonly label: string; readonly message: LogsWebviewMessage; readonly primary?: true }[] {
	switch (state.kind) {
		case 'noAccess':
			return [{ label: 'Set up log access…', message: { type: 'setUpAccess' }, primary: true }];
		case 'signIn':
			return [{ label: 'Set up log access again…', message: { type: 'setUpAccess' }, primary: true }, { label: 'Retry', message: { type: 'retryNow' } }];
		case 'notAllowed':
			return [{ label: 'Retry', message: { type: 'retryNow' } }, { label: 'Use another user…', message: { type: 'useAnotherUser' } }];
		case 'noRecords':
			return [
				{ label: 'Last 24 hours', message: { type: 'last24h' } },
				...(state.hiddenLevels.length > 0 ? [{ label: 'Show every level', message: { type: 'showEveryLevel' } } as const] : []),
			];
		case 'reading':
			return [{ label: 'Stop reading', message: { type: 'stopReading' } }];
		case 'connectionLost':
			return [{ label: 'Retry now', message: { type: 'retryNow' } }];
		case 'none':
			return [];
	}
}

/** Board 6's panel for `state`: its label, title, text and buttons; a lost connection's wait counted down. */
function StatePanel({ state, post, settingUp }: { readonly state: LogsPanelState; readonly post: (m: LogsWebviewMessage) => void; readonly settingUp: boolean }) {
	const [now, setNow] = useState(() => Date.now());
	const counting = state.kind === 'connectionLost' && state.retryAt !== null;
	useEffect(() => {
		if (!counting) {
			return undefined;
		}
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(timer);
	}, [counting, state]);
	const seconds = state.kind === 'connectionLost' ? secondsLeft(state, now) : undefined;
	const texts = panelStateTexts(state, seconds);
	if (!texts) {
		return null;
	}
	const alert = state.kind === 'signIn' || state.kind === 'notAllowed' || state.kind === 'connectionLost';
	// The countdown changes every second: kept out of the alert's announcement (`aria-live="off"`).
	const retry = seconds === undefined ? undefined : retryText(seconds);
	const body = retry !== undefined && texts.body.endsWith(retry) ? texts.body.slice(0, -retry.length) : texts.body;
	return (
		<section className={`rpcn-logs-state rpcn-logs-state-${state.kind}`} data-state={state.kind} role={alert ? 'alert' : 'status'} aria-label={texts.label}>
			<div className="rpcn-logs-state-label">{texts.label}</div>
			<div className="rpcn-logs-state-title">{texts.title}</div>
			<div className="rpcn-logs-state-body">
				{retry !== undefined && body !== texts.body ? <>{body}<span className="rpcn-logs-state-countdown" aria-live="off">{retry}</span></> : texts.body}
			</div>
			{state.kind === 'reading' ? (
				<>
					<div className="rpcn-logs-progress" role="progressbar" aria-label="Records read"><div className="rpcn-logs-progress-bar" /></div>
					<div className="rpcn-logs-state-count">{soFarText(state.count)}</div>
				</>
			) : null}
			<div className="rpcn-logs-state-actions">
				{stateActions(state).map((a) => (
					<button key={a.label} type="button" className={a.primary ? 'rpcn-logs-button rpcn-logs-primary' : 'rpcn-logs-button'}
						disabled={settingUp && (a.message.type === 'setUpAccess' || a.message.type === 'useAnotherUser')} onClick={() => post(a.message)}>{a.label}</button>
				))}
			</div>
		</section>
	);
}

/** The strip's hint beside its title (board 5). */
export const STRIP_HINT = 'Click a bar to show its records';

/** "Records per 30 minutes". */
export function stripTitle(size: number): string {
	return `Records ${slotSizeText(size)}`;
}

/** The axis under the strip: four times, from its start to its end. */
export function stripAxis(strip: Pick<LogStrip, 'start' | 'end'>): string[] {
	return [0, 1, 2, 3].map((k) => shortTime(strip.start + ((strip.end - strip.start) * k) / 3));
}

/**
 * Board 5's strip: a bar per slot, its height the slot's records against the largest slot's, its errors
 * and warnings marked on top, the matching part darker with a filter on; each bar a button (its name the
 * slot and its counts) that reads its slot. One tab stop: the arrow keys, Home and End move between bars.
 */
function Strip({ strip, filtered, post }: { readonly strip: LogStrip; readonly filtered: boolean; readonly post: (m: LogsWebviewMessage) => void }) {
	const count = strip.total.length;
	const [current, setCurrent] = useState(count - 1);
	const bars = useRef<(HTMLButtonElement | null)[]>([]);
	const at = Math.min(current, count - 1);
	const max = Math.max(1, ...strip.total);
	const title = stripTitle(strip.size);
	const move = (to: number) => {
		const next = Math.max(0, Math.min(count - 1, to));
		setCurrent(next);
		bars.current[next]?.focus();
	};
	const onKeyDown = (e: KeyboardEvent, i: number) => {
		const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? count - 1 : undefined;
		if (to !== undefined) {
			e.preventDefault();
			move(to);
		}
	};
	return (
		<div className="rpcn-logs-strip">
			<div className="rpcn-logs-strip-head"><span className="rpcn-logs-strip-title">{title}</span><span className="rpcn-logs-strip-hint">{STRIP_HINT}</span></div>
			<div className="rpcn-logs-strip-bars" role="group" aria-label={title}>
				{strip.total.map((total, i) => {
					const { from, to } = slotBounds(strip, count, i);
					const counts = { total, errors: strip.errors[i], warns: strip.warns[i], matched: strip.matched[i] };
					const label = slotLabel(from, to + 1, counts, filtered);
					return (
						<button key={i} type="button" ref={(el) => { bars.current[i] = el; }} className="rpcn-logs-slot" data-slot={i} aria-label={label} title={label}
							tabIndex={i === at ? 0 : -1} onFocus={() => setCurrent(i)} onKeyDown={(e) => onKeyDown(e, i)} onClick={() => post({ type: 'slotChosen', from, to })}>
							{total > 0 ? (
								// The marks are drawn inside the bar's height, at its top: every bar is as high as its records.
								<span className={filtered ? 'rpcn-logs-slot-bar rpcn-logs-slot-filtered' : 'rpcn-logs-slot-bar'} style={{ height: `${(total / max) * 100}%` }} aria-hidden="true">
									{filtered && counts.matched > 0 ? <span className="rpcn-logs-slot-matched" style={{ height: `${(counts.matched / total) * 100}%` }} /> : null}
									{counts.errors > 0 || counts.warns > 0 ? (
										<span className="rpcn-logs-slot-marks">
											{counts.errors > 0 ? <span className="rpcn-logs-slot-error" /> : null}
											{counts.warns > 0 ? <span className="rpcn-logs-slot-warn" /> : null}
										</span>
									) : null}
								</span>
							) : null}
						</button>
					);
				})}
			</div>
			<div className="rpcn-logs-strip-axis" aria-hidden="true">{stripAxis(strip).map((t, i) => <span key={i}>{t}</span>)}</div>
		</div>
	);
}

/** A record expanded in place: its whole JSON, Copy JSON, Show records around this one. */
function RecordDetail({ row, post, collapse }: { readonly row: LogRow; readonly post: (m: LogsWebviewMessage) => void; readonly collapse: () => void }) {
	const [copied, setCopied] = useState(false);
	const text = row.json ?? row.message;
	const copy = () => {
		const viaHost = () => post({ type: 'copyRequested', id: row.id });
		const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
		if (!clipboard?.writeText) {
			viaHost();
			setCopied(true);
			return;
		}
		clipboard.writeText(text).then(() => setCopied(true), () => {
			viaHost();
			setCopied(true);
		});
	};
	return (
		<div className="rpcn-logs-detail-body">
			<pre className="rpcn-logs-json">{text}</pre>
			<div className="rpcn-logs-detail-actions">
				<button type="button" className="rpcn-logs-button rpcn-logs-copy" onClick={copy}>Copy JSON</button>
				<button type="button" className="rpcn-logs-button rpcn-logs-around" onClick={() => { collapse(); post({ type: 'aroundRequested', id: row.id }); }}>
					Show records around this one
				</button>
				{copied ? <span className="rpcn-logs-copied" role="status">Copied.</span> : null}
			</div>
		</div>
	);
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
	/** The filter as edited here; posted at once, or once typing pauses for the search. */
	const [draft, setDraft] = useState<LogFilter>(NO_FILTER);
	/** The last filter posted: a `show` with another one (cleared by the host) replaces the draft. */
	const lastPosted = useRef<LogFilter>(NO_FILTER);
	/** The pipeline shown ("<pipeline> · <cluster>"): another one drops the draft and its timer. */
	const shownTitle = useRef<string | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	/** The records expanded in place. */
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	/** The marked row last scrolled to (ticket 6.5): scrolled to once, then the view is the user's. */
	const focused = useRef<string | null>(null);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const m = parseLogsHostMessage(event.data);
			if (!m) {
				return;
			}
			if (m.type === 'prepend' && scroller.current) {
				prepended.current = { height: scroller.current.scrollHeight, top: scroller.current.scrollTop };
			}
			if (m.type === 'show') {
				setExpanded(new Set());
				const switched = m.title !== shownTitle.current;
				shownTitle.current = m.title;
				if (switched || JSON.stringify(m.state.filter) !== JSON.stringify(lastPosted.current)) {
					// Another pipeline, or the host's filter is not the one posted last (cleared, or the page loaded
					// again): a search still waiting on its timer is not posted.
					clearTimeout(timer.current);
					timer.current = undefined;
					lastPosted.current = m.state.filter;
					setDraft(m.state.filter);
				}
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
		return () => {
			window.removeEventListener('message', onMessage);
			clearTimeout(timer.current);
		};
	}, [post]);

	const sendFilter = (filter: LogFilter) => {
		clearTimeout(timer.current);
		timer.current = undefined;
		if (searchError(filter) !== undefined) {
			// Refused at the box (its error shows): nothing is read.
			return;
		}
		lastPosted.current = filter;
		post({ type: 'filterChanged', filter });
	};
	const changeFilter = (filter: LogFilter, debounce = false) => {
		setDraft(filter);
		if (debounce) {
			clearTimeout(timer.current);
			timer.current = setTimeout(() => sendFilter(filter), SEARCH_DEBOUNCE_MS);
		} else {
			sendFilter(filter);
		}
	};
	const addChip = (key: string, value: string) => {
		if (draft.fields.length >= MAX_FIELD_FILTERS || draft.fields.some(([k, v]) => k === key && v === value)) {
			return;
		}
		changeFilter({ ...draft, fields: [...draft.fields, [key, value]] });
	};
	const toggleExpanded = (id: string) => setExpanded((e) => {
		const next = new Set(e);
		if (!next.delete(id)) {
			next.add(id);
		}
		return next;
	});
	const applied = state.view.filter;
	const marks = useMemo(() => {
		const p = searchPattern(applied.text, applied.matchCase, applied.regex, true);
		return p instanceof RegExp ? p : undefined;
	}, [applied.text, applied.matchCase, applied.regex]);

	useLayoutEffect(() => {
		const el = scroller.current;
		const before = prepended.current;
		prepended.current = undefined;
		const focusId = state.view.focusId;
		const target = el && focusId !== null && focused.current !== focusId
			? [...el.querySelectorAll<HTMLElement>('tr[data-id]')].find((tr) => tr.dataset.id === focusId) : undefined;
		if (el && target) {
			// The record around the error: scrolled to once; the view no longer follows the bottom.
			focused.current = focusId;
			atBottom.current = false;
			if (typeof target.scrollIntoView === 'function') {
				target.scrollIntoView({ block: 'center' });
			}
		} else if (el && before) {
			el.scrollTop = before.top + (el.scrollHeight - before.height);
		} else if (el && atBottom.current) {
			el.scrollTop = el.scrollHeight;
		}
		if (focusId === null) {
			focused.current = null;
		}
	}, [state.rows, state.view.focusId]);

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
	const panel = view.panelState;
	const emptyText = view.stoppedShort ? STOPPED_EMPTY_TEXT : filterActive(view.filter) && view.counts.total > 0 ? NO_MATCH_TEXT
		: view.range.to !== null && view.done ? noRecordsText(view.range.from, view.range.to) : NO_RECORDS_TEXT;
	const oldest = view.olderBefore;
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
						<button type="button" className="rpcn-logs-button rpcn-logs-export" aria-label={EXPORT_LABEL} title={EXPORT_LABEL}
							disabled={state.rows.length === 0} onClick={() => post({ type: 'exportRequested' })}>{EXPORT_TEXT}</button>
					</div>
				) : null}
			</div>
			{shown ? <FilterBar draft={draft} view={view} change={changeFilter} /> : null}
			{shown && view.strip ? <Strip strip={view.strip} filtered={filterActive(view.filter)} post={post} /> : null}
			<div className="rpcn-logs-scroll" ref={scroller} onScroll={onScroll} tabIndex={0} aria-label="Log records">
				{shown && panel.kind !== 'noAccess' ? (
					<div className="rpcn-logs-older">
						{view.older === 'none'
							? <span className="rpcn-logs-no-older">{NO_OLDER_TEXT}</span>
							: (
								<button type="button" className="rpcn-logs-button rpcn-logs-older-button" disabled={view.older === 'reading' || rangeReading} onClick={() => post({ type: 'olderRequested' })}>
									{view.older === 'reading' ? LOADING_OLDER_TEXT : `Load older records (before ${localMinute(oldest)})`}
								</button>
							)}
						{view.olderError ? <span className="rpcn-logs-older-error" role="alert">{view.olderError}</span> : null}
						{view.olderNote ? <span className="rpcn-logs-older-note" role="status">{view.olderNote}</span> : null}
					</div>
				) : null}
				{shown && view.note ? <p className="rpcn-logs-note" role="status">{view.note}</p> : null}
				{shown && panel.kind !== 'none' ? <StatePanel state={panel} post={post} settingUp={view.settingUp} /> : null}
				{shown && panel.kind === 'none' && state.rows.length === 0 ? <p className="rpcn-logs-empty rpcn-logs-gap">{emptyText}</p> : null}
				{state.rows.length > 0 ? (
					<table className="rpcn-logs-table">
						<thead>
							<tr><th scope="col">Time</th><th scope="col">Level</th><th scope="col">Message</th><th scope="col">Instance</th></tr>
						</thead>
						<tbody>
							{state.rows.map((row, i) => {
								const gap = gaps.get(i);
								const open = expanded.has(row.id);
								const classes = [
									open ? 'rpcn-logs-open' : '',
									view.highlightErrors && levelOfText(row.level) === 'error' ? 'rpcn-logs-error-row' : '',
									view.focusId === row.id ? 'rpcn-logs-focus' : '',
								].filter(Boolean).join(' ');
								return (
									<Fragment key={row.id}>
										{gap ? <tr className="rpcn-logs-gap-row"><td colSpan={4} className="rpcn-logs-gap">{noRecordsText(gap.from, gap.to)}</td></tr> : null}
										<tr data-id={row.id} className={classes || undefined} aria-current={view.focusId === row.id ? 'true' : undefined}>
											<td className="rpcn-logs-time">
												<button type="button" className="rpcn-logs-expand" aria-expanded={open} aria-label={open ? 'Hide the whole record' : 'Show the whole record'}
													onClick={() => toggleExpanded(row.id)} />
												{localTime(row.time)}
											</td>
											<td className={levelClass(row.level)}><Highlighted text={row.level} re={marks} /></td>
											<td className={row.raw ? 'rpcn-logs-message rpcn-logs-raw' : 'rpcn-logs-message'}>
												<Highlighted text={row.message} re={marks} />
												{row.fields.map(([key, value]) => (
													<span key={key} className="rpcn-logs-field"> <span className="rpcn-logs-key"><Highlighted text={key} re={marks} /></span>=<button
														type="button" className="rpcn-logs-value" title={`Show only records with ${key}=${value}`} onClick={() => addChip(key, value)}>
														<Highlighted text={value} re={marks} />
													</button></span>
												))}
											</td>
											<td className="rpcn-logs-instance">
												{row.instance ? (
													<button type="button" className="rpcn-logs-value" title={`Show only records of instance ${row.instance}`} onClick={() => addChip(INSTANCE_FIELD, row.instance)}>
														<Highlighted text={row.instance} re={marks} />
													</button>
												) : null}
											</td>
										</tr>
										{open ? (
											<tr className="rpcn-logs-detail">
												<td colSpan={4}><RecordDetail row={row} post={post} collapse={() => toggleExpanded(row.id)} /></td>
											</tr>
										) : null}
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
