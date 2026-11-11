// The Pipeline Logs tab (tickets 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, AD-24): a webview view in its own container in the bottom
// panel, next to Output. It shows one pipeline at a time, named in the view's description and the
// webview's header ("<pipeline> · <cluster>"); Show logs on another pipeline (the Cloud view's
// `LogSource`) switches to it, and the first one is no longer read.
//
// What it reads is the range of the time-range menu (ticket 6.3, board 5): by default the records of
// the last 15 minutes and then new ones live (the reader's tail); Live (from now on); Since the last
// deploy (the pipeline's `update_time`, read fresh when chosen), then live; or a bounded range (the
// last hour, 24 hours, 7 days, a custom From–To) read from its start to its end (the reader's range),
// after which Live is off. Choosing another range stops the earlier read. Live can be turned off
// (reading stops, the rows stay) and on again (it goes on after the newest shown record, or, when
// the newest were dropped, starts the default range again). **Load older records** reads the window
// of the range's length that ends at the oldest shown record, further back while a window has none
// of the pipeline's records, and stops at the log's first offset ("No older records").
//
// Reading happens only while the tab is visible: hiding or closing it stops every read, and showing
// it again resumes where the tail stopped (its positions), or reads an unfinished range again. The
// pipeline's records are those keyed by its id (`isPipelineRecord`); each is shaped and masked by
// `toLogRow` with the source's mask. At most `cap` rows (5,000) are kept: a read forward drops the
// oldest (they are "left out", and Load older reads them back); Load older at the cap drops the
// newest and pauses Live. The webview posts `ready` whenever it loads (it is not retained while
// hidden) and gets the whole state (`show`); then `append`, `prepend`, `status` and `state`. Requests
// go out only on the user's action (Show logs, a range, Load older, Live, the menu's retention, the
// filter) and while the tab follows.
//
// Ticket 6.4 (board 4): the filter (levels, a search, field chips; `filter.ts`) is applied here as the
// records are read, so only matching rows are kept and the cap counts matches. Every record of the
// pipeline read is counted once per level (matching or not; by its offset, so a window read again is
// not counted twice), for the level chips and "N of M records match". A filter change reads the
// range again (a live range whose Live is off is read up to now, and Live stays off); the filter stays
// when the range changes and is cleared by Show logs. Show records around this one reads the 5 minutes
// before and after a row (a custom range), the filter cleared; Copy JSON copies a row's JSON.
//
// Ticket 6.5 (board 2): Show logs from an Error (a deploy's, an update's or a start's notification)
// shows the default range with the ERROR records highlighted. **Show logs around the error** first
// searches the log back from now, a window of an hour at a time, up to 24 hours or the log's first
// offset, for the pipeline's newest ERROR-level record (the level as the chips match it, on the host),
// then reads the 5 minutes before and after it (a custom range, every level), that record scrolled to
// and marked; with none found it says "No ERROR record in the last 24 hours" and reads the last hour.
// The search is a read like any other: it runs only while the tab is visible (hidden, it stops, and
// it runs again once the tab is shown), and another range or pipeline replaces it.
//
// Ticket 6.6 (board 6): the states that fill the list area (`panelState`; the toolbar stays). A pipeline
// whose cluster has no log access is shown in **No log access** (nothing is read). A read that fails is
// told apart by AD-24's kinds: a refused sign-in is **Sign-in refused**, a refused read **Not allowed**;
// neither is tried again by itself (Retry does). Anything else is **Connection lost**: tried again after
// 5 s, then 10, 20, 30 and 60 s, and every 60 s after that, only while the tab is visible (hidden, the
// timer stops; shown again, the wait starts again); Retry now tries at once. The rows already shown stay,
// and a tail goes on from its positions (no row twice); the state goes once a read delivers. **Set up
// log access again…** and **Use another user…** run the source's `setUpAccess` (6.2's flow for its
// cluster) and, once stored, read the same range again; cancelled, the state stays. **No records**: a
// range read to its end with none of the pipeline's records, or only records of levels the filter hides
// (Show every level, Last 24 hours). **Reading**: a bounded range or Load older being read, with the
// count so far and **Stop reading** (the rows read stay, the read ends, Live off).
//
// Ticket 6.7 (board 5): the records-per-time strip of a bounded range (and Since the last deploy; not
// the two live ones). Every record of the pipeline counted (as for the level chips, including those left
// out for the cap) is counted per minute of its timestamp (`SlotCounter`), and the strip in the state is
// slotted from those for the span read: the range, extended back by each window Load older reads (so the
// slots grow when the span does). A bar's click (`slotChosen`) reads its slot as a custom range, the
// filter kept; the strip is then slotted for that range.
//
// Ticket 6.8 (board 3): **Export…** saves the rows kept at the click (those the list shows, after the
// filter, at most the cap; oldest first) as JSON lines (`export.ts`), at a place picked in the save
// dialog (`<pipeline>-<yyyymmdd-hhmm>.jsonl` in the first workspace folder by default). The rows are
// already masked; rows that arrive while the dialog is open are not added, and nothing is read again.
// Then "Exported N records to <file name>." with Open (and how many were left out for the cap), or
// "Could not export the records: <reason>" (masked). The dialog and the messages go through `ui`.
//
// Bug 52 (epic 6 retrospective): `revoke` stops the shown pipeline's reading: No log access when its
// cluster's access was forgotten or removed (also found at a sign-in: the source's `hasAccess` is read
// before each reader is made), or the Stopped state with a reason (the service account disconnected or
// changed; the rows stay). `remask` shapes the kept rows again from their records when a new secret is
// learned (a log access password, a `license_org`), so the rows and an export after it are masked. A
// failed Load older says the panel's own words; the cluster's text goes to the output channel only.

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	filterActive, isLiveRange, localMinute, LOG_LEVELS, MAX_LOG_ROWS, MINUTE_MS, NO_FILTER, NO_PANEL_STATE, panelStateTexts, parseLogsWebviewMessage, RANGE_LABELS,
	RETRY_DELAYS_MS, retryDelayMs, type LogFilter, type LogRow, type LogsHostMessage, type LogsPanelState, type LogsRange, type LogStrip, type LogsViewState,
	type RangeChoice,
} from '../../shared/logsProtocol';
import { isLogReadError, LOGS_TOPIC, type LogPositions, type LogReader, type LogRecord } from '../logs/logReader';
import { isPipelineRecord, licenseOrgOf, maskOrgs, toLogRow } from '../logs/records';
import { atLogStart, mergeOlder, olderWindowMs, rangeFor, RECENT_MS, retentionText, stripSpan } from '../logs/history';
import { compileFilter, Counter, levelOf, matches, sameFilter, SlotCounter, type CompiledFilter } from '../logs/filter';
import { EXPORT_FAILED_PREFIX, exportedMessage, exportFileName, exportText } from '../logs/export';
import { webviewHtml } from '../graphPanel/html';

export const LOGS_VIEW_ID = 'redpandaConnect.pipelineLogs';
/** The default range's look back (ticket 6.2's first read). */
export const LOGS_WINDOW_MS = RECENT_MS;
/** How many of the posted messages `posted` keeps (test seam). */
const MAX_POSTED = 200;

export const NO_PIPELINE_STATUS = 'Use Show logs on a pipeline in the Cloud view.';
export const READING_STATUS = 'Reading the last 15 minutes…';
export const RESUMING_STATUS = 'Reading…';
export const FOLLOWING_STATUS = 'Following new records.';
export const WAITING_STATUS = 'Waiting for new records…';
export const LIVE_OFF_STATUS = 'Live is off.';
/** Stop reading (ticket 6.6) ended a bounded read early. */
export function stoppedReadingStatus(what: string, count: number): string {
	return `Stopped reading ${what}: ${count.toLocaleString('en-US')} ${count === 1 ? 'record' : 'records'} read. ${LIVE_OFF_STATUS}`;
}
/** Load older dropped the newest rows for the cap: Live paused. */
export function livePausedStatus(cap: number): string {
	return `Live is paused: the newest records were dropped to keep at most ${cap.toLocaleString('en-US')}. Turn Live on to read the last 15 minutes again.`;
}
export const OLDER_FAILED_PREFIX = 'Could not load older records: ';
/** Show records around this one: this long before and after the record. */
export const AROUND_MS = 5 * MINUTE_MS;
/** With a filter on, one Load older searches back at most this far for a match. */
export const OLDER_SEARCH_MS = 24 * 60 * MINUTE_MS;
/** One Load older with a filter on found no match within `OLDER_SEARCH_MS`. */
export function noMatchesBackText(time: number): string {
	return `No matches back to ${localMinute(time)}; Load older to search further`;
}

