// The Pipeline Logs tab (ticket 6.2, AD-24): a webview view in its own container in the bottom panel,
// next to Output. It shows one pipeline at a time, named in the view's description and the webview's
// header ("<pipeline> · <cluster>"); Show logs on another pipeline (the Cloud view's `LogSource`)
// switches to it, and the first one is no longer read. Reading starts at the records of the last
// 15 minutes and then follows new ones (the reader's tail), only while the tab is visible: hiding or
// closing it stops the reader, and showing it again resumes where the reader stopped (its positions).
// The pipeline's records are those keyed by its id (`isPipelineRecord`); each is shaped and masked by
// `toLogRow` with the source's mask. At most `cap` rows (5,000) are kept, the oldest dropped first,
// in the host and the webview alike. The webview posts `ready` whenever it loads (it is not retained
// while hidden) and gets the whole state (`show`); then `append` and `status`. Requests go out only
// after the user's Show logs and while the tab follows.

import * as vscode from 'vscode';
import { MAX_LOG_ROWS, type LogRow, type LogsHostMessage } from '../../shared/logsProtocol';
import { isLogReadError, type LogPositions, type LogReader, type LogRecord } from '../logs/logReader';
import { isPipelineRecord, licenseOrgOf, maskOrgs, toLogRow } from '../logs/records';
import { webviewHtml } from '../graphPanel/html';

export const LOGS_VIEW_ID = 'redpandaConnect.pipelineLogs';
/** The first read goes back this far (AD-24: history beyond it is ticket 6.3). */
export const LOGS_WINDOW_MS = 15 * 60_000;
/** How many of the posted messages `posted` keeps (test seam). */
const MAX_POSTED = 200;

export const NO_PIPELINE_STATUS = 'Use Show logs on a pipeline in the Cloud view.';
export const READING_STATUS = 'Reading the last 15 minutes…';
export const RESUMING_STATUS = 'Reading…';
export const FOLLOWING_STATUS = 'Following new records.';
export const STOPPED_PREFIX = 'Reading stopped: ';

/** What Show logs hands the panel: one pipeline, the way to read its cluster's logs, the mask. */
export interface LogSource {
	/** "<pipeline> · <cluster>". */
	readonly title: string;
	readonly pipelineId: string;
	/** A new reader for one reading session (closed when the session ends). */
	readonly reader: () => LogReader;
	/** Every text shown or logged passes it (the Cloud view's mask). */
	readonly mask: (text: string) => string;
}

export interface LogsPanelOptions {
	readonly extensionUri: vscode.Uri;
	readonly log: (line: string) => void;
}

export class LogsPanel implements vscode.WebviewViewProvider, vscode.Disposable {
	/** The most rows kept (the test seam lowers it). */
	cap = MAX_LOG_ROWS;
	/** How far back the first read goes (the test seam may change it). */
	windowMs = LOGS_WINDOW_MS;
	/** The last messages posted to the webview, in order (test seam). */
	readonly posted: LogsHostMessage[] = [];
	private view: vscode.WebviewView | undefined;
	private viewSubscriptions: vscode.Disposable[] = [];
	private source: LogSource | undefined;
	private kept: LogRow[] = [];
	private keptIds = new Set<string>();
	private dropped = 0;
	private status = NO_PIPELINE_STATUS;
	private fromTime = 0;
	private positions: LogPositions | undefined;
	private session: { readonly abort: AbortController } | undefined;
	/** Bumped on every Show logs, so an older session's records are not kept. */
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

	/** Whether a reader is reading now. */
	get reading(): boolean {
		return this.session !== undefined;
	}

	get visible(): boolean {
		return this.view?.visible === true;
	}

	/** The kept rows, oldest first. */
	rows(): readonly LogRow[] {
		return [...this.kept];
	}

