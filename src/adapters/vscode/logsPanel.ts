// The Pipeline Logs tab (tickets 6.2, 6.3, AD-24): a webview view in its own container in the bottom
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
// go out only on the user's action (Show logs, a range, Load older, Live, the menu's retention) and
// while the tab follows.

import * as vscode from 'vscode';
import { isLiveRange, localMinute, MAX_LOG_ROWS, parseLogsWebviewMessage, RANGE_LABELS, type LogRow, type LogsHostMessage, type LogsRange, type LogsViewState, type RangeChoice } from '../../shared/logsProtocol';
import { isLogReadError, type LogPositions, type LogReader, type LogRecord } from '../logs/logReader';
import { isPipelineRecord, licenseOrgOf, maskOrgs, toLogRow } from '../logs/records';
import { atLogStart, mergeOlder, olderWindowMs, rangeFor, RECENT_MS, retentionText } from '../logs/history';
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
export const STOPPED_PREFIX = 'Reading stopped: ';
export const LIVE_OFF_STATUS = 'Live is off.';
/** Load older dropped the newest rows for the cap: Live paused. */
export function livePausedStatus(cap: number): string {
	return `Live is paused: the newest records were dropped to keep at most ${cap.toLocaleString('en-US')}. Turn Live on to read the last 15 minutes again.`;
}
export const OLDER_FAILED_PREFIX = 'Could not load older records: ';

/** What Show logs hands the panel: one pipeline, the way to read its cluster's logs, the mask. */
export interface LogSource {
	/** "<pipeline> · <cluster>". */
	readonly title: string;
	readonly pipelineId: string;
	/** A new reader for one reading session (closed when the session ends). */
	readonly reader: () => LogReader;
	/** Every text shown or logged passes it (the Cloud view's mask). */
	readonly mask: (text: string) => string;
	/** The pipeline's last deploy as the Cloud view last read it (the menu's label), when known. */
	readonly deployedAt?: number;
	/**
	 * Reads the pipeline's last deploy (`update_time`) now (Since the last deploy); `undefined` when
	 * it cannot be (the pipeline gone, a failed read): the source has said so then.
	 */
	readonly lastDeploy?: () => Promise<number | undefined>;
}

export interface LogsPanelOptions {
	readonly extensionUri: vscode.Uri;
	readonly log: (line: string) => void;
}

/** A kept row and its record's timestamp (where Load older reads back from). */
interface Kept {
	readonly row: LogRow;
	readonly ts: number;
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

export class LogsPanel implements vscode.WebviewViewProvider, vscode.Disposable {
	/** The most rows kept (the test seam lowers it). */
	cap = MAX_LOG_ROWS;
	/** How far back the default range goes, and the shortest Load older window (the test seam may change it). */
	windowMs = LOGS_WINDOW_MS;
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
	/** The range's read has ended. */
	private done = false;
	/** Where a tail goes on: after the newest record read. */
	private positions: LogPositions | undefined;
	private older: LogsViewState['older'] = 'more';
	/** Why the last Load older failed; kept until the next action. */
	private olderError: string | null = null;
	/** Bumped on every choice of a range or pipeline, so a slow Since the last deploy gives way to a later choice. */
	private choices = 0;
	private retention: string | null = null;
	private deployedAt: number | null = null;
	private session: Session | undefined;
	private olderSession: AbortController | undefined;
	private retentionSession: AbortController | undefined;
	/** Bumped on every Show logs and range, so an older read's records are not kept. */
	private generation = 0;
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
			newerDropped: this.newerDropped,
			retention: this.retention,
			deployedAt: this.deployedAt,
		};
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