/** Around the error: how far back the newest ERROR record is searched for. */
export const ERROR_SEARCH_MS = 24 * 60 * MINUTE_MS;
/** Around the error: the window read at a time, newest first. */
export const ERROR_SEARCH_WINDOW_MS = 60 * MINUTE_MS;
export const SEARCHING_ERROR_STATUS = 'Looking for the newest ERROR record in the last 24 hours…';
export const NO_ERROR_NOTE = 'No ERROR record in the last 24 hours';
/** Around the error: the record found is not among those shown. */
export function focusNotShownText(time: number): string {
	return `The ERROR record of ${localMinute(time)} could not be shown.`;
}

/** Export…'s action after the save: opens the file. */
export const OPEN_EXPORT_ACTION = 'Open';

/** What Export… (ticket 6.8) asks and says: the save dialog and the messages (the tests replace it). */
export interface LogsExportUi {
	readonly save: (options: vscode.SaveDialogOptions) => Thenable<vscode.Uri | undefined>;
	readonly info: (message: string, ...actions: string[]) => Thenable<string | undefined>;
	readonly error: (message: string) => Thenable<unknown>;
}

/** What Export… did: nothing shown (ignored), the dialog cancelled, the file written, or the write failed. */
export type LogsExportResult =
	| { readonly kind: 'nothing' }
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'exported'; readonly uri: vscode.Uri; readonly count: number; readonly message: string }
	| { readonly kind: 'failed'; readonly message: string };

/** How an entry point opens the log (ticket 6.5). */
export interface LogsShowOptions {
	/** The ERROR records highlighted (an Error notification's Show logs). */
	readonly highlightErrors?: boolean;
	/** Show logs around the error: the 5 minutes around the newest ERROR record of the last 24 hours (ERROR records highlighted). */
	readonly aroundError?: boolean;
}

/** What Show logs hands the panel: one pipeline, the way to read its cluster's logs, the mask. */
export interface LogSource {
	/** "<pipeline> · <cluster>". */
	readonly title: string;
	readonly pipelineId: string;
	/** A new reader for one reading session (closed when the session ends). */
	readonly reader: () => LogReader;
	/** Every text shown or logged passes it (the Cloud view's mask). */
	readonly mask: (text: string) => string;
	/**
	 * Bug 52: a reader's error text passes it before it is logged (else `mask`): also the log access
	 * passwords under 4 characters, by substring.
	 */
	readonly maskError?: (text: string) => string;
	/** Bug 52: the values masked in a row only where a whole value equals one (log access passwords under 4 characters). */
	readonly exact?: () => readonly string[];
	/** Bug 52: the cluster whose log access it reads with (Forget log access stops it). */
	readonly clusterId?: string;
	/**
	 * Bug 52: whether the cluster has log access now (read at each sign-in): `false` once it was forgotten,
	 * removed in another window or cleared by a disconnect; the tab then shows No log access.
	 */
	readonly hasAccess?: () => boolean;
	/** The pipeline's last deploy as the Cloud view last read it (the menu's label), when known. */
	readonly deployedAt?: number;
	/**
	 * Reads the pipeline's last deploy (`update_time`) now (Since the last deploy); `undefined` when
	 * it cannot be (the pipeline gone, a failed read): the source has said so then.
	 */
	readonly lastDeploy?: () => Promise<number | undefined>;
	/** Ticket 6.6: the names the states say (unmasked; the panel masks them). */
	readonly pipelineName?: string;
	readonly clusterName?: string;
	/** The Redpanda user the log is read as; absent with `noAccess`. */
	readonly username?: string;
	/** The cluster has no log access set: nothing is read (No log access). */
	readonly noAccess?: boolean;
	/**
	 * 6.2's Set up log access for the pipeline's cluster: the source to read with once the access is
	 * stored; `undefined` when it was cancelled or failed (the flow has said so).
	 */
	readonly setUpAccess?: () => Promise<LogSource | undefined>;
}

export interface LogsPanelOptions {
	readonly extensionUri: vscode.Uri;
	readonly log: (line: string) => void;
}

/** Around the error: the newest ERROR record found so far (its row's id and time, its place). */
interface ErrorCandidate {
	readonly id: string;
	readonly time: number;
	readonly partition: number;
	readonly offset: number;
}

/** A kept row, its record's timestamp (where Load older reads back from) and the record (bug 52: shaped again when a new secret is learned). */
interface Kept {
	readonly row: LogRow;
	readonly ts: number;
	readonly record: LogRecord;
}

/** A read in progress: the tail (following) or a bounded range. */
interface Session {
	readonly abort: AbortController;
	readonly kind: 'tail' | 'range';
}

/** "the last 24 hours", "since the last deploy", "2026-11-04 09:00 – 2026-11-05 18:00". */
function rangeText(range: LogsRange): string {
	switch (range.kind) {
		case 'live':
			return 'new records';
		case 'recent':
			return 'the last 15 minutes';
		case 'hour':
			return 'the last hour';
		case 'day':
			return 'the last 24 hours';
		case 'week':
			return 'the last 7 days';
		case 'deploy':
			return `since the last deploy (${localMinute(range.from)})`;
		case 'custom':
			return `${localMinute(range.from)} – ${localMinute(range.to ?? range.from)}`;
	}
}

