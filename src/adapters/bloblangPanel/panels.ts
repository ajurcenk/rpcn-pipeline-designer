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
// Ticket 4.10 (AD-1, AD-22): each panel follows its processor through the document's changes
// (`processorTracking.ts`): its processor's map range is mapped through each change's
// `contentChanges`, and while the document parses all its panels are matched together, one panel per
// processor: by overlap, else by label; a removed panel by its last label, else by the same kind and
// Bloblang nearest its last path. While the YAML doesn't parse nothing is matched: the panels keep
// their processor, title and state (as the graph, AD-17), and runs use the last processor found. Its
// path, label, key (`uri#path`) and title follow, and a snapshot goes out when the title, kind,
// Bloblang or removed state changes. A processor that can't be found puts the panel in the removed
// state (the snapshot's `removed`): it keeps its last path, label, kind and Bloblang, runs nothing,
// and its hint clears. When the document closes with unsaved changes, each panel resets to its saved
// position (its label and path in the saved file) and is matched by it when the document opens again.
// On each save of the document, all of the config's panels whose
// processor's link (its label, else its path) differs from their samples link move their entries to
// the new links in one step (`SampleStore.relinkAll`); a link still taken moves nothing and says so
// (a panel with no samples to move keeps its link silently), and afterwards every panel of the
// config gets the file's samples. Until then a panel shows its samples under the old link. Two live
// panels never share a samples link: a removed panel whose link another panel took, or that comes
// back to a link a live panel has, is left with none (no samples, and a sample change says
// SAMPLES_WAIT_FOR_SAVE) until its next save. The hint is keyed by the panel itself, so it follows.
// Ticket 4.17 (AD-1, AD-22): as the graph's (`graphPanel/tabs.ts`), a panel closes once its file had a
// text tab and has none left, except while a rename of the file (or of a folder holding it, or onto
// it) is pending. A rename moves each panel of the renamed config to the new URI: its key, hint, samples
// watch, dirty-set entry and tracking (the panel is not reset or reopened, and the close of the old
// document the rename causes resets nothing); a panel landing on another panel's key closes; and the
// snapshot carries the new `fileName` and `samplesFile`. A single file's rename also renames its
// samples file (`SampleStore.moveFile`), unless the new one exists (both are left, and the user is
// told). Placement: a new panel goes into the test group (a group holding a test panel and no text
// editors or graph) when there is one; else, with the file's graph open, into a new group below the
// graph's group; else beside the YAML (never into a graph's group). Focus stays in the YAML.
// Ticket 4.11: `focusEditorRequested` (Esc in the panel, the graph's message) shows the YAML in its
// editor group and focuses it, with its cursor and selection unchanged; with no editor of it, nothing.
// Ticket 4.18 (AD-22): the snapshot names the previous step (`previousStep`: the `mapping` / `mutation`
// just before the processor in its own list, `previousSteps`), and `sampleFromPreviousRequested` runs
// the previous steps, from the nearest one with a selected sample up to the one before, each through
// the AD-21 runner (`runTest`) on the last one's output; the last output becomes a new selected sample
// "from <previousStep>" (made unique, again once if the name is taken meanwhile), saved and posted as
// `samples` (the webview runs it). A step that deletes the message or fails, a chain with no sample, a
// document with unsaved changes (samples are linked to the saved file) or one edited during the runs
// saves nothing and says so. One such request
// per panel at a time (another one meanwhile is ignored); the panel's own runs are untouched.

import * as path from 'path';
import * as vscode from 'vscode';
import {
	bloblangProcessorAt, bloblangProcessorByPath, bloblangProcessors, previousSteps, stepTitle, type BloblangProcessor,
} from '../../core/bloblangProcessors';
import { documentLabels, labelError, labelInsertion, suggestLabel, type TextInsertion } from '../../core/labelEdit';
import { mapRange, matchProcessors, parses, type OffsetRange, type TextChange, type TrackedProcessor } from '../../core/processorTracking';
import { freeSampleName, inputMetaOf, linkOf, samplesFor, type RelinkMove, type SampleChange, type SampleRef } from '../../core/samples';
import {
	parseBloblangWebviewMessage, type BinaryStatus, type BloblangHostMessage, type BloblangProcessorKind, type InputMeta,
} from '../../shared/bloblangProtocol';
import { BLOBLANG_VIEW_TYPE, holdsGraph, isTestGroup, newGroupNextTo } from '../graphPanel/groups';
import { webviewHtml } from '../graphPanel/html';
import { hasTextTab, isTextTabOf, PENDING_RENAME_MS, PendingRenames, renamedThrough, until } from '../graphPanel/tabs';
import type { BinaryState } from '../redpandaConnect/binary';
import type { BinaryActions } from '../redpandaConnect/notify';
import { runMappingTest, type FilePosition, type MappingTestDependencies, type MappingTestOutcome } from '../redpandaConnect/bloblang';
import type { DetectionRegistry } from '../vscode/detection';
import { parsedDocument } from '../vscode/parseCache';
import { BloblangHints } from './hint';
import { SampleStore, samplesUri } from './sampleStore';