	/** Show logs: `source`'s pipeline replaces the shown one, on the default range; the tab opens and reading starts. */
	async show(source: LogSource): Promise<void> {
		this.choices++;
		this.stopAll();
		this.stopRetention();
		this.source = source;
		this.retention = null;
		this.deployedAt = source.deployedAt ?? null;
		const now = Date.now();
		this.reset(rangeFor({ kind: 'recent' }, now, undefined, this.windowMs)!, now);
		this.options.log(this.mask(source, `Pipeline logs: showing ${source.title} from ${new Date(this.range.from).toISOString()}.`));
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
		if (!source) {
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

	/** Every row, count and reading of the last range dropped; `range` is the one to read now. */
	private reset(range: LogsRange, now: number): void {
		this.generation++;
		this.kept = [];
		this.keptIds = new Set();
		this.dropped = 0;
		this.newerDropped = 0;
		this.positions = undefined;
		this.range = range;
		this.chosenAt = now;
		this.live = isLiveRange(range.kind);
		this.pendingRange = !this.live;
		this.done = false;
		this.older = 'more';
		this.olderError = null;
		this.status = this.readingStatus();
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
		if (!this.source || on === this.live) {
			return;
		}
		this.olderError = null;
		if (!on) {
			this.live = false;
			if (this.session?.kind === 'tail') {
				this.stop();
			}
			this.setStatus(LIVE_OFF_STATUS);
			this.postState();
			return;
		}
		if (this.pendingRange || (this.positions && this.newerDropped === 0)) {
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
		if (this.pendingRange) {
			this.readRange(this.source);
		} else if (this.live) {
			this.tail(this.source);
		}
	}

	/** Makes a reader for one session; a failure is the status line. */
	private newReader(source: LogSource): LogReader | undefined {
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
			this.receive(source, records);
			this.setStatus(FOLLOWING_STATUS);
		}, abort.signal, this.positions).then(undefined, (err: unknown) => {
			if (current()) {
				this.failed(source, err);
			}
		}).finally(() => {
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
		if (this.kept.length > 0) {
			// An earlier read of this range was stopped (the tab hidden): read it again from its start.
			this.kept = [];
			this.keptIds = new Set();
			this.dropped = 0;
			this.newerDropped = 0;
			this.older = 'more';
			this.olderError = null;
			this.postShow();
		}
		this.setStatus(this.readingStatus());
		this.options.log(this.mask(source, `Pipeline logs: reading ${source.title}, ${rangeText(range)}.`));
		const reader = this.newReader(source);
		if (!reader) {
			this.session = undefined;
			return;
		}
		const current = () => !abort.signal.aborted && generation === this.generation;
		reader.range(source.pipelineId, range.from, range.to ?? this.chosenAt, (records) => {
			if (current()) {
				this.receive(source, records);
			}
		}, abort.signal).then((end) => {
			if (!current()) {
				return;
			}
			this.pendingRange = false;
			this.done = true;
			this.positions = end.next;
			const stalled = end.stalled?.length ? ` Partition ${end.stalled.join(', ')} kept answering no records, so the read stopped short there.` : '';
			const read = `Read ${recordsText(this.kept.length + this.dropped)} of ${rangeText(range)}.${stalled}`;
			this.setStatus(this.live ? read : `${read} ${LIVE_OFF_STATUS}`);
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
		if (!source || this.older !== 'more' || !this.view?.visible || this.pendingRange) {
			return;
		}
		this.olderError = null;
		const abort = new AbortController();
		const generation = this.generation;
		const current = () => !abort.signal.aborted && generation === this.generation && source === this.source;
		this.olderSession = abort;
		this.older = 'reading';
		this.postState();
		const length = olderWindowMs(this.range, this.chosenAt, this.windowMs);
		let to = this.kept[0]?.ts ?? this.range.from;
		this.options.log(this.mask(source, `Pipeline logs: reading ${source.title} before ${new Date(to).toISOString()}.`));
		let older: LogsViewState['older'] = 'more';
		try {
			const reader = source.reader();
			const first = await reader.logStart(abort.signal);
			while (current()) {
				const from = to - length;
				const got: LogRecord[] = [];
				const end = await reader.range(source.pipelineId, from, to, (records) => got.push(...records), abort.signal);
				if (!current()) {
					return;
				}
				const rows = this.toKept(source, got);
				const reachedStart = atLogStart(end.start, first);
				if (rows.length > 0) {
					this.prepend(rows);
					older = reachedStart ? 'none' : 'more';
					break;
				}
				if (reachedStart) {
					older = 'none';
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
			if (current()) {
				const message = this.mask(source, isLogReadError(err) || err instanceof Error ? err.message : String(err));
				this.options.log(`Pipeline logs: loading older records of ${this.mask(source, source.title)} failed: ${message}`);
				// Shown in the Load older row (the status line is the tail's), until the next action.
				this.olderError = `${OLDER_FAILED_PREFIX}${message}`;
			}
		} finally {
			if (this.olderSession === abort) {
				this.olderSession = undefined;
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

	/** The menu opened: the topic's retention, read once per pipeline shown. */
	requestRetention(): void {
		const source = this.source;
		if (!source || this.retention !== null || this.retentionSession || !this.view?.visible) {
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

	private failed(source: LogSource, err: unknown): void {
		const message = this.mask(source, isLogReadError(err) || err instanceof Error ? err.message : String(err));
		this.options.log(`Pipeline logs: reading ${this.mask(source, source.title)} stopped: ${message}`);
		this.setStatus(`${STOPPED_PREFIX}${message}`);
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
		const older = this.olderSession;
		if (older) {
			this.olderSession = undefined;
			older.abort();
			this.older = 'more';
			this.postState();
		}
		this.stopRetention();
	}

	/** The pipeline's rows of `records`, oldest first, not yet kept; every org of the batch is noted first. */
	private toKept(source: LogSource, records: readonly LogRecord[]): Kept[] {
		// Every org of the batch first, so a record before the one that carries it is masked too.
		for (const r of records) {
			const org = licenseOrgOf(r);
			if (org) {
				this.orgs.add(org);
			}
		}
		const seen = new Set<string>();
		return records.filter((r) => isPipelineRecord(r, source.pipelineId))
			.map((r, i) => ({ r, i }))
			.sort((a, b) => a.r.timestamp - b.r.timestamp || a.i - b.i)
			.map(({ r }) => ({ row: toLogRow(r, source.mask, this.orgs), ts: r.timestamp }))
			.filter((k) => !this.keptIds.has(k.row.id) && !seen.has(k.row.id) && (seen.add(k.row.id), true));
	}

	/** Newer records read forward: appended; over the cap the oldest are left out. */
	private receive(source: LogSource, records: readonly LogRecord[]): void {
		const mine = this.toKept(source, records);
		if (mine.length === 0) {
			return;
		}
		for (const k of mine) {
			this.kept.push(k);
			this.keptIds.add(k.row.id);
		}
		const over = this.kept.length - this.cap;
		if (over > 0) {
			for (const k of this.kept.splice(0, over)) {
				this.keptIds.delete(k.row.id);
			}
			this.dropped += over;
		}
		this.post({ type: 'append', rows: mine.slice(-this.cap).map((k) => k.row), dropped: this.dropped });
		this.changed.fire();
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