const recordsText = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'record' : 'records'}`;
const NO_FILTER_COMPILED = compileFilter(NO_FILTER)!;

export class LogsPanel implements vscode.WebviewViewProvider, vscode.Disposable {
	/** The most rows kept (the test seam lowers it). */
	cap = MAX_LOG_ROWS;
	/** How far back the default range goes, and the shortest Load older window (the test seam may change it). */
	windowMs = LOGS_WINDOW_MS;
	/** Around the error's search window (the test seam may change it). */
	errorWindowMs = ERROR_SEARCH_WINDOW_MS;
	/** Ticket 6.6: the waits before each try after a lost connection, the last one repeated (test seam). */
	retryDelaysMs: readonly number[] = RETRY_DELAYS_MS;
	/** Export…'s save dialog and messages (test seam). */
	ui: LogsExportUi = {
		save: (options) => vscode.window.showSaveDialog(options),
		info: (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
		error: (message) => vscode.window.showErrorMessage(message),
	};
	/** The last messages posted to the webview, in order (test seam). */
	readonly posted: LogsHostMessage[] = [];
	private view: vscode.WebviewView | undefined;
	private viewSubscriptions: vscode.Disposable[] = [];
	private source: LogSource | undefined;
	private kept: Kept[] = [];
	private keptIds = new Set<string>();
	/** Older records left out for the cap, right before the oldest shown. */
	private dropped = 0;
	/** The newest rows Load older dropped for the cap. */
	private newerDropped = 0;
	private status = NO_PIPELINE_STATUS;
	private range: LogsRange = { kind: 'recent', from: 0, to: null };
	private chosenAt = 0;
	/** Following new records is wanted (the Live toggle). */
	private live = true;
	/** A bounded range still to be read (it is read when the tab is visible). */
	private pendingRange = false;
	/** Around the error's search still to be made (it is made when the tab is visible). */
	private pendingAround = false;
	/** Ticket 6.5: the ERROR records highlighted, for the pipeline shown. */
	private highlightErrors = false;
	/** Ticket 6.5: the row to scroll to and mark, and the note above the records; both until the next range. */
	private focusId: string | null = null;
	/** The marked row's time (the status names it when the row cannot be shown). */
	private focusTime = 0;
	private note: string | null = null;
	/** The range's read has ended. */
	private done = false;
	/** Where a tail goes on: after the newest record read. */
	private positions: LogPositions | undefined;
	private older: LogsViewState['older'] = 'more';
	/** Why the last Load older failed; kept until the next action. */
	private olderError: string | null = null;
	/** How far the last Load older searched without a match (a filter on); kept until the next action. */
	private olderNote: string | null = null;
	/** Records were left out for the cap at some point in this range: Load older reads back from the oldest shown. */
	private leftOutEver = false;
	/** Bumped on every choice of a range or pipeline, so a slow Since the last deploy gives way to a later choice. */
	private choices = 0;
	private retention: string | null = null;
	private deployedAt: number | null = null;
	private session: Session | undefined;
	private olderSession: AbortController | undefined;
	/** Stop reading for the Load older in progress. */
	private olderStop: (() => void) | undefined;
	private retentionSession: AbortController | undefined;
	/** The filter (ticket 6.4) and its compiled search. */
	private filter: LogFilter = NO_FILTER;
	private compiled: CompiledFilter = NO_FILTER_COMPILED;
	/** Every record of the pipeline read in the range, per level, and those matching. */
	private counter = new Counter();
	/** The offsets counted on each partition (read contiguously), so a record read again is not counted twice. */
	private counted = new Map<number, { lo: number; hi: number }>();
	/** The oldest record of the pipeline read (its timestamp): where Load older goes on when nothing was left out. */
	private oldestTs: number | undefined;
	/** Ticket 6.7: every record counted, per minute of its timestamp (the strip's bars). */
	private slots = new SlotCounter();
	/** Ticket 6.7: the start of the oldest window Load older read (the strip extends back to it). */
	private olderFrom: number | undefined;
	/** Ticket 6.7: the newest record counted (its timestamp): where Since the last deploy's strip ends. */
	private newestTs: number | undefined;
	/** A live range read again with Live off is read up to this time (the filter changed). */
	private readUntil: number | undefined;
	/** Bumped on every Show logs and range, so an older read's records are not kept. */
	private generation = 0;
	/** Ticket 6.6: the failure state (no access, sign-in refused, not allowed, connection lost), else none. */
	private failure: LogsPanelState = NO_PANEL_STATE;
	/** The tries after a lost connection so far (the next wait), reset once a read delivers. */
	private retryAttempt = 0;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	/** Stop reading ended the range's read early: it is not "No records". */
	private stoppedShort = false;
	/** The pipeline's records the current Load older has read. */
	private olderCount = 0;
	/** The newest record time (any key) the range's read has reached: a retry after a lost connection goes on from it. */
	private rangeReached: number | undefined;
	/** Set up log access runs for this panel's source (a second request is ignored). */
	private settingUp = false;
	private ready = false;
	/** Every `license_org` seen in this window: masked in every later record and every text shown. */
	private readonly orgs = new Set<string>();
	private readonly changed = new vscode.EventEmitter<void>();
	/** Fires when the rows, the status or the reading change (test seam). */
	readonly onDidChange = this.changed.event;

	constructor(private readonly options: LogsPanelOptions) {}

	register(): vscode.Disposable[] {
		return [vscode.window.registerWebviewViewProvider(LOGS_VIEW_ID, this)];
	}

	/** The shown pipeline's "<pipeline> · <cluster>", masked; `undefined` before the first Show logs. */
	get title(): string | undefined {
		return this.source ? this.mask(this.source, this.source.title) : undefined;
	}

	/** `text` as shown: the source's mask and every `license_org` seen. */
	private mask(source: LogSource, text: string): string {
		return source.mask(maskOrgs(text, this.orgs));
	}

	/** A reader's error text as logged (bug 52: `maskError`, which also masks short log access passwords). */
	private maskError(source: LogSource, text: string): string {
		const orgsMasked = maskOrgs(text, this.orgs);
		return source.maskError ? source.maskError(orgsMasked) : source.mask(orgsMasked);
	}

	/** The row `record` is shown as, with the source's masks and every `license_org` seen. */
	private shape(source: LogSource, record: LogRecord): LogRow {
		return toLogRow(record, source.mask, this.orgs, source.exact?.() ?? []);
	}

	get statusText(): string {
		return this.status;
	}

	/** Whether a reader is reading now (the tail or a range; not Load older). */
	get reading(): boolean {
		return this.session !== undefined;
	}

	/** Whether Load older is reading now. */
	get readingOlder(): boolean {
		return this.olderSession !== undefined;
	}

	get visible(): boolean {
		return this.view?.visible === true;
	}

	/** The kept rows, oldest first. */
	rows(): readonly LogRow[] {
		return this.kept.map((k) => k.row);
	}

	get droppedCount(): number {
		return this.dropped;
	}

	/** The range, Live, Load older and the menu's texts, as the webview gets them. */
	get viewState(): LogsViewState {
		return {
			range: this.range,
			live: this.live,
			done: this.done,
			older: this.older,
			olderError: this.olderError,
			olderNote: this.olderNote,
			newerDropped: this.newerDropped,
			retention: this.retention,
			deployedAt: this.deployedAt,
			olderBefore: this.olderAnchor(),
			filter: this.filter,
			counts: this.counter.counts,
			highlightErrors: this.highlightErrors,
			focusId: this.focusId,
			note: this.note,
			panelState: this.panelState,
			stoppedShort: this.stoppedShort,
			settingUp: this.settingUp,
			strip: this.strip,
		};
	}

	/**
	 * Ticket 6.7: the records-per-time strip, or `null`: no pipeline, the live ranges, no log access, a
	 * refused sign-in or read, a lost connection before any record was read, or around the error's search
	 * still to be made.
	 */
	get strip(): LogStrip | null {
		const failed = this.failure.kind;
		if (!this.source || failed === 'noAccess' || failed === 'signIn' || failed === 'notAllowed' || this.pendingAround
			|| (failed === 'connectionLost' && this.counter.counts.total === 0)) {
			return null;
		}
		const span = stripSpan(this.range, this.chosenAt, this.olderFrom, this.readUntil, this.newestTs);
		return span ? this.slots.strip(span.from, span.end) : null;
	}

	/**
	 * Ticket 6.6: the state of the list area: a failure; else a bounded range or Load older being read;
	 * else No records (a range read to its end with no row shown and none of the pipeline's records, or
	 * only records of levels the filter hides, nothing else filtering); else none.
	 */
	get panelState(): LogsPanelState {
		if (this.failure.kind !== 'none') {
			return this.failure;
		}
		const source = this.source;
		if (!source) {
			return NO_PANEL_STATE;
		}
		if (this.session?.kind === 'range' && this.pendingRange) {
			return { kind: 'reading', what: `Reading ${rangeText(this.range)}…`, count: this.counter.counts.total };
		}
		if (this.olderSession) {
			return { kind: 'reading', what: 'Loading older records…', count: this.olderCount };
		}
		if (this.done && !this.stoppedShort && this.kept.length === 0) {
			const { total, matched } = this.counter.counts;
			const hidden = LOG_LEVELS.filter((l) => !this.filter.levels.includes(l) && this.counter.counts.levels[l] > 0);
			const onlyLevels = this.filter.text === '' && this.filter.fields.length === 0;
			if (total === 0 || (matched === 0 && onlyLevels && hidden.length > 0)) {
				return {
					kind: 'noRecords',
					pipeline: this.mask(source, source.pipelineName ?? source.title),
					range: this.mask(source, rangeText(this.range)),
					hiddenLevels: total === 0 ? [] : hidden,
				};
			}
		}
		return NO_PANEL_STATE;
	}

	/** The cluster's name as the states say it. */
	private clusterOf(source: LogSource): string {
		return this.mask(source, source.clusterName ?? source.title);
	}

	/**
	 * Where Load older reads back from: the oldest kept row when matching ones were left out for the cap
	 * at any time in this range (they are read back first), else the oldest record of the pipeline read,
	 * else the range's start.
	 */
	private olderAnchor(): number {
		if (this.leftOutEver && this.kept[0]) {
			return this.kept[0].ts;
		}
		return this.oldestTs ?? this.kept[0]?.ts ?? this.range.from;
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.viewSubscriptions.forEach((s) => s.dispose());
		this.view = view;
		this.ready = false;
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, 'dist')] };
		view.webview.html = webviewHtml(view.webview, this.options.extensionUri, 'logs', 'Pipeline Logs');
		this.viewSubscriptions = [
			view.webview.onDidReceiveMessage((raw: unknown) => {
				const m = parseLogsWebviewMessage(raw);
				switch (m?.type) {
					case 'ready':
						this.ready = true;
						this.postShow();
						break;
					case 'rangeChosen':
						void this.chooseRange(m.range);
						break;
					case 'olderRequested':
						void this.loadOlder();
						break;
					case 'liveToggled':
						void this.setLive(m.live);
						break;
					case 'retentionRequested':
						this.requestRetention();
						break;
					case 'filterChanged':
						this.setFilter(m.filter);
						break;
					case 'aroundRequested':
						this.around(m.id);
						break;
					case 'copyRequested':
						void this.copyJson(m.id);
						break;
					case 'stopReading':
						this.stopReading();
						break;
					case 'retryNow':
						this.retry();
						break;
					case 'setUpAccess':
					case 'useAnotherUser':
						void this.setUpAccess();
						break;
					case 'showEveryLevel':
						this.setFilter({ ...this.filter, levels: LOG_LEVELS });
						break;
					case 'last24h':
						void this.chooseRange({ kind: 'day' });
						break;
					case 'slotChosen':
						void this.chooseSlot(m.from, m.to);
						break;
					case 'exportRequested':
						void this.exportShown();
						break;
				}
			}),
			view.onDidChangeVisibility(() => {
				if (view.visible) {
					this.start();
				} else {
					// Not retained while hidden: the page loads again (and posts `ready`) when shown.
					this.ready = false;
					this.stopAll();
				}
			}),
			view.onDidDispose(() => {
				if (this.view === view) {
					this.view = undefined;
					this.ready = false;
					this.viewSubscriptions.forEach((s) => s.dispose());
					this.viewSubscriptions = [];
					this.stopAll();
				}
			}),
		];
		this.updateDescription();
		if (view.visible) {
			this.start();
		}
	}

	/**
	 * Show logs: `source`'s pipeline replaces the shown one, on the default range (with
	 * `highlightErrors`, its ERROR records highlighted), or, with `aroundError`, around its newest ERROR
	 * record of the last 24 hours; the tab opens and reading starts.
	 */
	async show(source: LogSource, options: LogsShowOptions = {}): Promise<void> {
		this.choices++;
		this.stopAll();
		this.stopRetention();
		this.source = source;
		this.filter = NO_FILTER;
		this.compiled = NO_FILTER_COMPILED;
		this.retention = null;
		this.deployedAt = source.deployedAt ?? null;
		this.highlightErrors = options.highlightErrors === true || options.aroundError === true;
		const now = Date.now();
		if (options.aroundError) {
			// Searched first (when the tab is visible); the menu says the last 24 hours meanwhile.
			this.reset({ kind: 'day', from: now - ERROR_SEARCH_MS, to: now }, now);
			this.pendingRange = false;
			this.pendingAround = true;
			if (this.failure.kind === 'none') {
				this.status = SEARCHING_ERROR_STATUS;
			}
			this.options.log(this.mask(source, `Pipeline logs: showing ${source.title} around its newest ERROR record.`));
		} else {
			this.reset(rangeFor({ kind: 'recent' }, now, undefined, this.windowMs)!, now);
			this.options.log(this.mask(source, `Pipeline logs: showing ${source.title} from ${new Date(this.range.from).toISOString()}.`));
		}
		this.updateDescription();
		this.postShow();
		this.changed.fire();
		await vscode.commands.executeCommand(`${LOGS_VIEW_ID}.focus`);
		this.start();
	}

	/**
	 * A range of the menu: the earlier read stops and this one starts (when the tab is visible).
	 * Since the last deploy reads the pipeline's `update_time` first; when it cannot be read, nothing
	 * changes. A custom range whose To is before its From, or whose From is in the future, is refused.
	 */
	async chooseRange(choice: RangeChoice): Promise<boolean> {
		const source = this.source;
		// Bug 52: Stopped (the account went) reads nothing until Show logs.
		if (!source || this.failure.kind === 'stopped') {
			return false;
		}
		const chosen = ++this.choices;
		let deployTime: number | undefined;
		if (choice.kind === 'deploy') {
			deployTime = await source.lastDeploy?.();
			// Another range or pipeline was chosen meanwhile: it wins.
			if (source !== this.source || chosen !== this.choices || deployTime === undefined) {
				return false;
			}
			this.deployedAt = deployTime;
		}
		const now = Date.now();
		const range = rangeFor(choice, now, deployTime, this.windowMs);
		if (!range) {
			return false;
		}
		this.stopAll();
		this.reset(range, now);
		this.options.log(this.mask(source, `Pipeline logs: reading ${source.title}, ${rangeText(range)}.`));
		this.postShow();
		this.changed.fire();
		this.start();
		return true;
	}

	/**
	 * A bar of the strip (ticket 6.7): its slot's times as the webview drew them (`to` inclusive), read as a
	 * custom range, the filter kept (the strip is then that range's). `false` without a strip, for times
	 * not inside the strip's span or not in order, or when the range is refused.
	 */
	async chooseSlot(from: number, to: number): Promise<boolean> {
		const strip = this.strip;
		if (!strip || !Number.isFinite(from) || !Number.isFinite(to) || from >= to || from < strip.from || to > strip.end) {
			return false;
		}
		return this.chooseRange({ kind: 'custom', from, to });
	}

	/**
	 * The filter (ticket 6.4): kept, and the range read again with it (unless it keeps the same rows).
	 * `false` for a search that is not a valid regular expression (nothing changes).
	 */
	setFilter(filter: LogFilter): boolean {
		const compiled = compileFilter(filter);
		if (!compiled) {
			return false;
		}
		if (this.failure.kind === 'stopped') {
			// Bug 52: Stopped (the account went): the filter stays as it was, nothing is read.
			this.postState();
			return false;
		}
		const same = sameFilter(filter, this.filter);
		this.filter = filter;
		this.compiled = compiled;
		const source = this.source;
		if (same || !source) {
			this.postState();
			return true;
		}
		const live = this.live;
		this.choices++;
		this.stopAll();
		this.reset(this.range, this.chosenAt);
		if (isLiveRange(this.range.kind) && !live) {
			// Live stays off: the range is read up to now.
			this.live = false;
			this.pendingRange = true;
			this.readUntil = Date.now();
		} else if (!isLiveRange(this.range.kind)) {
			// A bounded range whose Live was turned on follows again once read.
			this.live = live;
		}
		if (this.failure.kind === 'none') {
			this.status = this.readingStatus();
		}
		this.options.log(this.mask(source, `Pipeline logs: reading ${source.title} again, ${rangeText(this.range)}, with ${filterActive(filter) ? 'a filter' : 'no filter'}.`));
		this.postShow();
		this.changed.fire();
		this.start();
		return true;
	}

	/**
	 * Show records around this one: the 5 minutes before and after the row's time (a custom range,
	 * Live off), the filter cleared. `false` when the row is not shown.
	 */
	around(id: string): boolean {
		const source = this.source;
		const kept = this.kept.find((k) => k.row.id === id);
		if (!source || !kept || this.failure.kind === 'stopped') {
			return false;
		}
		const now = Date.now();
		const t = kept.row.time;
		this.choices++;
		this.filter = NO_FILTER;
		this.compiled = NO_FILTER_COMPILED;
		this.stopAll();
		this.reset({ kind: 'custom', from: Math.min(t - AROUND_MS, now), to: t + AROUND_MS }, now);
		this.options.log(this.mask(source, `Pipeline logs: reading ${source.title} around ${new Date(t).toISOString()}.`));
		this.postShow();
		this.changed.fire();
		this.start();
		return true;
	}

	/** Copy JSON (when the webview cannot write the clipboard): the row's JSON as shown, else its text. */
	async copyJson(id: string): Promise<boolean> {
		const kept = this.kept.find((k) => k.row.id === id);
		if (!kept) {
			return false;
		}
		await vscode.env.clipboard.writeText(kept.row.json ?? kept.row.message);
		return true;
	}

	/**
	 * Export… (ticket 6.8): the rows kept now (shown, oldest first; a snapshot, so rows arriving while
	 * the dialog is open are not added) saved as JSON lines where the save dialog says, then the message
	 * with Open. Ignored when no row is shown; Escape in the dialog writes nothing. Every text is masked.
	 */
	async exportShown(): Promise<LogsExportResult> {
		const source = this.source;
		if (!source || this.kept.length === 0) {
			return { kind: 'nothing' };
		}
		const failed = (err: unknown): LogsExportResult => {
			const reason = this.mask(source, err instanceof Error ? err.message : String(err));
			const message = `${EXPORT_FAILED_PREFIX}${reason}`;
			this.options.log(`Pipeline logs: exporting the records of ${this.mask(source, source.title)} failed: ${reason}`);
			void this.ui.error(message);
			return { kind: 'failed', message };
		};
		let uri: vscode.Uri | undefined;
		let count: number;
		let message: string;
		try {
			count = this.kept.length;
			const text = exportText(this.kept.map((k) => k.row));
			const leftOut = this.dropped;
			const newerDropped = this.newerDropped;
			const cap = this.cap;
			const name = exportFileName(this.mask(source, source.pipelineName ?? source.pipelineId), Date.now());
			const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
			const defaultUri = folder ? vscode.Uri.joinPath(folder, name) : vscode.Uri.file(path.join(os.homedir(), name));
			uri = await this.ui.save({ defaultUri, filters: { 'JSON lines': ['jsonl'] }, saveLabel: 'Export', title: 'Export the shown records' });
			if (!uri) {
				return { kind: 'cancelled' };
			}
			const fileName = this.mask(source, path.posix.basename(uri.path));
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
			this.options.log(this.mask(source, `Pipeline logs: exported ${recordsText(count)} of ${source.title} to ${uri.scheme === 'file' ? uri.fsPath : uri.toString()}.`));
			message = exportedMessage(count, fileName, leftOut, newerDropped, cap);
		} catch (err) {
			return failed(err);
		}
		try {
			const action = await this.ui.info(message, OPEN_EXPORT_ACTION);
			if (action === OPEN_EXPORT_ACTION) {
				await vscode.commands.executeCommand('vscode.open', uri);
			}
		} catch (err) {
			// The file is written: the failure to open it is said, the export stands.
			failed(err);
		}
		return { kind: 'exported', uri, count, message };
	}

	/** Every row and count read so far dropped. */
	private clearRead(): void {
		this.kept = [];
		this.keptIds = new Set();
		this.dropped = 0;
		this.newerDropped = 0;
		this.counter = new Counter();
		this.counted = new Map();
		this.oldestTs = undefined;
		this.slots = new SlotCounter();
		this.olderFrom = undefined;
		this.newestTs = undefined;
		this.leftOutEver = false;
		this.rangeReached = undefined;
	}

	/** Every row, count and reading of the last range dropped; `range` is the one to read now. */
	private reset(range: LogsRange, now: number): void {
		this.generation++;
		this.clearRead();
		this.readUntil = undefined;
		this.positions = undefined;
		this.range = range;
		this.chosenAt = now;
		this.live = isLiveRange(range.kind);
		this.pendingRange = !this.live;
		this.pendingAround = false;
		this.focusId = null;
		this.note = null;
		this.done = false;
		this.older = 'more';
		this.olderError = null;
		this.olderNote = null;
		this.stoppedShort = false;
		this.cancelRetry();
		this.retryAttempt = 0;
		const source = this.source;
		this.failure = source?.noAccess ? { kind: 'noAccess', cluster: this.clusterOf(source), topic: LOGS_TOPIC } : NO_PANEL_STATE;
		this.status = this.failure.kind === 'none' ? this.readingStatus() : panelStateTexts(this.failure)!.title;
	}

	private readingStatus(): string {
		return this.range.kind === 'recent' ? READING_STATUS : this.range.kind === 'live' ? WAITING_STATUS : `Reading ${rangeText(this.range)}…`;
	}

	/**
	 * The Live toggle. Off: the tail stops, the rows stay. On: the tail goes on after the newest
	 * record read (a bounded range still being read follows once it is read); when the newest rows were
	 * dropped, or nothing was read, the default range is read again.
	 */
	async setLive(on: boolean): Promise<void> {
		// Bug 52: Stopped (the account went): Live does nothing.
		if (!this.source || on === this.live || this.failure.kind === 'stopped') {
			return;
		}
		this.olderError = null;
		this.olderNote = null;
		if (!on) {
			this.live = false;
			if (this.session?.kind === 'tail') {
				this.stop();
			}
			if (this.failure.kind === 'connectionLost' && !this.pendingRange && !this.pendingAround) {
				// Only the tail was being tried again: nothing is to be read now.
				this.cancelRetry();
				this.retryAttempt = 0;
				this.failure = NO_PANEL_STATE;
			}
			this.setStatus(LIVE_OFF_STATUS);
			this.postState();
			return;
		}
		if (!this.pendingAround && (this.pendingRange || (this.positions && this.newerDropped === 0))) {
			this.live = true;
			this.postState();
			this.start();
			return;
		}
		await this.chooseRange({ kind: 'recent' });
	}

	private updateDescription(): void {
		if (this.view) {
			this.view.description = this.title;
		}
	}

	private post(message: LogsHostMessage): void {
		this.posted.push(message);
		if (this.posted.length > MAX_POSTED) {
			this.posted.splice(0, this.posted.length - MAX_POSTED);
		}
		if (this.view && this.ready) {
			void this.view.webview.postMessage(message);
		}
	}

	private postShow(): void {
		this.post({ type: 'show', title: this.title ?? null, rows: this.rows().slice(), dropped: this.dropped, cap: this.cap, status: this.status, state: this.viewState });
	}

	private postState(): void {
		this.post({ type: 'state', state: this.viewState });
		this.changed.fire();
	}

	private setStatus(raw: string): void {
		const status = this.source ? this.mask(this.source, raw) : raw;
		if (status !== this.status) {
			this.status = status;
			this.post({ type: 'status', status });
			this.changed.fire();
		}
	}

	/** Starts what the range needs, when there is a pipeline, the tab is visible and nothing reads. */
	private start(): void {
		if (!this.source || this.session || !this.view?.visible) {
			return;
		}
		switch (this.failure.kind) {
			case 'noAccess':
			case 'signIn':
			case 'notAllowed':
			case 'stopped':
				// Never tried again by itself (Retry, or a new access, does; Stopped: only another range or Show logs).
				return;
			case 'connectionLost':
				if (!this.retryTimer && this.failure.retryAt === null && this.wantsRead()) {
					this.scheduleRetry();
				}
				return;
		}
		this.read(this.source);
	}

	/** Whether the range has something to read (a search, a bounded range, or Live on). */
	private wantsRead(): boolean {
		return this.pendingAround || this.pendingRange || this.live;
	}

	private read(source: LogSource): void {
		if (this.pendingAround) {
			void this.findError(source);
		} else if (this.pendingRange) {
			this.readRange(source);
		} else if (this.live) {
			this.tail(source);
		}
	}

	/**
	 * Retry (a refused sign-in or read) and Retry now (a lost connection), and the retry timer: reads
	 * again at once, when the tab is visible and nothing reads. A lost connection's state stays ("Trying
	 * again…") until a read delivers.
	 */
	retry(): boolean {
		this.cancelRetry();
		const source = this.source;
		if (!source || source.noAccess || this.session || !this.view?.visible || this.failure.kind === 'none' || this.failure.kind === 'noAccess' || this.failure.kind === 'stopped') {
			return false;
		}
		if (this.failure.kind === 'connectionLost') {
			this.failure = { ...this.failure, retryAt: null };
			this.setStatus(panelStateTexts(this.failure)!.title);
		} else {
			this.failure = NO_PANEL_STATE;
			this.setStatus(this.readingStatus());
		}
		this.options.log(this.mask(source, `Pipeline logs: trying to read ${source.title} again.`));
		this.postState();
		this.read(source);
		return true;
	}

	/** A lost connection: the next try after its wait (5, 10, 20, 30, then 60 s), only while the tab is visible. */
	private scheduleRetry(): void {
		this.cancelRetry();
		if (this.failure.kind !== 'connectionLost' || !this.view?.visible) {
			return;
		}
		const ms = retryDelayMs(this.retryAttempt, this.retryDelaysMs);
		this.failure = { ...this.failure, retryInS: Math.round(retryDelayMs(this.retryAttempt) / 1000), retryAt: Date.now() + ms };
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.retry();
		}, ms);
		this.postState();
	}

	/** The retry timer stopped; a lost connection then waits for the tab (its countdown gone). */
	private cancelRetry(): void {
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		if (this.failure.kind === 'connectionLost' && this.failure.retryAt !== null) {
			this.failure = { ...this.failure, retryAt: null };
		}
	}

	/** A read delivered: a lost connection's state goes and its tries start again from the first wait. */
	private recovered(source: LogSource): void {
		if (this.failure.kind !== 'connectionLost') {
			return;
		}
		this.cancelRetry();
		this.retryAttempt = 0;
		this.failure = NO_PANEL_STATE;
		this.options.log(this.mask(source, `Pipeline logs: reading ${source.title} again.`));
		this.postState();
	}

	/**
	 * Makes a reader for one session; a failure is the status line. Bug 52: the cluster's access is read
	 * at each sign-in; none now (forgotten, removed in another window, a disconnect) is No log access.
	 */
	private newReader(source: LogSource): LogReader | undefined {
		if (source.hasAccess && !source.hasAccess()) {
			this.revoke((s) => s === source);
			return undefined;
		}
		try {
			return source.reader();
		} catch (err) {
			this.failed(source, err);
			return undefined;
		}
	}

	/** Follows the end: from the tail's positions, else from the range's start. */
	private tail(source: LogSource): void {
		const abort = new AbortController();
		const generation = this.generation;
		const resuming = this.positions !== undefined;
		this.session = { abort, kind: 'tail' };
		this.setStatus(resuming ? RESUMING_STATUS : this.readingStatus());
		this.options.log(this.mask(source, `Pipeline logs: reading ${source.title}${resuming ? ' again where it stopped' : ''}.`));
		const reader = this.newReader(source);
		if (!reader) {
			this.session = undefined;
			return;
		}
		const current = () => !abort.signal.aborted && generation === this.generation;
		reader.tail(source.pipelineId, this.range.from, (records, next) => {
			if (!current()) {
				return;
			}
			this.positions = next;
			this.recovered(source);
			this.receive(source, records);
			this.setStatus(FOLLOWING_STATUS);
		}, abort.signal, this.positions).then(undefined, (err: unknown) => {
			if (current()) {
				this.failed(source, err);
			}
		}).finally(() => {
			// Ended (a failure included): its client is closed, so a retry's reader is the only one open.
			abort.abort();
			if (this.session?.abort === abort) {
				this.session = undefined;
				this.changed.fire();
			}
		});
		this.changed.fire();
	}

	/** Reads the bounded range from its start to its end; then Live is off (unless it was turned on meanwhile). */
	private readRange(source: LogSource): void {
		const abort = new AbortController();
		const generation = this.generation;
		const range = this.range;
		this.session = { abort, kind: 'range' };
		// A retry after a lost connection goes on from where the read had reached: the rows stay, and a
		// record read again is neither counted nor kept twice (`take`).
		const resumeAt = this.failure.kind === 'connectionLost' ? this.rangeReached : undefined;
		if (resumeAt === undefined && (this.kept.length > 0 || this.counter.counts.total > 0)) {
			// An earlier read of this range was stopped (the tab hidden): read it again from its start.
			this.clearRead();
			this.older = 'more';
			this.olderError = null;
			this.olderNote = null;
			this.postShow();
		}
		if (this.failure.kind === 'none') {
			this.setStatus(this.readingStatus());
		}
		this.options.log(this.mask(source, `Pipeline logs: reading ${source.title}, ${rangeText(range)}.`));
		const reader = this.newReader(source);
		if (!reader) {
			this.session = undefined;
			this.postState();
			return;
		}
		// Reading (ticket 6.6): the state shows the count so far and Stop reading.
		this.postState();
		const current = () => !abort.signal.aborted && generation === this.generation;
		reader.range(source.pipelineId, resumeAt ?? range.from, range.to ?? this.readUntil ?? this.chosenAt, (records) => {
			if (current()) {
				for (const r of records) {
					this.rangeReached = this.rangeReached === undefined ? r.timestamp : Math.max(this.rangeReached, r.timestamp);
				}
				this.recovered(source);
				this.receive(source, records);
			}
		}, abort.signal).then((end) => {
			if (!current()) {
				return;
			}
			this.recovered(source);
			this.pendingRange = false;
			this.done = true;
			this.positions = end.next;
			const stalled = end.stalled?.length ? ` Partition ${end.stalled.join(', ')} kept answering no records, so the read stopped short there.` : '';
			const { total, matched } = this.counter.counts;
			const read = filterActive(this.filter)
				? `Read ${recordsText(total)} of ${rangeText(range)}; ${matched.toLocaleString('en-US')} ${matched === 1 ? 'matches' : 'match'}.${stalled}`
				: `Read ${recordsText(total)} of ${rangeText(range)}.${stalled}`;
			// Around the error: the record found should be among those kept (`receive` keeps it); else say so.
			const lost = this.focusId !== null && !this.keptIds.has(this.focusId) ? ` ${focusNotShownText(this.focusTime)}` : '';
			this.setStatus(`${this.live ? read : `${read} ${LIVE_OFF_STATUS}`}${lost}`);
			this.postState();
		}, (err: unknown) => {
			if (current()) {
				this.failed(source, err);
			}
		}).finally(() => {
			const mine = this.session?.abort === abort;
			if (mine) {
				this.session = undefined;
			}
			// Closes the reader's client.
			abort.abort();
			if (mine) {
				if (generation === this.generation) {
					// The reading state ends.
					this.postState();
				}
				this.changed.fire();
				if (generation === this.generation && !this.pendingRange && this.live) {
					// Live was turned on while the range was read: follow from its end.
					this.start();
				}
			}
		});
		this.changed.fire();
	}

	/**
	 * Load older records: the window of the range's length ending at the oldest shown record; when a
	 * window has none of the pipeline's records, the next one ends at the record just before it (so a
	 * silence is jumped over), down to the log's first offset. Refused while a bounded range is still
	 * being read (the forward read and the cap would cut what is prepended).
	 */
	async loadOlder(): Promise<void> {
		const source = this.source;
		if (!source || source.noAccess || this.older !== 'more' || !this.view?.visible || this.pendingRange || this.pendingAround || this.failure.kind === 'stopped') {
			return;
		}
		if (source.hasAccess && !source.hasAccess()) {
			this.revoke((s) => s === source);
			return;
		}
		this.olderError = null;
		this.olderNote = null;
		const abort = new AbortController();
		const generation = this.generation;
		const mine = () => generation === this.generation && source === this.source;
		const current = () => !abort.signal.aborted && mine();
		/** Stop reading (ticket 6.6): the window being read is kept, then the walk ends. */
		let stopped = false;
		let got: LogRecord[] = [];
		const keepStopped = () => {
			// Ticket 6.7: the strip extends only over what was read of the window (from its oldest record).
			for (const r of got) {
				if (isPipelineRecord(r, source.pipelineId)) {
					this.olderFrom = Math.min(this.olderFrom ?? r.timestamp, r.timestamp);
				}
			}
			const { matching } = this.take(source, got);
			if (matching.length > 0) {
				this.prepend(matching);
			}
		};
		const filtered = filterActive(this.filter);
		this.olderSession = abort;
		this.olderStop = () => {
			stopped = true;
			abort.abort();
		};
		this.olderCount = 0;
		this.older = 'reading';
		this.postState();
		const length = olderWindowMs(this.range, this.chosenAt, this.windowMs);
		let to = this.olderAnchor();
		const searchFrom = to;
		this.options.log(this.mask(source, `Pipeline logs: reading ${source.title} before ${new Date(to).toISOString()}.`));
		let older: LogsViewState['older'] = 'more';
		try {
			const reader = source.reader();
			const first = await reader.logStart(abort.signal);
			while (current()) {
				const from = to - length;
				got = [];
				const end = await reader.range(source.pipelineId, from, to, (records) => {
					got.push(...records);
					const counted = records.filter((r) => isPipelineRecord(r, source.pipelineId)).length;
					if (counted > 0 && current()) {
						this.olderCount += counted;
						this.postState();
					}
				}, abort.signal);
				if (stopped && mine()) {
					keepStopped();
					break;
				}
				if (!current()) {
					return;
				}
				// Ticket 6.7: the window is read: the strip extends back to it.
				this.olderFrom = Math.min(this.olderFrom ?? from, from);
				const { matching, counted } = this.take(source, got);
				const reachedStart = atLogStart(end.start, first);
				// A match ends the walk back; without a filter, so does any of the pipeline's records.
				if (matching.length > 0 || (counted > 0 && !filtered)) {
					if (matching.length > 0) {
						this.prepend(matching);
					}
					older = reachedStart ? 'none' : 'more';
					break;
				}
				if (reachedStart) {
					older = 'none';
					break;
				}
				if (counted > 0) {
					// Records but no match: shown in the counts.
					this.postState();
				}
				if (filtered && searchFrom - from >= OLDER_SEARCH_MS) {
					// One click searches back at most 24 hours with a filter on.
					this.olderNote = noMatchesBackText(from);
					break;
				}
				// None of the pipeline's records here: the next window ends at the record just before this one.
				const before = await reader.timeBefore(end.start, abort.signal);
				if (!current()) {
					return;
				}
				if (before === undefined) {
					older = 'none';
					break;
				}
				to = Math.min(before, from);
			}
		} catch (err) {
			if (stopped && mine()) {
				keepStopped();
			} else if (current()) {
				const message = this.maskError(source, isLogReadError(err) || err instanceof Error ? err.message : String(err));
				this.options.log(`Pipeline logs: loading older records of ${this.mask(source, source.title)} failed: ${message}`);
				// Shown in the Load older row (the status line is the tail's), until the next action. Bug 52: the
				// panel's own words for the failure (6.6's titles); the cluster's text goes to the output channel only.
				this.olderError = `${OLDER_FAILED_PREFIX}${panelStateTexts(this.failureOf(source, err))!.title}.`;
			}
		} finally {
			if (this.olderSession === abort) {
				this.olderSession = undefined;
				this.olderStop = undefined;
				if (generation === this.generation) {
					this.older = current() ? older : 'more';
				}
			}
			// Closes the reader's client.
			abort.abort();
			if (generation === this.generation && source === this.source) {
				this.postState();
			}
		}
	}

	/**
	 * Around the error (ticket 6.5): the log read back from now, `errorWindowMs` at a time, until a window
	 * holds an ERROR record of the pipeline, 24 hours are read or the log's first offset is reached; then
	 * the 5 minutes around the newest such record (it is marked), else the last hour with a note. Stopped
	 * (the tab hidden), it is made again when the tab is shown.
	 */
	private async findError(source: LogSource): Promise<void> {
		const abort = new AbortController();
		const generation = this.generation;
		const current = () => !abort.signal.aborted && generation === this.generation && source === this.source;
		this.session = { abort, kind: 'range' };
		this.setStatus(SEARCHING_ERROR_STATUS);
		this.changed.fire();
		const reader = this.newReader(source);
		if (!reader) {
			this.session = undefined;
			return;
		}
		const now = Date.now();
		let outcome: { readonly found: { readonly id: string; readonly time: number } | undefined } | undefined;
		try {
			const first = await reader.logStart(abort.signal);
			let to = now;
			let found: ErrorCandidate | undefined;
			while (current() && !found && now - to < ERROR_SEARCH_MS) {
				const from = Math.max(to - this.errorWindowMs, now - ERROR_SEARCH_MS);
				// Only the newest ERROR candidate of the window is kept, not its records.
				let candidate: ErrorCandidate | undefined;
				const end = await reader.range(source.pipelineId, from, to, (records) => {
					candidate = this.newestError(source, records, candidate);
				}, abort.signal);
				if (!current()) {
					break;
				}
				found = candidate;
				if (atLogStart(end.start, first)) {
					break;
				}
				to = from;
			}
			if (current()) {
				outcome = { found };
				this.recovered(source);
			}
		} catch (err) {
			if (current()) {
				this.failed(source, err);
			}
		} finally {
			if (this.session?.abort === abort) {
				this.session = undefined;
			}
			// Closes the reader's client.
			abort.abort();
			this.changed.fire();
		}
		if (!outcome || generation !== this.generation || source !== this.source) {
			return;
		}
		const at = Date.now();
		const { found } = outcome;
		if (found) {
			this.reset({ kind: 'custom', from: Math.min(found.time - AROUND_MS, at), to: found.time + AROUND_MS }, at);
			this.focusId = found.id;
			this.focusTime = found.time;
			this.options.log(this.mask(source, `Pipeline logs: the newest ERROR record of ${source.title} is at ${new Date(found.time).toISOString()}; reading around it.`));
		} else {
			this.reset(rangeFor({ kind: 'hour' }, at)!, at);
			this.note = NO_ERROR_NOTE;
			this.options.log(this.mask(source, `Pipeline logs: no ERROR record of ${source.title} in the last 24 hours; reading the last hour.`));
		}
		this.postShow();
		this.changed.fire();
		this.start();
	}

	/**
	 * The newest ERROR-level record of the pipeline in `records` or `found` (the candidate so far):
	 * later by its row's time; at the same time, a later offset on the same partition, else the first found.
	 */
	private newestError(source: LogSource, records: readonly LogRecord[], found: ErrorCandidate | undefined): ErrorCandidate | undefined {
		this.noteOrgs(records);
		for (const r of records) {
			if (!isPipelineRecord(r, source.pipelineId)) {
				continue;
			}
			const row = this.shape(source, r);
			if (levelOf(row) !== 'error') {
				continue;
			}
			if (!found || row.time > found.time || (row.time === found.time && r.partition === found.partition && r.offset > found.offset)) {
				found = { id: row.id, time: row.time, partition: r.partition, offset: r.offset };
			}
		}
		return found;
	}

	/**
	 * Every `license_org` of `records` noted, so a record before the one that carries it is masked too;
	 * bug 52: a new one masks the rows already kept again.
	 */
	private noteOrgs(records: readonly LogRecord[]): void {
		let learned = false;
		for (const r of records) {
			const org = licenseOrgOf(r);
			if (org && !this.orgs.has(org)) {
				this.orgs.add(org);
				learned = true;
			}
		}
		if (learned) {
			this.remask();
		}
	}

	/** The menu opened: the topic's retention, read once per pipeline shown. */
	requestRetention(): void {
		const source = this.source;
		if (!source || source.noAccess || this.retention !== null || this.retentionSession || !this.view?.visible) {
			return;
		}
		const abort = new AbortController();
		this.retentionSession = abort;
		const reader = this.newReader(source);
		if (!reader) {
			this.retentionSession = undefined;
			return;
		}
		void reader.retentionMs(abort.signal).then((ms) => {
			if (source === this.source && !abort.signal.aborted) {
				this.retention = retentionText(ms);
				this.postState();
			}
		}, () => undefined).finally(() => {
			if (this.retentionSession === abort) {
				this.retentionSession = undefined;
			}
			abort.abort();
		});
	}

	private stopRetention(): void {
		const s = this.retentionSession;
		this.retentionSession = undefined;
		s?.abort();
	}

	/**
	 * A read failed (ticket 6.6): its state by AD-24's kind. A refused sign-in or read waits for Retry or
	 * a new access; anything else is a lost connection, tried again after its wait while the tab is
	 * visible. The reason goes to the output channel only (masked), not into the panel.
	 */
	private failed(source: LogSource, err: unknown): void {
		const message = this.maskError(source, isLogReadError(err) || err instanceof Error ? err.message : String(err));
		const kind = isLogReadError(err) ? err.kind : 'connection';
		if (kind === 'connection') {
			this.retryAttempt++;
		} else {
			this.cancelRetry();
			this.retryAttempt = 0;
		}
		this.failure = this.failureOf(source, err);
		this.options.log(`Pipeline logs: reading ${this.mask(source, source.title)} stopped: ${message}${kind === 'connection' ? ` (try ${this.retryAttempt})` : ''}`);
		this.setStatus(panelStateTexts(this.failure)!.title);
		if (this.failure.kind === 'connectionLost') {
			// Posts the state with its countdown (not while the tab is hidden).
			this.scheduleRetry();
		}
		if (!this.retryTimer) {
			this.postState();
		}
	}

	/** The state a failed read is (AD-24's kinds): Sign-in refused, Not allowed, else Connection lost. */
	private failureOf(source: LogSource, err: unknown): LogsPanelState {
		const kind = isLogReadError(err) ? err.kind : 'connection';
		const user = this.mask(source, source.username ?? 'The user');
		if (kind === 'signIn') {
			return { kind: 'signIn', user, cluster: this.clusterOf(source) };
		}
		if (kind === 'notAllowed') {
			return { kind: 'notAllowed', user, topic: LOGS_TOPIC };
		}
		return { kind: 'connectionLost', cluster: this.clusterOf(source), live: this.live && !this.pendingRange && !this.pendingAround, retryInS: 0, retryAt: null };
	}

	/**
	 * Bug 52: the shown pipeline's reading stops when `which` matches its source: with no `reason`, the
	 * tab shows No log access (the access was forgotten, removed in another window, or is gone at a sign-in;
	 * its Set up log access… reads the same range again); with `reason` (the service account disconnected
	 * or changed), the Stopped state says it and the rows stay. Nothing is read with that source again.
	 * `false` when no shown source matches (or it is already in that state).
	 */
	revoke(which: (source: LogSource) => boolean, reason?: string): boolean {
		const source = this.source;
		if (!source || !which(source) || (reason === undefined && source.noAccess) || (reason !== undefined && this.failure.kind === 'stopped')) {
			return false;
		}
		const around = this.pendingAround;
		this.choices++;
		this.stopAll();
		const next: LogSource = { ...source, noAccess: true, username: undefined };
		this.source = next;
		if (reason === undefined) {
			this.reset(this.range, this.chosenAt);
			if (around) {
				// Set up log access… searches again.
				this.pendingRange = false;
				this.pendingAround = true;
			}
			this.options.log(this.mask(next, `Pipeline logs: stopped reading ${next.title}: ${next.clusterName ?? 'its cluster'} has no log access now.`));
		} else {
			// The rows stay; whatever was still being read is dropped.
			this.generation++;
			this.cancelRetry();
			this.retryAttempt = 0;
			this.live = false;
			this.pendingRange = false;
			this.pendingAround = false;
			this.done = true;
			this.failure = { kind: 'stopped', reason: this.mask(next, reason) };
			this.status = panelStateTexts(this.failure)!.title;
			this.options.log(this.mask(next, `Pipeline logs: stopped reading ${next.title}: ${reason}`));
		}
		this.updateDescription();
		this.postShow();
		this.changed.fire();
		return true;
	}

	/**
	 * Bug 52: a new secret was learned (a log access password, a `license_org`): every kept row is shaped
	 * again from its record with the masks as they are now, and the webview gets them again (as an export
	 * after it does).
	 */
	remask(): void {
		const source = this.source;
		if (!source || this.kept.length === 0) {
			return;
		}
		// The filter applies to the rows as now shown: one that no longer matches goes, as a filter change
		// would drop it (nothing is read again; a record not kept is not read back).
		const next: Kept[] = [];
		for (const k of this.kept) {
			const row = this.shape(source, k.record);
			if (matches(row, this.compiled)) {
				next.push({ ...k, row });
			} else {
				this.keptIds.delete(row.id);
				this.counter.unmatch();
				this.slots.unmatch(k.ts);
			}
		}
		this.kept = next;
		this.postShow();
		this.changed.fire();
	}

	/**
	 * Stop reading (ticket 6.6): a bounded range's read ends where it is, its rows kept, Live off; Load
	 * older keeps the window it was reading and ends. `false` when neither reads.
	 */
	stopReading(): boolean {
		const source = this.source;
		if (!source) {
			return false;
		}
		if (this.olderStop) {
			this.olderStop();
			return true;
		}
		if (this.session?.kind !== 'range' || !this.pendingRange) {
			return false;
		}
		this.stop();
		this.pendingRange = false;
		this.done = true;
		this.stoppedShort = true;
		this.live = false;
		this.setStatus(stoppedReadingStatus(rangeText(this.range), this.counter.counts.total));
		this.postState();
		return true;
	}

	/**
	 * Set up log access…, Set up log access again… and Use another user… (ticket 6.6): 6.2's flow for the
	 * shown pipeline's cluster; once stored, the same range is read again with the new access (around the
	 * error: searched again). Cancelled or failed: the state stays. `false` then.
	 */
	async setUpAccess(): Promise<boolean> {
		const source = this.source;
		if (!source?.setUpAccess || this.settingUp) {
			return false;
		}
		this.settingUp = true;
		this.postState();
		let next: LogSource | undefined;
		try {
			next = await source.setUpAccess();
		} finally {
			this.settingUp = false;
			this.postState();
		}
		if (!next || source !== this.source) {
			return false;
		}
		const around = this.pendingAround;
		const live = this.live;
		this.choices++;
		this.stopAll();
		this.source = next;
		this.reset(this.range, this.chosenAt);
		if (around) {
			this.pendingRange = false;
			this.pendingAround = true;
			this.status = SEARCHING_ERROR_STATUS;
		} else if (isLiveRange(this.range.kind) && !live && this.failure.kind === 'none') {
			// Live stays off: the range is read up to now.
			this.live = false;
			this.pendingRange = true;
			this.readUntil = Date.now();
			this.status = this.readingStatus();
		}
		this.options.log(this.mask(next, `Pipeline logs: reading ${next.title} again with the new log access, ${rangeText(this.range)}.`));
		this.updateDescription();
		this.postShow();
		this.changed.fire();
		this.start();
		return true;
	}

	/** Stops the tail or the range read (Live off, the tab hidden or closed, another range or pipeline, the window closing). */
	private stop(): void {
		const session = this.session;
		if (session) {
			this.session = undefined;
			session.abort.abort();
			if (this.source) {
				this.options.log(this.mask(this.source, `Pipeline logs: stopped reading ${this.source.title}.`));
			}
			this.changed.fire();
		}
	}

	/** Stops every read: the tail or the range, Load older, the retention. */
	private stopAll(): void {
		this.stop();
		this.cancelRetry();
		const older = this.olderSession;
		if (older) {
			this.olderSession = undefined;
			this.olderStop = undefined;
			older.abort();
			this.older = 'more';
			this.postState();
		}
		this.stopRetention();
	}

	/**
	 * The pipeline's rows of `records`, oldest first: each counted once (`counted`: how many were new),
	 * and those matching the filter not yet kept (`matching`). Every org of the batch is noted first.
	 */
	private take(source: LogSource, records: readonly LogRecord[]): { readonly matching: Kept[]; readonly counted: number } {
		this.noteOrgs(records);
		const seen = new Set<string>();
		const matching: Kept[] = [];
		let counted = 0;
		const mine = records.filter((r) => isPipelineRecord(r, source.pipelineId))
			.map((r, i) => ({ r, i }))
			.sort((a, b) => a.r.timestamp - b.r.timestamp || a.i - b.i);
		// What was counted before this batch (a batch read back extends it only once it is counted).
		const before = new Map([...this.counted].map(([p, span]) => [p, { ...span }]));
		const countedIds = new Set<string>();
		for (const { r } of mine) {
			const row = this.shape(source, r);
			const keep = matches(row, this.compiled);
			const span = before.get(r.partition);
			if ((!span || r.offset < span.lo || r.offset > span.hi) && !countedIds.has(row.id)) {
				countedIds.add(row.id);
				this.counter.add(row, keep);
				this.slots.add(r.timestamp, levelOf(row), keep);
				counted++;
				this.oldestTs = this.oldestTs === undefined ? r.timestamp : Math.min(this.oldestTs, r.timestamp);
				this.newestTs = this.newestTs === undefined ? r.timestamp : Math.max(this.newestTs, r.timestamp);
			}
			const now = this.counted.get(r.partition);
			if (now) {
				now.lo = Math.min(now.lo, r.offset);
				now.hi = Math.max(now.hi, r.offset);
			} else {
				this.counted.set(r.partition, { lo: r.offset, hi: r.offset });
			}
			if (keep && !this.keptIds.has(row.id) && !seen.has(row.id)) {
				seen.add(row.id);
				matching.push({ row, ts: r.timestamp, record: r });
			}
		}
		return { matching, counted };
	}

	/** Newer records read forward: the matching ones appended; over the cap the oldest are left out. */
	private receive(source: LogSource, records: readonly LogRecord[]): void {
		const { matching: mine, counted } = this.take(source, records);
		if (mine.length === 0) {
			if (counted > 0) {
				this.postState();
			}
			return;
		}
		for (const k of mine) {
			this.kept.push(k);
			this.keptIds.add(k.row.id);
		}
		const over = this.kept.length - this.cap;
		let appended = mine;
		if (over > 0) {
			// Around the error: the oldest are left out only up to the marked row; past it the newest are dropped.
			const focusAt = this.focusId === null ? -1 : this.kept.findIndex((k) => k.row.id === this.focusId);
			const older = focusAt < 0 ? over : Math.min(over, focusAt);
			const newer = over - older;
			if (newer > 0) {
				for (const k of this.kept.splice(this.kept.length - newer, newer)) {
					this.keptIds.delete(k.row.id);
				}
				appended = mine.slice(0, mine.length - newer);
				this.newerDropped += newer;
			}
			if (older > 0) {
				for (const k of this.kept.splice(0, older)) {
					this.keptIds.delete(k.row.id);
				}
				this.dropped += older;
				this.leftOutEver = true;
			}
		}
		this.post({ type: 'append', rows: appended.slice(-this.cap).map((k) => k.row), dropped: this.dropped });
		if (counted > 0) {
			this.postState();
		} else {
			this.changed.fire();
		}
	}

	/** Older records (Load older): before the kept ones; over the cap the newest are dropped and Live pauses. */
	private prepend(older: readonly Kept[]): void {
		const merged = mergeOlder(older, this.kept, this.cap);
		if (merged.newerDropped > 0) {
			for (const k of this.kept.slice(this.kept.length - merged.newerDropped)) {
				this.keptIds.delete(k.row.id);
			}
		}
		const taken = older.slice(merged.leftOut);
		for (const k of taken) {
			this.keptIds.add(k.row.id);
		}
		this.kept = merged.rows;
		this.dropped = merged.leftOut;
		if (merged.leftOut > 0) {
			this.leftOutEver = true;
		}
		this.post({ type: 'prepend', rows: taken.map((k) => k.row), dropped: this.dropped });
		if (merged.newerDropped > 0) {
			this.newerDropped += merged.newerDropped;
			if (this.live) {
				this.live = false;
				if (this.session?.kind === 'tail') {
					this.stop();
				}
				this.setStatus(livePausedStatus(this.cap));
			}
		}
		this.changed.fire();
	}

	dispose(): void {
		this.stopAll();
		this.viewSubscriptions.forEach((s) => s.dispose());
		this.viewSubscriptions = [];
		this.changed.dispose();
	}
}