export const TEST_MAPPING_COMMAND = 'redpandaConnect.testMapping';
export { BLOBLANG_VIEW_TYPE };
/** How long a new test panel's placement waits for focus to be back in the YAML, per try (4.13). */
const FOCUS_WAIT_MS = 500;
/** How long, once focus is back in the YAML, the placement lets a late focus change arrive before it re-checks (4.13). */
const FOCUS_SETTLE_MS = 100;
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
/** Shown (an error) when a save can't move the samples to the processor's new link (4.10). */
export const couldNotMoveSamples = (link: string, reason: string): string => `Couldn't move the samples to ${link}: ${reason}`;
export const SAMPLES_USE_IT = 'samples already use it.';
/** Shown when a panel with no samples link (4.10) gets a sample change. */
export const SAMPLES_WAIT_FOR_SAVE = 'This processor\'s samples can\'t be saved until the file is saved.';
/** Shown when a rename can't move the samples file (4.17): the new config's already exists. */
export const samplesNotMoved = (name: string): string => `Samples weren't moved: ${name} already exists.`;
/** From previous step (4.18): the new sample's name before it is made unique, and the messages. */
export const fromPreviousSampleName = (step: string): string => `from ${step}`;
export const previousDeleted = (step: string): string => `"${step}" deleted the message; no sample was saved.`;
export const previousFailed = (step: string, message: string): string => `"${step}" failed: ${message}`;
export const previousHasNoSample = (step: string): string => `"${step}" has no sample to run.`;
export const saveFirst = (file: string): string => `Save ${file} first: samples are linked to the saved file.`;
export const PREVIOUS_FILE_CHANGED = 'The file changed while the previous steps ran; try again.';
export const samplesUnreadable = (reason: string): string => `The samples file can't be read: ${reason}`;
/** Why From previous step's sample could not be added (4.18): its name was taken twice meanwhile. */
export const PREVIOUS_NAME_TAKEN = 'another sample took its name.';
/** How many of a panel's posted messages `posted` keeps (test seam). */
export const MAX_BLOBLANG_POSTED = 50;

/** The tab title of a processor's panel. */
export function bloblangTitle(processor: Pick<BloblangProcessor, 'label' | 'path'>): string {
	return `Bloblang: ${processor.label ?? processor.path}`;
}

/** One mapping's panel, as seen by tests (the host-side seam). */
export interface BloblangPanelHandle {
	readonly uri: vscode.Uri;
	/** The path of the processor it follows now (4.10); while removed, its last path. */
	readonly path: string;
	/** Whether its processor can't be found (the removed state, 4.10). */
	readonly removed: boolean;
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

/** The next hint key: one per panel, so its hint follows it through path changes (4.10). */
let nextHintKey = 0;

/** The processor at a panel's path and the document text it was read from. */
interface Current {
	readonly processor: BloblangProcessor | undefined;
	/** The document's text when the processor was read: the base of its position map. */
	readonly text: string;
	/** Every `mapping` / `mutation` processor of that text (4.18: the previous steps are among them). */
	readonly processors: readonly BloblangProcessor[];
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
	/**
	 * The column of `config`'s open graph panel, if any (4.17: a new test panel goes below it).
	 * `undefined`: no graph is known.
	 */
	readonly graphColumn?: (config: vscode.Uri) => vscode.ViewColumn | undefined;
	/**
	 * Test seam (4.13, RENAME_NEVER): how long an announced rename that is never reported stays
	 * pending. `undefined`: `PENDING_RENAME_MS`.
	 */
	readonly pendingRenameMs?: number;
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
	/** What the last snapshot showed (`sourceKey`), so that an edit elsewhere sends nothing. */
	private sentSource: string | undefined;
	/**
	 * The latest `failed` result with a file line: its mapping line and that line's text in the
	 * source the run used; `undefined`: no hint.
	 */
	private hint: { readonly line: number; readonly text: string } | undefined;
	private disposed = false;
	/** While Add label writes the label and relinks (4.16): sample changes wait for it, documentChanged posts nothing. */
	private labelling: Promise<void> | undefined;
	/** While a save moves the samples to the new link (4.10): sample changes wait for it. */
	private relinking: Promise<void> | undefined;
	/** While From previous step runs (4.18): another request is ignored. */
	private seeding = false;
	/** The path of the processor the panel follows (4.10); while removed, its last one. */
	path: string;
	/** Its label (4.10); while removed, its last one. */
	private label: string | undefined;
	/** Its kind and Bloblang (4.10); while removed, the last ones. */
	private kind: BloblangProcessorKind;
	private source: string;
	/** Its map range in the document now, mapped through each change (4.10); `undefined`: reset to its samples link. */
	private range: OffsetRange | undefined;
	/** The processor last found and the text it was read from (4.10): what runs use while the YAML doesn't parse. */
	private last: Current | undefined;
	/** Whether its processor can't be found (the removed state, 4.10). */
	removed = false;
	/** The panel's hint key: its own, whatever its path (4.10). */
	private readonly hintKey = `bloblang-hint-${nextHintKey++}`;
	private readonly subscription: vscode.Disposable;
	/** The watch on the config's samples file, held while the panel is open; a rename replaces it (4.17). */
	private watch: vscode.Disposable;
	/** Whether its file had a text tab (4.17): once it has none left, the panel closes. */
	hadTab: boolean;
	/** The 0-based document line its hint is on now, if any (4.17: a rename re-sets it). */
	private hintLine: number | undefined;
	/**
	 * What links the panel to its saved samples: the processor's label at open, else its path (4.9);
	 * the label Add label wrote (4.16); the processor's link at the last save that moved it (4.10).
	 * `undefined`: none, as another live panel has its link (4.10); it gets one at the next save.
	 */
	ref: SampleRef | undefined;
	/**
	 * Where its processor is in the saved file (4.10): its label and path as of the open, the last save,
	 * or the last match in a document with no unsaved changes. A close with unsaved changes resets to it.
	 */
	private saved: SampleRef;

