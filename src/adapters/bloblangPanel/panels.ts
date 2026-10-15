// The Bloblang test panel registry (ticket 4.2, AD-1, AD-5, AD-21): one WebviewPanel per mapping,
// keyed by the file's `uri.toString()` plus the processor's path, titled `Bloblang: <label, else
// path>`. It opens beside the YAML without taking focus (entry 10 settles the group); a second Test
// mapping on the same processor reveals it. The webview posts `ready` (again whenever it is
// recreated, since `retainContextWhenHidden` is off) and gets a `snapshot` of the processor, and
// a new snapshot whenever an edit changes the processor's kind or Bloblang. Each `run {content, meta}`
// runs the processor's current Bloblang, read from the open document then, on the content and its
// metadata through the AD-21 test run (4.7), and the panel gets the `result`. Runs are single flight
// per panel: an input that arrives during a run waits (only the latest one), and only the latest
// input's result is posted. Untitled files never run. The snapshot carries the binary's status and
// the samples (4.9).
// Ticket 4.8: each result's file positions come from 4.3's position map on the text the run used
// (`locate`); `goToLine` shows the YAML in its editor group with the cursor at that line's start,
// revealed in the centre; and while a panel's latest result is `failed` with a file line, that line
// ends with the shared end-of-line hint (`hint.ts`), which follows the mapping line through edits
// and clears on any other result, when the line leaves the processor, and when the panel closes.
// Ticket 4.15: every open panel gets `binary {status}` each time the binary state changes (AD-9),
// and the no-binary state's Install guide, Set path and Retry run the binary warning's own actions
// (`BinaryActions`, the graph's). A run that races a binary loss still gets the no-binary `error`.
// Ticket 4.9 (AD-22): the snapshot carries the mapping's saved samples and the selected one, from the
// config's samples file (`sampleStore.ts`), linked by the processor's label at open, else its path.
// `sampleAdded`, `sampleRenamed`, `sampleSwitched` and `inputEdited` change the file and post nothing
// back (the webview already shows the change). `sampleDeleted` asks first (a modal, `confirmDelete`),
// and on Delete the panel gets `samples`. A change the file can't take, or a file that can't be read, posts the file's state back
// (`samples: [], selected: null, samplesError: <reason>` when unreadable); a failed write shows
// `Couldn't save the samples: <reason>` and the config's panels get the file's state. An outside edit or a
// save of the file posts `samples` to the config's panels. The page's `data-samples` is the file's
// name (the "Saved in" line).
// Ticket 4.16 (AD-22): while the panel's processor has no label (and its samples are linked by its
// path), the snapshot carries `unlabelledPath`, and the webview offers Add label. `addLabelRequested`
// shows an input box (`askLabel`) prefilled with `<kind>_<N>` and checked with the binary's label rule,
// the document's labels and the samples file's label entries; on accept one edit inserts
// `label: <name>` as the processor's first key (the document is not saved), then the samples entry
// of the path, if any, is relinked to the label (`SampleStore.relink`); once it is, the panel's title,
// its link and a new snapshot follow. A processor that changed meanwhile, or an edit that did not
// apply, relinks nothing and shows the error; a relink that can't happen (the label taken, the file
// unreadable or not written) removes the inserted label again, keeps the path link and says why.

import * as path from 'path';
import * as vscode from 'vscode';
import { bloblangProcessorAt, bloblangProcessorByPath, bloblangProcessors, type BloblangProcessor } from '../../core/bloblangProcessors';
import { documentLabels, labelError, labelInsertion, suggestLabel, type TextInsertion } from '../../core/labelEdit';
import { samplesFor, type SampleChange, type SampleRef } from '../../core/samples';
import {
	parseBloblangWebviewMessage, type BinaryStatus, type BloblangHostMessage, type BloblangProcessorKind, type InputMeta,
} from '../../shared/bloblangProtocol';
import { webviewHtml } from '../graphPanel/html';
import type { BinaryState } from '../redpandaConnect/binary';
import type { BinaryActions } from '../redpandaConnect/notify';
import { runMappingTest, type FilePosition, type MappingTestDependencies, type MappingTestOutcome } from '../redpandaConnect/bloblang';
import type { DetectionRegistry } from '../vscode/detection';
import { parsedDocument } from '../vscode/parseCache';
import { BloblangHints } from './hint';
import { SampleStore, samplesUri } from './sampleStore';