	get droppedCount(): number {
		return this.dropped;
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.viewSubscriptions.forEach((s) => s.dispose());
		this.view = view;
		this.ready = false;
		view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, 'dist')] };
		view.webview.html = webviewHtml(view.webview, this.options.extensionUri, 'logs', 'Pipeline Logs');
		this.viewSubscriptions = [
			view.webview.onDidReceiveMessage((m: unknown) => {
				if (m !== null && typeof m === 'object' && (m as { type?: unknown }).type === 'ready') {
					this.ready = true;
					this.postShow();
				}
			}),
			view.onDidChangeVisibility(() => {
				if (view.visible) {
					this.start();
				} else {
					// Not retained while hidden: the page loads again (and posts `ready`) when shown.
					this.ready = false;
					this.stop();
				}
			}),
			view.onDidDispose(() => {
				if (this.view === view) {
					this.view = undefined;
					this.ready = false;
					this.viewSubscriptions.forEach((s) => s.dispose());
					this.viewSubscriptions = [];
					this.stop();
				}
			}),
		];
		this.updateDescription();
		if (view.visible) {
			this.start();
		}
	}

	/** Show logs: `source`'s pipeline replaces the shown one; the tab opens and reading starts. */
	async show(source: LogSource): Promise<void> {
		this.stop();
		this.generation++;
		this.source = source;
		this.kept = [];
		this.keptIds = new Set();
		this.dropped = 0;
		this.positions = undefined;
		this.fromTime = Date.now() - this.windowMs;
		this.status = READING_STATUS;
		this.options.log(this.mask(source, `Pipeline logs: showing ${source.title} from ${new Date(this.fromTime).toISOString()}.`));
		this.updateDescription();
		this.postShow();
		this.changed.fire();
		await vscode.commands.executeCommand(`${LOGS_VIEW_ID}.focus`);
		this.start();
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
		this.post({ type: 'show', title: this.title ?? null, rows: [...this.kept], dropped: this.dropped, cap: this.cap, status: this.status });
	}

	private setStatus(raw: string): void {
		const status = this.source ? this.mask(this.source, raw) : raw;
		if (status !== this.status) {
			this.status = status;
			this.post({ type: 'status', status });
			this.changed.fire();
		}
	}

	/** Starts reading the shown pipeline, when there is one, the tab is visible and nothing reads. */
	private start(): void {
		const source = this.source;
		if (!source || this.session || !this.view?.visible) {
			return;
		}
		const abort = new AbortController();
		const generation = this.generation;
		this.session = { abort };
		const resuming = this.positions !== undefined;
		this.setStatus(resuming ? RESUMING_STATUS : READING_STATUS);
		this.options.log(this.mask(source, `Pipeline logs: reading ${source.title}${resuming ? ' again where it stopped' : ''}.`));
		let reader: LogReader;
		try {
			reader = source.reader();
		} catch (err) {
			this.session = undefined;
			this.failed(source, err);
			return;
		}
		const current = () => !abort.signal.aborted && generation === this.generation;
		reader.tail(source.pipelineId, this.fromTime, (records, next) => {
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

	private failed(source: LogSource, err: unknown): void {
		const message = this.mask(source, isLogReadError(err) || err instanceof Error ? err.message : String(err));
		this.options.log(`Pipeline logs: reading ${this.mask(source, source.title)} stopped: ${message}`);
		this.setStatus(`${STOPPED_PREFIX}${message}`);
	}

	/** Stops the reader (the tab hidden or closed, another pipeline, the window closing). */
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

	private receive(source: LogSource, records: readonly LogRecord[]): void {
		// Every org of the batch first, so a record before the one that carries it is masked too.
		for (const r of records) {
			const org = licenseOrgOf(r);
			if (org) {
				this.orgs.add(org);
			}
		}
		const mine = records.filter((r) => isPipelineRecord(r, source.pipelineId))
			.map((r, i) => ({ r, i }))
			.sort((a, b) => a.r.timestamp - b.r.timestamp || a.i - b.i)
			.map(({ r }) => toLogRow(r, source.mask, this.orgs))
			.filter((row) => !this.keptIds.has(row.id));
		if (mine.length === 0) {
			return;
		}
		for (const row of mine) {
			this.kept.push(row);
			this.keptIds.add(row.id);
		}
		const over = this.kept.length - this.cap;
		if (over > 0) {
			for (const row of this.kept.splice(0, over)) {
				this.keptIds.delete(row.id);
			}
			this.dropped += over;
		}
		this.post({ type: 'append', rows: mine.slice(-this.cap), dropped: this.dropped });
		this.changed.fire();
	}

	dispose(): void {
		this.stop();
		this.viewSubscriptions.forEach((s) => s.dispose());
		this.viewSubscriptions = [];
		this.changed.dispose();
	}
}