	constructor(
		public uri: vscode.Uri,
		processor: BloblangProcessor,
		text: string,
		processors: readonly BloblangProcessor[],
		readonly panel: vscode.WebviewPanel,
		private readonly owner: BloblangPanels,
	) {
		const { path, label } = processor;
		this.path = path;
		this.label = label;
		this.kind = processor.kind;
		this.source = processor.source;
		this.range = processor.range;
		this.last = { processor, text, processors };
		this.ref = label !== undefined ? { label, path } : { path };
		this.saved = this.ref;
		this.watch = owner.samples.watch(uri);
		this.hadTab = hasTextTab(uri.toString());
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
			} else if (msg?.type === 'focusEditorRequested') {
				await this.owner.focusEditor(this.uri);
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
			} else if (msg?.type === 'sampleFromPreviousRequested') {
				await this.sampleFromPrevious();
			} else if (msg?.type === 'sampleDeleted') {
				if (await this.owner.confirmDelete(msg.name)) {
					await this.change({ type: 'delete', name: msg.name }, true);
				}
			}
		} catch (e) {
			this.fail(e);
		}
	}

	/** Maps its processor's range through a change of its document (4.10). */
	mapThrough(changes: readonly TextChange[]): void {
		if (this.range) {
			this.range = mapRange(this.range, changes);
		}
	}

	/**
	 * Its config was renamed to `uri` (4.17): the panel moves there with its tracking, hint and
	 * samples link; its samples watch follows. Synchronous, so the key is current at once.
	 */
	moveTo(uri: vscode.Uri): void {
		this.uri = uri;
		const watch = this.watch;
		this.watch = this.owner.samples.watch(uri);
		watch.dispose();
		// Its title (`Bloblang: <label ?? path>`) names no file: it stays.
		this.owner.hints.set(this.hintKey, uri, this.hintLine);
	}

	/** What the panel tracks, for matching (4.10). */
	tracked(): TrackedProcessor {
		return {
			path: this.path, ...(this.label !== undefined ? { label: this.label } : {}), kind: this.kind, source: this.source,
			range: this.range, removed: this.removed,
		};
	}

	/**
	 * Follows the processor matched in `text` (4.10): its path, label, kind, Bloblang, range and title;
	 * none: the removed state, everything else kept. Synchronous, so the key is current at once.
	 */
	follow(found: BloblangProcessor | undefined, text: string, processors: readonly BloblangProcessor[]): void {
		if (!found) {
			this.removed = true;
			this.last = undefined;
			return;
		}
		this.removed = false;
		this.path = found.path;
		this.label = found.label;
		this.kind = found.kind;
		this.source = found.source;
		this.range = found.range;
		this.last = { processor: found, text, processors };
		const title = bloblangTitle(found);
		if (this.panel.title !== title) {
			this.panel.title = title;
		}
	}

	/** Its processor's place is the saved file's now (4.10): the document has no unsaved changes. */
	markSaved(): void {
		if (!this.removed && !this.isReset) {
			this.saved = this.link();
		}
	}

	/**
	 * Its document closed with unsaved changes (4.10): they are gone, so the panel resets to its saved
	 * position (label and path) and is matched by it when the document opens again.
	 */
	reset(): void {
		this.path = this.saved.path;
		this.label = this.saved.label;
		this.range = undefined;
		this.last = undefined;
	}

	/** Whether it waits to be matched by its samples link (its document closed, 4.10). */
	get isReset(): boolean {
		return this.range === undefined;
	}

	/** Its processor's link now (4.10): its label, else its path. */
	link(): SampleRef {
		return this.label !== undefined ? { label: this.label, path: this.path } : { path: this.path };
	}

	/** Waits for Add label and a save's relink in flight, then holds sample changes until `done` is called (4.10). */
	async hold(): Promise<() => void> {
		await this.labelling;
		await this.relinking;
		let done!: () => void;
		this.relinking = new Promise((resolve) => (done = resolve));
		return () => {
			this.relinking = undefined;
			done();
		};
	}

	/** The panel's document changed: a snapshot when its title, kind, Bloblang or removed state changed. */
	async documentChanged(): Promise<void> {
		try {
			const current = this.current();
			this.updateHint();
			// While Add label runs, its own snapshot follows the relink.
			if (!this.labelling && this.sourceKey(current) !== this.sentSource) {
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
			this.setHint(undefined);
		}
		// `post` logs a failed post; it never throws.
		return this.post({ type: 'binary', status });
	}

	/**
	 * What a snapshot shows: the title, the kind, the Bloblang, whether the offer shows, the removed
	 * state (4.10) and the previous step (4.18).
	 */
	private sourceKey(current: Current): string {
		return JSON.stringify([
			this.panel.title, this.kind, this.source, this.unlabelled(current.processor) ? this.ref?.path : undefined, this.removed,
			previousStepOf(current),
		]);
	}

	/**
	 * Whether the panel offers Add label (4.16): its samples are linked by path, the processor (there
	 * now) has no label and the config has a samples file (it is not untitled).
	 */
	private unlabelled(processor: BloblangProcessor | undefined): boolean {
		return this.ref !== undefined && this.ref.label === undefined && processor !== undefined && processor.label === undefined && samplesUri(this.uri) !== undefined;
	}

	private async postSnapshot(): Promise<void> {
		// A snapshot asked for during Add label shows its outcome (4.16).
		await this.labelling;
		const current = this.current();
		const { kind, source, removed } = this;
		this.sentSource = this.sourceKey(current);
		const unlabelled = this.unlabelled(current.processor);
		const previousStep = previousStepOf(current);
		const samples = await this.samples();
		const samplesFile = samplesUri(this.uri);
		await this.post({
			type: 'snapshot', title: this.panel.title, kind, source, binary: this.owner.binaryStatus(), ...samples,
			// The samples' link (4.10): until a save moves them, the path they are under.
			...(unlabelled && this.ref ? { unlabelledPath: this.ref.path } : {}),
			...(removed ? { removed: true as const } : {}),
			// The names now (4.17: a rename changes them; the page's are the first paint's).
			fileName: path.posix.basename(this.uri.path),
			...(samplesFile ? { samplesFile: path.posix.basename(samplesFile.path) } : {}),
			...(previousStep !== undefined ? { previousStep } : {}),
		});
	}

	/**
	 * From previous step (4.18): one at a time (a request meanwhile is ignored). Runs the previous
	 * steps from the nearest one with a selected sample, each on the last one's output, and saves the
	 * last output as a new sample, selected; a deleted message, a failure or no sample saves nothing.
	 */
	private async sampleFromPrevious(): Promise<void> {
		if (this.seeding) {
			return;
		}
		this.seeding = true;
		try {
			await this.seed();
		} finally {
			this.seeding = false;
		}
	}

	private async seed(): Promise<void> {
		const current = this.current();
		const steps = current.processor ? previousSteps(current.processors, this.path) : [];
		if (steps.length === 0 || samplesUri(this.uri) === undefined) {
			// Nothing to offer any more: the webview gets the panel's state.
			await this.postSnapshot();
			return;
		}
		const doc = this.document();
		if (!doc || doc.isDirty) {
			// Entries are linked to the saved file (AD-22): an unsaved text's links may name others.
			this.owner.tell(saveFirst(path.posix.basename(this.uri.path)));
			return;
		}
		const version = doc.version;
		const previous = stepTitle(steps[0]);
		const state = await this.owner.samples.read(this.uri);
		if (state.kind === 'unreadable') {
			this.owner.tell(samplesUnreadable(state.reason), 'error');
			return;
		}
		let input: TestInput | undefined;
		let start = -1;
		for (let i = 0; i < steps.length && !input; i++) {
			const { samples, selected } = samplesFor(state.file, linkOfProcessor(steps[i]));
			const sample = samples.find((s) => s.name === selected);
			if (sample) {
				input = { content: sample.content, meta: sample.meta };
				start = i;
			}
		}
		if (!input) {
			this.owner.tell(previousHasNoSample(previous));
			return;
		}
		for (const step of steps.slice(0, start + 1).reverse()) {
			const outcome = await this.owner.runTest(this.uri, { ...current, processor: step }, step.path, input);
			if (this.disposed) {
				return;
			}
			const result = outcome.result;
			if (result.kind === 'deleted') {
				this.owner.tell(previousDeleted(stepTitle(step)), 'error');
				return;
			}
			if (result.kind !== 'ok') {
				this.owner.tell(previousFailed(stepTitle(step), result.message), 'error');
				return;
			}
			input = { content: result.content, meta: inputMetaOf(result.meta) };
		}
		const after = this.document();
		if (!after || after.version !== version) {
			// The runs used the text as it was: their output may not be the steps' any more.
			this.owner.tell(PREVIOUS_FILE_CHANGED);
			return;
		}
		await this.addSeeded(fromPreviousSampleName(previous), input);
	}

	/**
	 * Adds `input` as a new selected sample named `base`, made unique against the file as it is then
	 * (4.18); a name taken meanwhile is made unique again once. Written: the panel gets `samples`.
	 */
	private async addSeeded(base: string, input: TestInput): Promise<void> {
		await this.labelling;
		await this.relinking;
		const ref = this.ref;
		if (!ref) {
			this.owner.tell(SAMPLES_WAIT_FOR_SAVE);
			await this.postSamples();
			return;
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			const state = await this.owner.samples.read(this.uri);
			if (state.kind === 'unreadable') {
				this.owner.tell(samplesUnreadable(state.reason), 'error');
				await this.postSamples();
				return;
			}
			const name = freeSampleName(base, samplesFor(state.file, ref).samples);
			const outcome = await this.owner.samples.update(this.uri, ref, { type: 'add', sample: { name, content: input.content, meta: input.meta } });
			if (outcome === 'written') {
				await this.postSamples();
				return;
			}
			if (typeof outcome === 'object') {
				await this.owner.samplesFailed(this.uri, outcome.failed);
				return;
			}
			if (outcome === 'unreadable') {
				// It became unreadable after the read: the next read says why.
				continue;
			}
			// 'unchanged': the name was taken between the read and the write.
		}
		const state = await this.owner.samples.read(this.uri);
		this.owner.tell(state.kind === 'unreadable' ? samplesUnreadable(state.reason) : couldNotSaveSamples(PREVIOUS_NAME_TAKEN), 'error');
		await this.postSamples();
	}

	/** Posts a snapshot (4.10: after a save moved its samples link). */
	async refresh(): Promise<void> {
		try {
			await this.postSnapshot();
		} catch (e) {
			this.fail(e);
		}
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
		// A save's relink in flight may change the samples link (4.10): read it once that is done.
		await this.relinking;
		if (this.disposed) {
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
		if (!this.ref) {
			this.owner.tell(couldNotAddLabel(LABEL_PROCESSOR_CHANGED), 'error');
			return;
		}
		const outcome = await this.owner.samples.relink(this.uri, this.ref, { label: name, path: this.path });
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
		// Add label's relink in flight changes the link (4.16): a read asked for meanwhile (a recreated
		// webview's `ready`) waits for it, else it would read the old link after the move.
		await this.labelling;
		// The link as it is when the read is asked for: the read is queued in that order (4.16).
		const ref = this.ref;
		if (!ref) {
			// No link (4.10): another live panel has it.
			return { samples: [], selected: null };
		}
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
		// A change during Add label's relink, or a save's (4.10), goes to the link that results (4.16).
		await this.labelling;
		await this.relinking;
		if (!this.ref) {
			// No link (4.10): nothing is saved, and the user is told; the webview gets the panel's state back.
			this.owner.tell(SAMPLES_WAIT_FOR_SAVE);
			await this.postSamples();
			return;
		}
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

	/** The processor the panel follows in the open document, now; none while removed. */
	private processor(): BloblangProcessor | undefined {
		return this.current().processor;
	}

	/**
	 * The processor the panel follows and the text of the open document, now: the one at its tracked
	 * path (4.10: the path follows every change); while the YAML doesn't parse, the last one found and
	 * its text; none while removed.
	 */
	private current(): Current {
		const doc = this.document();
		if (!doc || this.removed) {
			return { processor: undefined, text: '', processors: [] };
		}
		const parsed = parsedDocument(doc).parsed;
		if (!parses(parsed)) {
			return this.last ?? { processor: undefined, text: '', processors: [] };
		}
		const processors = bloblangProcessors(parsed);
		return { processor: bloblangProcessorByPath(processors, this.path), text: doc.getText(), processors };
	}

	/** Whether its open document doesn't parse now (4.10: everything stays as it is). */
	private frozen(): boolean {
		const doc = this.document();
		return doc !== undefined && !parses(parsedDocument(doc).parsed);
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
		if (this.hint && !this.removed && this.frozen()) {
			// The YAML doesn't parse (4.10): the hint stays where it is until it does.
			return;
		}
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
		this.setHint(line);
	}

	/** Puts its hint on 0-based `line` of its file, or clears it (`undefined`). */
	private setHint(line: number | undefined): void {
		this.hintLine = line;
		this.owner.hints.set(this.hintKey, this.uri, line);
	}

	/** `uri#path` of the processor it follows now (4.10). */
	get key(): string {
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
		this.setHint(undefined);
		this.subscription.dispose();
		this.watch.dispose();
	}
}

/** All open Bloblang test panels, one per mapping processor. */
export class BloblangPanels implements vscode.Disposable {
	/** The open panels; each one's key follows its processor (4.10), so they are looked up by it. */
	private readonly panels = new Set<BloblangPanel>();
	/** The documents with panels that have unsaved changes, from change and save events (4.10). */
	private readonly dirty = new Set<string>();
	/**
	 * Renames announced by `onWillRenameFiles` and not done yet (4.17): their files' tabs closing is no
	 * close. One never reported expires (4.13).
	 */
	private readonly pendingRenames: PendingRenames;
	/** Panel creations run one at a time (4.17): each one's placement sees the groups the last one left. */
	private queue: Promise<unknown> = Promise.resolve();
	private readonly subscriptions: vscode.Disposable[];
	/** The end-of-line hints of all panels: one decoration type (4.8). */
	readonly hints = new BloblangHints();
	/** The configs' samples files (4.9). */
	readonly samples: SampleStore;

	constructor(private readonly options: BloblangPanelsOptions) {
		this.samples = new SampleStore((line) => this.log(line));
		this.pendingRenames = new PendingRenames(options.pendingRenameMs ?? PENDING_RENAME_MS);
		this.subscriptions = [
			// An outside edit of a samples file (4.9): its config's panels get `samples`.
			this.samples.onDidChange((config) => {
				for (const entry of this.panelsOf(config)) {
					void entry.postSamples();
				}
			}),
			// The shown Bloblang follows edits, so it always matches what the next run uses; each panel
			// follows its processor (4.10).
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (e.contentChanges.length === 0) {
					return;
				}
				const entries = this.panelsOf(e.document.uri);
				if (entries.length === 0) {
					return;
				}
				const changes: TextChange[] = e.contentChanges.map((c) => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text }));
				if (e.document.isDirty) {
					this.dirty.add(e.document.uri.toString());
				} else {
					this.dirty.delete(e.document.uri.toString());
				}
				for (const entry of entries) {
					entry.mapThrough(changes);
				}
				this.match(e.document, entries);
			}),
			// A save moves the samples of the panels whose processor's link changed (4.10).
			vscode.workspace.onDidSaveTextDocument((doc) => {
				this.dirty.delete(doc.uri.toString());
				for (const entry of this.panelsOf(doc.uri)) {
					entry.markSaved();
				}
				void this.relinkOnSave(doc.uri);
			}),
			// Closed with unsaved changes (4.10): each panel resets to its saved position, matched by it on reopen.
			vscode.workspace.onDidCloseTextDocument((doc) => {
				// A rename closes the old document (4.17): its panels move, they are not reset.
				if (this.renaming(doc.uri.toString())) {
					return;
				}
				if (this.dirty.delete(doc.uri.toString())) {
					for (const entry of this.panelsOf(doc.uri)) {
						entry.reset();
					}
				}
			}),
			vscode.workspace.onDidOpenTextDocument((doc) => {
				const entries = this.panelsOf(doc.uri);
				if (entries.some((entry) => entry.isReset)) {
					this.match(doc, entries);
				}
			}),
			// The no-binary state (4.15): every panel hears each binary change.
			options.binary.onDidChange(() => {
				for (const entry of this.panels.values()) {
					void entry.binaryChanged();
				}
			}),
			// TAB_CLOSE (4.17): a panel whose file had a text tab and has none left closes.
			vscode.window.tabGroups.onDidChangeTabs(() => this.tabsChanged()),
			vscode.workspace.onWillRenameFiles((e) => {
				this.pendingRenames.announce(e.files.map((f) => ({ from: f.oldUri.toString(), to: f.newUri.toString() })));
			}),
			vscode.workspace.onDidRenameFiles((e) => this.renamed(e.files)),
		];
	}

	/** Whether a pending rename renames `key` (the file itself, or a folder holding it) (4.17). */
	private renaming(key: string): boolean {
		return this.pendingRenames.renaming(key);
	}

	/**
	 * A panel whose file had a text tab and has none left closes (4.17, TAB_CLOSE); a renaming file is
	 * skipped, and so is a file a pending rename overwrites (its tab comes back with the rename, and
	 * its panel stays: COLLISION closes the incoming one).
	 */
	private tabsChanged(): void {
		for (const entry of [...this.panels]) {
			const key = entry.uri.toString();
			if (hasTextTab(key)) {
				entry.hadTab = true;
			} else if (entry.hadTab && !this.renaming(key) && !this.pendingRenames.creating(key)) {
				entry.panel.dispose();
			}
		}
	}

	/**
	 * RENAME (4.17): each panel of a renamed config (the file itself, or a folder holding it) moves to
	 * the new URI, as the graph's do (the batch is applied as a whole, `renamedThrough`); a panel
	 * landing on the key of a panel not moved closes (COLLISION). The dirty set follows, a single
	 * file's samples file is renamed, and the moved panels get a snapshot with the new names.
	 */
	private renamed(files: readonly { readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri }[]): void {
		const renames = files.map((f) => ({ from: f.oldUri.toString(), to: f.newUri.toString() }));
		this.pendingRenames.report(renames);
		const moved = (key: string) => renamedThrough(key, renames);
		const entries = [...this.panels];
		const staying = new Set(entries.filter((entry) => moved(entry.uri.toString()) === undefined).map((entry) => entry.key));
		const movers: { readonly entry: BloblangPanel; readonly uri: vscode.Uri }[] = [];
		const configs = new Map<string, string>();
		for (const entry of entries) {
			const from = entry.uri.toString();
			const to = moved(from);
			if (to === undefined) {
				continue;
			}
			const uri = vscode.Uri.parse(to);
			if (staying.has(keyOf(uri, entry.path))) {
				entry.panel.dispose();
				continue;
			}
			configs.set(from, to);
			movers.push({ entry, uri });
		}
		// The store's names follow first (before the old watches go, which would drop its cache), and
		// the samples file's move is queued before the reads the moved panels ask for.
		for (const [from, to] of configs) {
			this.samples.rekey(vscode.Uri.parse(from), vscode.Uri.parse(to));
		}
		movers.forEach(({ entry, uri }) => entry.moveTo(uri));
		const dirty = [...this.dirty];
		this.dirty.clear();
		dirty.forEach((key) => this.dirty.add(moved(key) ?? key));
		for (const f of files) {
			void this.moveSamples(f.oldUri, f.newUri);
		}
		for (const { entry } of movers) {
			void entry.refresh();
		}
		this.tabsChanged();
	}

	/**
	 * A single file's rename moves its samples file to the new config's name (4.17); when that one
	 * exists already, both are left and the user is told.
	 */
	private async moveSamples(from: vscode.Uri, to: vscode.Uri): Promise<void> {
		const outcome = await this.samples.moveFile(from, to);
		if (outcome === 'exists') {
			const target = samplesUri(to);
			this.tell(samplesNotMoved(target ? path.posix.basename(target.path) : ''));
		}
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
		return [...this.panels].filter((entry) => entry.uri.toString() === key);
	}

	/**
	 * Matches `entries` (all the panels of `doc`) to its processors (4.10), when it parses; then each
	 * panel posts what changed. A panel back from the removed state whose samples link a live panel has
	 * is left with none, so two live panels never share one.
	 */
	private match(doc: vscode.TextDocument, entries: readonly BloblangPanel[]): void {
		const parsed = parsedDocument(doc).parsed;
		if (parses(parsed)) {
			try {
				const wasLive = new Set(entries.filter((entry) => !entry.removed && !entry.isReset));
				const processors = bloblangProcessors(parsed);
				const found = matchProcessors(processors, entries.map((entry) => entry.tracked()));
				const text = doc.getText();
				entries.forEach((entry, i) => entry.follow(found[i], text, processors));
				if (!doc.isDirty) {
					entries.forEach((entry) => entry.markSaved());
				}
				const links = new Set([...wasLive].filter((entry) => !entry.removed && entry.ref).map((entry) => linkOf(entry.ref!)));
				for (const entry of entries) {
					if (!wasLive.has(entry) && !entry.removed && entry.ref) {
						if (links.has(linkOf(entry.ref))) {
							this.log(`Test mapping: ${entry.panel.title}: another panel has the samples of ${linkName(entry.ref)}.`);
							entry.ref = undefined;
						} else {
							links.add(linkOf(entry.ref));
						}
					}
				}
			} catch (err) {
				this.log(`Test mapping: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		for (const entry of entries) {
			void entry.documentChanged();
		}
	}

	/** The panel following the processor at `processorPath` of `uri` (4.10: a removed panel never is). */
	private live(uri: vscode.Uri, processorPath: string): BloblangPanel | undefined {
		const key = keyOf(uri, processorPath);
		return [...this.panels].find((entry) => !entry.removed && entry.key === key);
	}

	/**
	 * `uri` was saved (4.10): all its panels whose processor's link differs from their samples link
	 * move their entries to it in one step (`relinkAll`); one whose link is still taken, by another
	 * entry or another live panel, keeps its old link and says so. A removed panel whose link another
	 * panel took is left with none. Once something moved, every panel of the config gets the file's
	 * samples (a moved one, a snapshot: its offer may change).
	 */
	private async relinkOnSave(uri: vscode.Uri): Promise<void> {
		if (samplesUri(uri) === undefined) {
			return;
		}
		const entries = this.panelsOf(uri);
		const releases = await Promise.all(entries.map((entry) => entry.hold()));
		const moved = new Set<BloblangPanel>();
		try {
			const live = entries.filter((entry) => !entry.removed && !entry.isReset && this.panels.has(entry));
			const movers: BloblangPanel[] = [];
			const moves: RelinkMove[] = [];
			const held: SampleRef[] = [];
			for (const entry of live) {
				const to = entry.link();
				if (entry.ref && linkOf(entry.ref) === linkOf(to)) {
					// The same link: only its path is brought up to date (the reset on close uses it).
					entry.ref = to;
					held.push(to);
				} else {
					movers.push(entry);
					moves.push({ from: entry.ref, to });
				}
			}
			if (moves.length === 0) {
				return;
			}
			const outcome = await this.samples.relinkAll(uri, moves, held);
			movers.forEach((entry, i) => {
				if (outcome.applied[i]) {
					entry.ref = moves[i].to;
					moved.add(entry);
				} else if (outcome.error !== undefined || outcome.hadEntry[i]) {
					// A panel with no samples to move keeps its link silently.
					this.tell(couldNotMoveSamples(linkName(moves[i].to), outcome.error ?? SAMPLES_USE_IT), 'error');
				}
			});
			const links = new Set(live.flatMap((entry) => (entry.ref ? [linkOf(entry.ref)] : [])));
			for (const entry of entries) {
				if (!live.includes(entry) && entry.ref && links.has(linkOf(entry.ref))) {
					entry.ref = undefined;
				}
			}
		} catch (e) {
			this.log(`Test mapping: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			releases.forEach((release) => release());
		}
		if (moved.size > 0) {
			await Promise.all(entries.map((entry) => (moved.has(entry) ? entry.refresh() : entry.postSamples())));
		}
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
		return this.enqueue(() => this.open(uri, processorPath));
	}

	private enqueue<T>(run: () => Promise<T>): Promise<T> {
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => undefined);
		return next;
	}

	/** `show`, one at a time. */
	private async open(uri: vscode.Uri, processorPath: string): Promise<BloblangPanelHandle | undefined> {
		const open = this.live(uri, processorPath);
		if (open) {
			open.panel.reveal(undefined, true);
			return open;
		}
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
		const processors = doc && this.options.detection.isDetected(uri) ? bloblangProcessors(parsedDocument(doc).parsed) : [];
		const processor = bloblangProcessorByPath(processors, processorPath);
		if (!processor) {
			this.tell(NO_LONGER_THERE);
			return undefined;
		}
		const title = bloblangTitle(processor);
		const yamlColumn = editorColumnOf(uri);
		const placed = await this.placement(uri, yamlColumn);
		const panel = vscode.window.createWebviewPanel(
			BLOBLANG_VIEW_TYPE,
			title,
			{ viewColumn: placed.column, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, 'dist')],
			},
		);
		const entry = new BloblangPanel(uri, processor, doc!.getText(), processors, panel, this);
		if (doc!.isDirty) {
			this.dirty.add(uri.toString());
		}
		this.panels.add(entry);
		panel.onDidDispose(() => {
			entry.dispose();
			this.panels.delete(entry);
		});
		// The file's name, for the error cards' "<file> line F" (4.8), and its samples file's (4.9).
		const samplesFile = samplesUri(uri);
		panel.webview.html = webviewHtml(panel.webview, this.options.extensionUri, 'bloblang', title, {
			file: path.posix.basename(uri.path),
			...(samplesFile ? { samples: path.posix.basename(samplesFile.path) } : {}),
		});
		// A new group took focus: it goes back to the YAML editor, in its column now (a group created
		// before the YAML's renumbers the columns after it).
		const returnTo = !placed.movedFocus || yamlColumn === undefined ? undefined
			: placed.created !== undefined && yamlColumn >= placed.created ? (yamlColumn + 1) as vscode.ViewColumn : yamlColumn;
		if (doc && returnTo !== undefined) {
			await this.returnFocus(doc, returnTo);
		}
		return entry;
	}

	/**
	 * Gives focus back to `doc` in `column` (4.17) and confirms it (4.13, PLACE_FOCUS; the bug-15
	 * pattern): it waits up to `FOCUS_WAIT_MS` for the YAML to be the active editor in that column,
	 * then `FOCUS_SETTLE_MS` more and checks again, since the new group's late activation can take
	 * focus after the return; if focus is not there, it is returned once more and confirmed again
	 * (about 1 s in all). A miss after that is logged.
	 */
	private async returnFocus(doc: vscode.TextDocument, column: vscode.ViewColumn): Promise<void> {
		const focused = () => {
			const active = vscode.window.activeTextEditor;
			return active?.document === doc && active.viewColumn === column;
		};
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				await vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus: false });
				if (await until(focused, FOCUS_WAIT_MS)) {
					await new Promise((r) => setTimeout(r, FOCUS_SETTLE_MS));
					if (focused()) {
						return;
					}
				}
			}
			this.log('Test mapping: focus did not stay in the YAML.');
		} catch (e) {
			this.log(`Test mapping: could not return focus to the YAML: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * Where a new panel goes (4.17, AD-1): the test group, if there is one; else, with the file's
	 * graph open (or a graph's group beside the YAML), a new group below the graph's group; else
	 * beside the YAML. `movedFocus`: focus moved to another group; `created`: the column of a group
	 * created for it.
	 */
	private async placement(
		uri: vscode.Uri, yamlColumn: vscode.ViewColumn | undefined,
	): Promise<{ readonly column: vscode.ViewColumn; readonly movedFocus: boolean; readonly created?: vscode.ViewColumn }> {
		const groups = vscode.window.tabGroups;
		const testGroup = groups.all.find(isTestGroup);
		if (testGroup) {
			return { column: testGroup.viewColumn, movedFocus: false };
		}
		let graph: vscode.ViewColumn | undefined;
		try {
			graph = this.options.graphColumn?.(uri);
		} catch (e) {
			this.log(`Test mapping: ${e instanceof Error ? e.message : String(e)}`);
		}
		if (graph === undefined || graph === yamlColumn) {
			// Never into a graph's group: `Beside` would land in the one right of the active group.
			const beside = groups.all.find((g) => g.viewColumn === groups.activeTabGroup.viewColumn + 1);
			graph = beside && holdsGraph(beside) ? beside.viewColumn : undefined;
		}
		if (graph !== undefined) {
			const below = await newGroupNextTo(graph, 'below');
			if (below !== undefined) {
				// The new group's column: the groups from it on (the YAML's, maybe) are one further now.
				return { column: below, movedFocus: true, created: below };
			}
			this.log('Test mapping: could not open a group below the graph.');
			return { column: vscode.ViewColumn.Beside, movedFocus: true };
		}
		return { column: vscode.ViewColumn.Beside, movedFocus: false };
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

	/**
	 * Esc in the panel (4.11): shows `uri` in its editor group (`editorColumnOf`) and the editor takes
	 * focus; the cursor and selection stay as they were. With no editor or tab of it, nothing happens
	 * (as the graph's).
	 */
	async focusEditor(uri: vscode.Uri): Promise<void> {
		const column = editorColumnOf(uri);
		if (column === undefined) {
			return;
		}
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) ?? await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus: false });
	}

	/** The end-of-line hints' current ranges in `uri` (test seam: decorations can't be read back). */
	hintRanges(uri: vscode.Uri): vscode.Range[] {
		return this.hints.ranges(uri);
	}

	/**
	 * The open panel of the processor at `processorPath` of `uri`, if any; else a removed panel whose
	 * last path it is (4.10) (test seam).
	 */
	panelFor(uri: vscode.Uri, processorPath: string): BloblangPanelHandle | undefined {
		const key = keyOf(uri, processorPath);
		return this.live(uri, processorPath) ?? [...this.panels].find((entry) => entry.key === key);
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

/** The column of a visible editor of `uri`, else of a group with a tab of it (4.17: focus returns there). */
function editorColumnOf(uri: vscode.Uri): vscode.ViewColumn | undefined {
	const key = uri.toString();
	const groups = vscode.window.tabGroups;
	if (isTextTabOf(groups.activeTabGroup.activeTab, key)) {
		return groups.activeTabGroup.viewColumn;
	}
	return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key && e.viewColumn !== undefined)?.viewColumn
		?? groups.all.find((g) => g.tabs.some((t) => isTextTabOf(t, key)))?.viewColumn;
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

/** The previous step's title (4.18): of the processor just before `current`'s in its own list; none: no such step. */
function previousStepOf(current: Current): string | undefined {
	const step = current.processor ? previousSteps(current.processors, current.processor.path)[0] : undefined;
	return step ? stepTitle(step) : undefined;
}

/** What links a processor to its samples (4.18): its label, else its path (AD-22). */
function linkOfProcessor(processor: BloblangProcessor): SampleRef {
	return processor.label !== undefined ? { label: processor.label, path: processor.path } : { path: processor.path };
}

/** A samples link as messages name it (4.10): its label, else its path. */
function linkName(ref: SampleRef): string {
	return ref.label ?? ref.path;
}

function keyOf(uri: vscode.Uri, processorPath: string): string {
	return `${uri.toString()}#${processorPath}`;
}