export const TEST_MAPPING_COMMAND = 'redpandaConnect.testMapping';
export const BLOBLANG_VIEW_TYPE = 'redpandaConnect.bloblang';
/** Shown when Test mapping finds no mapping or mutation processor at the cursor. */
export const NO_MAPPING_AT_CURSOR = 'Put the cursor in a mapping or mutation processor.';
/** Shown when the CodeLens's processor is not in the open, detected document any more. */
export const NO_LONGER_THERE = 'That mapping or mutation processor is no longer there.';
/** The Delete modal's message and its button (4.9). */
export const deleteSampleMessage = (name: string): string => `Delete sample "${name}"?`;
export const DELETE_SAMPLE_BUTTON = 'Delete';
/** Shown (an error) when the samples file can't be written or deleted (4.9). */
export const couldNotSaveSamples = (reason: string): string => `Couldn't save the samples: ${reason}`;
/** Shown when Test mapping is used on an untitled file. */
export const SAVE_TO_TEST = 'Save the file to test its mappings.';
/** Add label's input box (4.16): its title and prompt. */
export const ADD_LABEL_TITLE = 'Add label';
export const addLabelPrompt = (processorPath: string): string =>
	`A label for the processor at ${processorPath}: its samples then follow it wherever it moves.`;
/** Shown (an error) when Add label writes nothing (4.16), with the reason. */
export const couldNotAddLabel = (reason: string): string => `Couldn't add the label: ${reason}`;
export const LABEL_PROCESSOR_CHANGED = 'the processor changed meanwhile.';
export const LABEL_EDIT_FAILED = 'the edit was not applied.';
export const labelSamplesUnreadable = (reason: string): string => `the samples file can't be read: ${reason}`;
export const labelSamplesNotSaved = (reason: string): string => `the samples could not be saved: ${reason}`;
export const labelInSamples = (label: string): string => `samples already use the label "${label}".`;
/** How many of a panel's posted messages `posted` keeps (test seam). */
export const MAX_BLOBLANG_POSTED = 50;

/** The tab title of a processor's panel. */
export function bloblangTitle(processor: Pick<BloblangProcessor, 'label' | 'path'>): string {
	return `Bloblang: ${processor.label ?? processor.path}`;
}

/** One mapping's panel, as seen by tests (the host-side seam). */
export interface BloblangPanelHandle {
	readonly uri: vscode.Uri;
	readonly path: string;
	readonly panel: vscode.WebviewPanel;
	/** The last MAX_BLOBLANG_POSTED messages posted to the webview, in order. */
	readonly posted: readonly BloblangHostMessage[];
	/** Handles `message` as if the webview had posted it; resolves once its reply is posted. */
	receive(message: unknown): Promise<void>;
}

/** Runs one test (the AD-21 adapter in production). */
export type MappingTestRunner = (
	state: BinaryState,
	kind: BloblangProcessorKind,
	source: string,
	content: string,
	meta: InputMeta,
	storageDir: string,
	deps: MappingTestDependencies,
) => Promise<MappingTestOutcome>;

/** The processor at a panel's path and the document text it was read from. */
interface Current {
	readonly processor: BloblangProcessor | undefined;
	/** The document's text when the processor was read: the base of its position map. */
	readonly text: string;
}

/** One run's input: the message content and its metadata. */
interface TestInput {
	readonly content: string;
	readonly meta: InputMeta;
}

export interface BloblangPanelsOptions {
	readonly extensionUri: vscode.Uri;
	readonly log: (line: string) => void;
	/** The current binary and its changes (AD-9): `RedpandaConnect` in production. */
	readonly binary: { readonly state: BinaryState; readonly onDidChange: vscode.Event<BinaryState> };
	/**
	 * The binary warning's actions, run by the no-binary state's buttons (AD-9): `RedpandaConnect.actions`
	 * in production, as the graph's. `undefined`: the buttons do nothing.
	 */
	readonly actions: BinaryActions | undefined;
	/** Where temporary test configs are written: the extension's global storage. */
	readonly storageDir: string;
	/** Which files are Redpanda Connect configs (AD-18): only their processors are tested. */
	readonly detection: Pick<DetectionRegistry, 'isDetected'>;
	/** Test seam: the test runner; `undefined`: `runMappingTest`. */
	readonly run?: MappingTestRunner;
	/**
	 * Shows a message, an information one unless `kind` is `error`; `undefined`:
	 * `window.showInformationMessage` / `window.showErrorMessage`.
	 */
	readonly showMessage?: (message: string, kind?: 'info' | 'error') => void;
	/**
	 * Asks whether to delete the sample `name` (4.9); `undefined`: a modal warning,
	 * `Delete sample "<name>"?` with Delete.
	 */
	readonly confirmDelete?: (name: string) => Promise<boolean>;
	/**
	 * Asks for a label (4.16): `value` prefilled, `validate` the input box's check (`undefined`: valid);
	 * resolves with the accepted name, `undefined` on Esc. `undefined`: `window.showInputBox`.
	 */
	readonly askLabel?: (request: LabelRequest) => Promise<string | undefined>;
}

/** What Add label's input box shows and checks (4.16). */
export interface LabelRequest {
	readonly title: string;
	readonly prompt: string;
	readonly value: string;
	readonly validate: (name: string) => string | undefined;
}

class BloblangPanel implements BloblangPanelHandle {
	readonly posted: BloblangHostMessage[] = [];
	/** The latest input waiting for the run in flight to end (single flight); `undefined`: none. */
	private pending: TestInput | undefined;
	/** The run loop in flight, if any. */
	private loop: Promise<void> | undefined;
	/** The `kind` and source last sent in a snapshot, so that an edit elsewhere sends nothing. */
	private sentSource: string | undefined;
	/**
	 * The latest `failed` result with a file line: its mapping line and that line's text in the
	 * source the run used; `undefined`: no hint.
	 */
	private hint: { readonly line: number; readonly text: string } | undefined;
	private disposed = false;
	/** While Add label writes the label and relinks (4.16): sample changes wait for it, documentChanged posts nothing. */
	private labelling: Promise<void> | undefined;
	private readonly subscription: vscode.Disposable;
	/** The watch on the config's samples file, held while the panel is open. */
	private readonly watch: vscode.Disposable;
	/**
	 * What links the panel to its saved samples: the processor's label at open, else its path (4.9);
	 * the label Add label wrote (4.16).
	 */
	ref: SampleRef;

	constructor(
		readonly uri: vscode.Uri,
		readonly path: string,
		label: string | undefined,
		readonly panel: vscode.WebviewPanel,
		private readonly owner: BloblangPanels,
	) {
		this.ref = label !== undefined ? { label, path } : { path };
		this.watch = owner.samples.watch(uri);
		this.subscription = panel.webview.onDidReceiveMessage((m) => this.receive(m));
	}

	async receive(message: unknown): Promise<void> {
		try {
			const msg = parseBloblangWebviewMessage(message);
			if (msg?.type === 'ready') {
				await this.postSnapshot();
			} else if (msg?.type === 'run') {
				await this.run({ content: msg.content, meta: msg.meta });
			} else if (msg?.type === 'goToLine') {
				await this.owner.goToLine(this.uri, msg.line);
			} else if (msg?.type === 'installGuideRequested') {
				await this.owner.actions?.installGuide();
			} else if (msg?.type === 'setPathRequested') {
				await this.owner.actions?.setPath();
			} else if (msg?.type === 'retryRequested') {
				await this.owner.actions?.retry();
			} else if (msg?.type === 'sampleAdded') {
				await this.change({ type: 'add', sample: { name: msg.name, content: '', meta: {} } });
			} else if (msg?.type === 'sampleRenamed') {
				await this.change({ type: 'rename', from: msg.from, to: msg.to });
			} else if (msg?.type === 'sampleSwitched') {
				await this.change({ type: 'select', name: msg.name });
			} else if (msg?.type === 'inputEdited') {
				await this.change({ type: 'edit', content: msg.content, meta: msg.meta });
			} else if (msg?.type === 'addLabelRequested') {
				await this.addLabel();
			} else if (msg?.type === 'sampleDeleted') {
				if (await this.owner.confirmDelete(msg.name)) {
					await this.change({ type: 'delete', name: msg.name }, true);
				}
			}
		} catch (e) {
			this.fail(e);
		}
	}

	/** The panel's document changed: a snapshot when the processor's kind or Bloblang changed. */
	async documentChanged(): Promise<void> {
		try {
			const processor = this.processor();
			this.updateHint();
			// While Add label runs, its own snapshot follows the relink.
			if (!this.labelling && this.sourceKey(processor) !== this.sentSource) {
				await this.postSnapshot();
			}
		} catch (e) {
			this.fail(e);
		}
	}

	/** The binary state changed (4.15): its status, as the panel shows it. */
	binaryChanged(): Promise<void> {
		const status = this.owner.binaryStatus();
		if (status !== 'ok') {
			// The webview hides the failed result with no binary: its hint goes too, for good.
			this.hint = undefined;
			this.owner.hints.set(this.key, this.uri, undefined);
		}
		// `post` logs a failed post; it never throws.
		return this.post({ type: 'binary', status });
	}

	/** What a snapshot shows of `processor`: its kind, its Bloblang and whether the offer shows. */
	private sourceKey(processor: BloblangProcessor | undefined): string {
		return JSON.stringify([processor?.kind ?? 'mapping', processor?.source ?? '', this.unlabelled(processor)]);
	}

	/**
	 * Whether the panel offers Add label (4.16): its samples are linked by path, the processor (there
	 * now) has no label and the config has a samples file (it is not untitled).
	 */
	private unlabelled(processor: BloblangProcessor | undefined): boolean {
		return this.ref.label === undefined && processor !== undefined && processor.label === undefined && samplesUri(this.uri) !== undefined;
	}

	private async postSnapshot(): Promise<void> {
		const processor = this.processor();
		const kind = processor?.kind ?? 'mapping';
		const source = processor?.source ?? '';
		this.sentSource = this.sourceKey(processor);
		const unlabelled = this.unlabelled(processor);
		const samples = await this.samples();
		await this.post({
			type: 'snapshot', title: this.panel.title, kind, source, binary: this.owner.binaryStatus(), ...samples,
			...(unlabelled ? { unlabelledPath: this.path } : {}),
		});
	}

	/**
	 * Add label (4.16): asks for a label, writes it as the processor's first key, relinks the path's
	 * samples entry to it, and the title, the link and a snapshot follow. Esc changes nothing; a
	 * processor that changed meanwhile or an edit that did not apply shows the error and relinks nothing.
	 */
	private async addLabel(): Promise<void> {
		const processor = this.processor();
		if (!processor || !this.unlabelled(processor)) {
			// Nothing to offer any more: the webview gets the panel's state.
			await this.postSnapshot();
			return;
		}
		const state = await this.owner.samples.read(this.uri);
		if (state.kind === 'unreadable') {
			this.owner.tell(couldNotAddLabel(labelSamplesUnreadable(state.reason)), 'error');
			return;
		}
		const sampleLabels = new Set(state.file?.mappings.flatMap((m) => (m.label !== undefined ? [m.label] : [])) ?? []);
		const labels = () => {
			const doc = this.document();
			return documentLabels(doc ? parsedDocument(doc).parsed : undefined);
		};
		const name = await this.owner.askLabel({
			title: ADD_LABEL_TITLE,
			prompt: addLabelPrompt(this.path),
			value: suggestLabel(processor.kind, labels()),
			validate: (value) => labelError(value, labels(), sampleLabels),
		});
		if (name === undefined || this.disposed) {
			return;
		}
		const doc = this.document();
		const now = this.current();
		const at = now.processor;
		if (!doc || !at || !this.unlabelled(at) || at.kind !== processor.kind || at.source !== processor.source
			|| labelError(name, labels(), sampleLabels) !== undefined) {
			this.owner.tell(couldNotAddLabel(LABEL_PROCESSOR_CHANGED), 'error');
			return;
		}
		const insertion = labelInsertion(now.text, at, name);
		if (!insertion) {
			this.owner.tell(couldNotAddLabel(LABEL_EDIT_FAILED), 'error');
			return;
		}
		let done!: () => void;
		this.labelling = new Promise((resolve) => (done = resolve));
		try {
			await this.writeLabel(doc, insertion, name);
		} finally {
			this.labelling = undefined;
			done();
		}
		await this.postSnapshot();
	}

	/**
	 * Inserts the label and relinks the path's samples to it (4.16). Only once the relink wrote the
	 * file, or found no entry, do the link and the title follow; any other outcome removes the
	 * inserted text again (when it is still there), keeps the path link and shows why.
	 */
	private async writeLabel(doc: vscode.TextDocument, insertion: TextInsertion, name: string): Promise<void> {
		const edit = new vscode.WorkspaceEdit();
		edit.insert(doc.uri, doc.positionAt(insertion.offset), insertion.text);
		if (!await vscode.workspace.applyEdit(edit) || this.processor()?.label !== name) {
			this.owner.tell(couldNotAddLabel(LABEL_EDIT_FAILED), 'error');
			return;
		}
		const outcome = await this.owner.samples.relink(this.uri, this.path, name);
		if (outcome === 'written' || outcome === 'unchanged') {
			this.ref = { label: name, path: this.path };
			this.panel.title = bloblangTitle({ label: name, path: this.path });
			return;
		}
		const end = insertion.offset + insertion.text.length;
		if (doc.getText().slice(insertion.offset, end) === insertion.text) {
			const undo = new vscode.WorkspaceEdit();
			undo.delete(doc.uri, new vscode.Range(doc.positionAt(insertion.offset), doc.positionAt(end)));
			await vscode.workspace.applyEdit(undo);
		}
		const reason = outcome === 'taken' ? labelInSamples(name)
			: 'failed' in outcome ? labelSamplesNotSaved(outcome.failed) : labelSamplesUnreadable(outcome.unreadable);
		this.owner.tell(couldNotAddLabel(reason), 'error');
	}

	/** The panel's samples as the file has them now, or the unreadable file's reason (4.9). */
	private async samples(): Promise<Pick<Extract<BloblangHostMessage, { type: 'samples' }>, 'samples' | 'selected' | 'samplesError'>> {
		// The link as it is when the read is asked for: the read is queued in that order (4.16).
		const ref = this.ref;
		const state = await this.owner.samples.read(this.uri);
		return state.kind === 'ok'
			? samplesFor(state.file, ref)
			: { samples: [], selected: null, samplesError: state.reason };
	}

	/** Posts `samples`: the file's state now (4.9). */
	async postSamples(): Promise<void> {
		try {
			await this.post({ type: 'samples', ...await this.samples() });
		} catch (e) {
			this.fail(e);
		}
	}

	/**
	 * Applies `change` to the samples file (4.9). Written: the panel gets `samples` with `echo` only
	 * (the webview already shows the change; the other panels' entries did not change). Not written:
	 * it gets the file's state back, except for an edit that changed nothing (the webview may be
	 * ahead of the file by then). A failed write shows `Couldn't save the samples: <reason>` and the
	 * config's panels get the file's state, so they match the disk.
	 */
	private async change(change: SampleChange, echo = false): Promise<void> {
		// A change during Add label's relink goes to the link that results (4.16).
		await this.labelling;
		const outcome = await this.owner.samples.update(this.uri, this.ref, change);
		if (typeof outcome === 'object') {
			await this.owner.samplesFailed(this.uri, outcome.failed);
		} else if (outcome === 'written' ? echo : outcome === 'unreadable' || change.type !== 'edit') {
			await this.postSamples();
		}
	}

	/**
	 * Single flight: one run child per panel at a time. An input arriving while one runs replaces
	 * any input still waiting, and starts when the current run ends; only a run with no input
	 * waiting after it posts its result. A run that throws posts an `error` result.
	 */
	private async run(input: TestInput): Promise<void> {
		this.pending = input;
		if (!this.loop) {
			this.loop = (async () => {
				try {
					while (this.pending !== undefined && !this.disposed) {
						const next = this.pending;
						this.pending = undefined;
						let outcome: MappingTestOutcome;
						let current: Current | undefined;
						try {
							current = this.current();
							outcome = await this.owner.runTest(this.uri, current, this.path, next);
						} catch (e) {
							this.fail(e);
							outcome = { result: { kind: 'error', message: e instanceof Error ? e.message : String(e) }, durationMs: 0, binary: null };
						}
						if (this.pending === undefined && !this.disposed) {
							const result = outcome.result;
							const line = result.kind === 'failed' && result.fileLine !== undefined ? result.mappingLine : undefined;
							const text = line === undefined ? undefined : mappingLineText(current?.processor?.source ?? '', line);
							this.hint = line !== undefined && text !== undefined ? { line, text } : undefined;
							this.updateHint();
							await this.post({ type: 'result', ...outcome });
						}
					}
				} finally {
					this.loop = undefined;
				}
			})();
		}
		await this.loop;
	}

	/** The processor at this panel's path in the open document, now. */
	private processor(): BloblangProcessor | undefined {
		return this.current().processor;
	}

	/** The processor at this panel's path and the text of the open document, now. */
	private current(): Current {
		const doc = this.document();
		if (!doc) {
			return { processor: undefined, text: '' };
		}
		const parsed = parsedDocument(doc).parsed;
		return { processor: bloblangProcessorByPath(bloblangProcessors(parsed), this.path), text: doc.getText() };
	}

	private document(): vscode.TextDocument | undefined {
		return vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.uri.toString());
	}

	/**
	 * Puts the hint on the file line of the hint's mapping line in the processor now, or clears it
	 * for good: with no hint, no processor, or a mapping line whose text is not the failed run's any
	 * more (an edit that only shifts lines clears it too; the next run places it again).
	 */
	private updateHint(): void {
		let line: number | undefined;
		const doc = this.document();
		const hint = this.hint;
		const processor = hint && doc ? this.processor() : undefined;
		if (doc && processor && hint && mappingLineText(processor.source, hint.line) === hint.text) {
			const offset = processor.positions.lineStart(hint.line);
			if (offset >= processor.range[0] && offset < processor.range[1]) {
				line = doc.positionAt(offset).line;
			}
		}
		if (line === undefined) {
			// Gone for good: an edit that brings the line back does not bring the hint back.
			this.hint = undefined;
		}
		this.owner.hints.set(this.key, this.uri, line);
	}

	private get key(): string {
		return keyOf(this.uri, this.path);
	}

	private async post(message: BloblangHostMessage): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.posted.push(message);
		if (this.posted.length > MAX_BLOBLANG_POSTED) {
			this.posted.splice(0, this.posted.length - MAX_BLOBLANG_POSTED);
		}
		try {
			await this.panel.webview.postMessage(message);
		} catch (e) {
			this.fail(e);
		}
	}

	private fail(e: unknown): void {
		if (!this.disposed) {
			this.owner.log(`${this.panel.title}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	dispose(): void {
		this.disposed = true;
		this.hint = undefined;
		this.owner.hints.set(this.key, this.uri, undefined);
		this.subscription.dispose();
		this.watch.dispose();
	}
}

/** All open Bloblang test panels, one per mapping processor. */
export class BloblangPanels implements vscode.Disposable {
	private readonly panels = new Map<string, BloblangPanel>();
	private readonly subscriptions: vscode.Disposable[];
	/** The end-of-line hints of all panels: one decoration type (4.8). */
	readonly hints = new BloblangHints();
	/** The configs' samples files (4.9). */
	readonly samples: SampleStore;

	constructor(private readonly options: BloblangPanelsOptions) {
		this.samples = new SampleStore((line) => this.log(line));
		this.subscriptions = [
			// An outside edit of a samples file (4.9): its config's panels get `samples`.
			this.samples.onDidChange((config) => {
				for (const entry of this.panelsOf(config)) {
					void entry.postSamples();
				}
			}),
			// The shown Bloblang follows edits, so it always matches what the next run uses.
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (e.contentChanges.length === 0) {
					return;
				}
				const key = e.document.uri.toString();
				for (const entry of this.panels.values()) {
					if (entry.uri.toString() === key) {
						void entry.documentChanged();
					}
				}
			}),
			// The no-binary state (4.15): every panel hears each binary change.
			options.binary.onDidChange(() => {
				for (const entry of this.panels.values()) {
					void entry.binaryChanged();
				}
			}),
		];
	}

	/** The binary warning's actions (AD-9), for the no-binary state's buttons. */
	get actions(): BinaryActions | undefined {
		return this.options.actions;
	}

	/** The binary's status, as the panel shows it. */
	binaryStatus(): BinaryStatus {
		return this.options.binary.state.kind;
	}

	/** Asks whether to delete the sample `name` (4.9). */
	async confirmDelete(name: string): Promise<boolean> {
		if (this.options.confirmDelete) {
			return this.options.confirmDelete(name);
		}
		const picked = await vscode.window.showWarningMessage(deleteSampleMessage(name), { modal: true }, DELETE_SAMPLE_BUTTON);
		return picked === DELETE_SAMPLE_BUTTON;
	}

	/** Writing `config`'s samples file failed (4.9): the error, and its panels get the file's state. */
	async samplesFailed(config: vscode.Uri, reason: string): Promise<void> {
		this.tell(couldNotSaveSamples(reason), 'error');
		await Promise.all(this.panelsOf(config).map((entry) => entry.postSamples()));
	}

	/** The open panels of `config`. */
	private panelsOf(config: vscode.Uri): BloblangPanel[] {
		const key = config.toString();
		return [...this.panels.values()].filter((entry) => entry.uri.toString() === key);
	}

	/** Writes `line` to the output channel. */
	log(line: string): void {
		this.options.log(line);
	}

	registerCommands(): vscode.Disposable[] {
		return [
			vscode.commands.registerCommand(TEST_MAPPING_COMMAND, (uri?: unknown, processorPath?: unknown) => this.testMapping(uri, processorPath)),
		];
	}

	/**
	 * Test mapping: from the CodeLens, the processor at `processorPath` of `uri`; from the Command
	 * Palette (no arguments), the processor at the cursor of the active editor, else the message
	 * NO_MAPPING_AT_CURSOR. Never throws.
	 */
	async testMapping(uri?: unknown, processorPath?: unknown): Promise<BloblangPanelHandle | undefined> {
		try {
			if (uri instanceof vscode.Uri && typeof processorPath === 'string') {
				return await this.show(uri, processorPath);
			}
			const editor = vscode.window.activeTextEditor;
			const doc = editor?.document;
			if (doc?.uri.scheme === 'untitled') {
				this.tell(SAVE_TO_TEST);
				return undefined;
			}
			const processor = editor && doc && this.options.detection.isDetected(doc.uri)
				? bloblangProcessorAt(bloblangProcessors(parsedDocument(doc).parsed), doc.offsetAt(editor.selection.active))
				: undefined;
			if (!doc || !processor) {
				this.tell(NO_MAPPING_AT_CURSOR);
				return undefined;
			}
			return await this.show(doc.uri, processor.path);
		} catch (e) {
			this.log(`Test mapping: ${e instanceof Error ? e.message : String(e)}`);
			return undefined;
		}
	}

	/** Asks for a label (4.16): the seam, else an input box. */
	askLabel(request: LabelRequest): Promise<string | undefined> {
		if (this.options.askLabel) {
			return this.options.askLabel(request);
		}
		return Promise.resolve(vscode.window.showInputBox({
			title: request.title, prompt: request.prompt, value: request.value, validateInput: request.validate,
		}));
	}

	/** Writes `message` to the output channel and shows it. */
	tell(message: string, kind: 'info' | 'error' = 'info'): void {
		this.log(`Test mapping: ${message}`);
		if (this.options.showMessage) {
			this.options.showMessage(message, kind);
		} else if (kind === 'error') {
			void vscode.window.showErrorMessage(message);
		} else {
			void vscode.window.showInformationMessage(message);
		}
	}

	/**
	 * Opens the panel of the processor at `processorPath` of `uri` beside the YAML without focus, or
	 * reveals its open panel. `undefined` (with the message) when the file is untitled, not detected,
	 * not open or has no such processor.
	 */
	async show(uri: vscode.Uri, processorPath: string): Promise<BloblangPanelHandle | undefined> {
		if (uri.scheme === 'untitled') {
			this.tell(SAVE_TO_TEST);
			return undefined;
		}
		const key = keyOf(uri, processorPath);
		const open = this.panels.get(key);
		if (open) {
			open.panel.reveal(undefined, true);
			return open;
		}
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
		const processor = doc && this.options.detection.isDetected(uri)
			? bloblangProcessorByPath(bloblangProcessors(parsedDocument(doc).parsed), processorPath)
			: undefined;
		if (!processor) {
			this.tell(NO_LONGER_THERE);
			return undefined;
		}
		const title = bloblangTitle(processor);
		const panel = vscode.window.createWebviewPanel(
			BLOBLANG_VIEW_TYPE,
			title,
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, 'dist')],
			},
		);
		const entry = new BloblangPanel(uri, processorPath, processor.label, panel, this);
		this.panels.set(key, entry);
		panel.onDidDispose(() => {
			entry.dispose();
			if (this.panels.get(key) === entry) {
				this.panels.delete(key);
			}
		});
		// The file's name, for the error cards' "<file> line F" (4.8), and its samples file's (4.9).
		const samplesFile = samplesUri(uri);
		panel.webview.html = webviewHtml(panel.webview, this.options.extensionUri, 'bloblang', title, {
			file: path.posix.basename(uri.path),
			...(samplesFile ? { samples: path.posix.basename(samplesFile.path) } : {}),
		});
		return entry;
	}

	/**
	 * Runs the processor of `current` (the one at `processorPath` of `uri`, now) on `input`. Its
	 * result's file positions are those of `current.text`, the document the run used.
	 */
	async runTest(uri: vscode.Uri, current: Current, processorPath: string, input: TestInput): Promise<MappingTestOutcome> {
		const state = this.options.binary.state;
		const { processor, text } = current;
		if (!processor) {
			return {
				result: { kind: 'error', message: `There is no mapping or mutation processor at ${processorPath} in ${path.posix.basename(uri.path)} any more.` },
				durationMs: 0,
				binary: null,
			};
		}
		const cwd = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath);
		const locate = (line: number, char: number): FilePosition => positionIn(text, processor.positions.offsetAt(line, char));
		return (this.options.run ?? runMappingTest)(state, processor.kind, processor.source, input.content, input.meta, this.options.storageDir, { cwd, locate });
	}

	/**
	 * Go to line (4.8): shows `uri` in its editor group with the cursor at the start of the 1-based
	 * `line` (past the end: the last line), revealed in the centre, and the editor takes focus.
	 */
	async goToLine(uri: vscode.Uri, line: number): Promise<void> {
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
			?? await vscode.workspace.openTextDocument(uri);
		const at = new vscode.Position(Math.max(0, Math.min(line, doc.lineCount) - 1), 0);
		const range = new vscode.Range(at, at);
		const editor = await vscode.window.showTextDocument(doc, { viewColumn: editorColumn(uri), preserveFocus: false, selection: range });
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
	}

	/** The end-of-line hints' current ranges in `uri` (test seam: decorations can't be read back). */
	hintRanges(uri: vscode.Uri): vscode.Range[] {
		return this.hints.ranges(uri);
	}

	/** The open panel of the processor at `processorPath` of `uri`, if any (test seam). */
	panelFor(uri: vscode.Uri, processorPath: string): BloblangPanelHandle | undefined {
		return this.panels.get(keyOf(uri, processorPath));
	}

	/** How many Bloblang panels are open. */
	get size(): number {
		return this.panels.size;
	}

	dispose(): void {
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		for (const entry of [...this.panels.values()]) {
			entry.panel.dispose();
		}
		this.panels.clear();
		this.hints.dispose();
		this.samples.dispose();
	}
}

/**
 * The editor group of `uri`'s editor: a visible editor's, else the group with a tab of it, else the
 * first group.
 */
function editorColumn(uri: vscode.Uri): vscode.ViewColumn {
	const key = uri.toString();
	const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key)?.viewColumn;
	if (visible !== undefined) {
		return visible;
	}
	const group = vscode.window.tabGroups.all.find((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key));
	return group?.viewColumn ?? vscode.ViewColumn.One;
}

/** The text of the mapping's 1-based `line`; `undefined` past its lines (a final line break starts none). */
function mappingLineText(source: string, line: number): string | undefined {
	const lines = source.replace(/\n$/, '').split('\n');
	return line >= 1 && line <= lines.length ? lines[line - 1] : undefined;
}

/**
 * The 1-based line and UTF-16 character of `offset` in `text`, as `TextDocument.positionAt` gives
 * them plus 1 (line breaks: `\r\n`, `\n`, `\r`); an offset past the end is the end.
 */
export function positionIn(text: string, offset: number): FilePosition {
	const at = Math.max(0, Math.min(offset, text.length));
	let line = 1;
	let start = 0;
	for (let i = 0; i < at; i++) {
		const c = text.charCodeAt(i);
		if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) {
			line++;
			start = i + 1;
		}
	}
	return { line, char: at - start + 1 };
}

function keyOf(uri: vscode.Uri, processorPath: string): string {
	return `${uri.toString()}#${processorPath}`;
}
