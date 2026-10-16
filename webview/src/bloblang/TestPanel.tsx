// The Bloblang test panel's view (tickets 4.2, 4.7), after the prototype's success layout: a header
// with the title, the kind and a status pill; a toolbar with Run on change (on by default) and Run;
// an Input column (Content and Metadata tabs) and an Output column (Content and Metadata tabs, the
// added or changed fields and keys marked, and a "Changed:" footer). Each run posts
// `run {content, meta}`: from Run at once, or with Run on change 300 ms after the last content or
// metadata edit, or after a snapshot whose kind or source differs (an empty content runs nothing). The
// host answers with `result`. Ticket 4.8: every other result has its card and status pill (a parse
// error, a mapping failure, an invalid input, a deleted message, a run that could not happen); Go to
// line posts `goToLine {line}`; and the last `ok` output stays, dimmed, under an error card.
// Ticket 4.15: while the binary's status (the snapshot's, then each `binary` message) is not `ok`,
// the no-binary state replaces the pill, the toolbar and the columns, its Install guide, Set path
// and Retry post the binary intents, nothing runs and no result shows; it is announced once in the
// polite live region. Focus inside the panel moves to the state's region on entry, and from the
// region back to the input on exit. The input stays in view state. When the status becomes `ok`
// again the current input runs once, whatever Run on change says. Anything that fails
// `parseBloblangHostMessage` is ignored. The last `ok` result is view state too, so a recreated
// panel whose restored run fails still dims it. It runs nothing itself (AD-3): the input, the tabs
// and the toggle are view state, kept by the host page across reloads.
// Ticket 4.9: with a samples file (`samplesFile`, the page's `data-samples`; none for an untitled
// config, whose controls are hidden and whose samples are ignored), the toolbar has the sample
// controls (`SamplePicker.tsx`) and, while the mapping has samples, "Saved in <file>". The snapshot
// and each `samples` message bring the host's samples: when the selected sample is another one, or
// its content or metadata differs from the input, the input becomes the sample's (a pending edit of
// the same sample wins) and runs (another sample: always; the same one: with Run on change). Switching
// posts `sampleSwitched`, takes the sample's input and runs it; New sample with no samples saves the
// input as "sample 1" (`sampleAdded`, then `inputEdited`), else adds an empty "sample N" and runs
// nothing; Rename posts `sampleRenamed`; Delete posts `sampleDeleted` and the host's `samples` follows
// a confirmed delete. An edit of a selected sample posts `inputEdited` after the run's pause (and before
// any other sample intent). While the file can't be read (`samplesError`), the controls are disabled.
// The selected sample's input is mirrored into the view state, as any input.
// Ticket 4.16: while the snapshot says the processor is unlabelled (`unlabelledPath`) and the config
// has a samples file, a note under the toolbar says its samples are linked to its position, with
// **Add label**, which posts `addLabelRequested` (the host asks for the name and sends a new snapshot).
// Ticket 4.10: while the snapshot says the processor was removed (`removed`), the header stays and
// a notice replaces the toolbar and the columns (and the no-binary state): "This processor was removed
// from <file>. Undo the change to bring it back." Nothing runs, a pending run is cancelled, the last
// result is cleared (as entering the no-binary state) and a result arriving meanwhile is dropped;
// the input and the samples stay. A snapshot without `removed` brings the panel back and runs the
// input once, with Run on change on.
// Ticket 4.17: the snapshot's `fileName` and `samplesFile`, when present, win over the page's
// `data-file` and `data-samples` (a rename of the config changes them).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
	parseBloblangHostMessage, type BinaryStatus, type BloblangHostMessage, type BloblangSample, type BloblangWebviewMessage, type InputMeta,
} from '../../../src/shared/bloblangProtocol';
import { inputMeta, metaRowCount, type MetaRow } from './changes';
import { nextSampleName, SamplePicker } from './SamplePicker';
import type { PanelTab, ViewState } from './host';
import { InputMetadata, type EditableRow } from './MetadataTable';
import { DEFAULT_FILE_NAME, OutputBody, ResultFooter, type OkResult } from './OutputView';

/** How long edits pause before Run on change runs the input. */
export const RUN_DEBOUNCE_MS = 300;
export const INPUT_LABEL = 'Input';
export const OUTPUT_LABEL = 'Output';
export const CONTENT_TAB = 'Content';
export const METADATA_TAB = 'Metadata';
export const RUN_LABEL = 'Run';
export const RUN_ON_CHANGE_LABEL = 'Run on change';
export const RUNNING_TEXT = 'Running…';
export const EMPTY_TEXT = 'Type the message content to run the mapping on it.';
/** The no-binary state's title (its region's name) and text (prototype, 4.15). */
export const NO_BINARY_TITLE = 'No Redpanda Connect binary';
export const NO_BINARY_TEXT = 'The test panel runs mappings with your own binary, so results match the version you deploy.';
/** The no-binary state's buttons, in order, and the intent each posts: the graph's (`NO_BINARY_ACTIONS` of `../state`). */
export const NO_BINARY_ACTIONS = [
	{ label: 'Install guide', message: { type: 'installGuideRequested' } },
	{ label: 'Set path', message: { type: 'setPathRequested' } },
	{ label: 'Retry', message: { type: 'retryRequested' } },
] as const satisfies readonly { readonly label: string; readonly message: BloblangWebviewMessage }[];

/** The unreadable samples file's message (4.9), before its reason. */
export const SAMPLES_ERROR_PREFIX = 'The samples file can\'t be read: ';
/** The "Saved in <file>" line (4.9). */
export const savedIn = (file: string): string => `Saved in ${file}`;

/** The unlabelled processor's note (4.16), around its path, and its button. */
export const NO_LABEL_BEFORE = 'No label: samples are linked to this processor\'s position (';
export const NO_LABEL_AFTER = ') and are lost if it moves.';
export const ADD_LABEL_LABEL = 'Add label';

/** The removed processor's notice (4.10): its region's name and its text. */
export const REMOVED_TITLE = 'Processor removed';
export const removedText = (file: string): string => `This processor was removed from ${file}. Undo the change to bring it back.`;

/** Whether `content` and `rows` are the sample's input. */
function isSampleInput(sample: BloblangSample, content: string, rows: readonly MetaRow[]): boolean {
	const meta = inputMeta(rows);
	const keys = Object.keys(meta);
	return sample.content === content && keys.length === Object.keys(sample.meta).length
		&& keys.every((k) => Object.prototype.hasOwnProperty.call(sample.meta, k) && sample.meta[k] === meta[k]);
}

/** Whether `status` is the no-binary state: known and not `ok`. */
const noBinaryIn = (status: BinaryStatus | null): boolean => status !== null && status !== 'ok';

type Snapshot = Extract<BloblangHostMessage, { type: 'snapshot' }>;
type Result = Extract<BloblangHostMessage, { type: 'result' }>;

export interface TestPanelProps {
	readonly post: (message: BloblangWebviewMessage) => void;
	/** The view state saved by an earlier load of the panel. */
	readonly initialState: ViewState;
	readonly saveState: (state: ViewState) => void;
	/** The YAML file's name, for the error cards (`data-file` of the page's root); the snapshot's `fileName` wins (4.17). */
	readonly fileName?: string;
	/** The samples file's name (`data-samples`, 4.9); none: no sample controls. The snapshot's `samplesFile` wins (4.17). */
	readonly samplesFile?: string;
}

type Tone = 'ok' | 'err' | 'warn' | 'running';

/** The status pill's text and tone for the last result (4.7, 4.8). */
export function statusOf(result: Result): { text: string; tone: Tone } {
	const ms = Math.round(result.durationMs);
	switch (result.result.kind) {
		case 'ok':
			return { text: `✓ Ran in ${ms} ms${result.binary ? ` · ${result.binary}` : ''}`, tone: 'ok' };
		case 'parseError':
			return { text: '✕ Syntax error · not run', tone: 'err' };
		case 'failed':
			return { text: '✕ Mapping failed on this input', tone: 'err' };
		case 'invalidInput':
			return { text: '✕ Input not valid for this mapping', tone: 'err' };
		case 'deleted':
			return { text: `⊘ Message deleted · ${ms} ms`, tone: 'warn' };
		case 'error':
			return { text: '✕ Not run', tone: 'err' };
	}
}

interface TabsProps {
	readonly id: string;
	readonly label: string;
	readonly selected: PanelTab;
	readonly count: string;
	readonly onSelect: (tab: PanelTab) => void;
}

/** A column's heading and its Content / Metadata tabs; the Metadata tab shows `count`. */
function ColumnHead({ id, label, selected, count, onSelect }: TabsProps) {
	return (
		<div className="rpcn-bl-colhead">
			<h2 className="rpcn-bl-colname" id={`${id}-name`}>{label}</h2>
			<div role="tablist" aria-labelledby={`${id}-name`} className="rpcn-bl-tabs">
				<button
					type="button" role="tab" id={`${id}-tab-content`} aria-controls={`${id}-panel`}
					className="rpcn-bl-tab" aria-selected={selected === 'content'} onClick={() => onSelect('content')}
				>
					{CONTENT_TAB}
				</button>
				<button
					type="button" role="tab" id={`${id}-tab-meta`} aria-controls={`${id}-panel`}
					className="rpcn-bl-tab" aria-selected={selected === 'meta'} onClick={() => onSelect('meta')}
				>
					{METADATA_TAB}<span className="rpcn-bl-badge">{count}</span>
				</button>
			</div>
		</div>
	);
}

function lineCount(text: string): string {
	const lines = text === '' ? 0 : text.split('\n').length;
	let json = false;
	try {
		JSON.parse(text);
		json = true;
	} catch {
		// Not JSON: the count alone.
	}
	return `${lines} ${lines === 1 ? 'line' : 'lines'}${json ? ' · JSON' : ''}`;
}

/** The no-binary state (4.15, the prototype's): the named region, its text and the binary actions. */
function NoBinaryView({ post }: { readonly post: (message: BloblangWebviewMessage) => void }) {
	return (
		<section className="rpcn-bl-nobin" role="region" aria-label={NO_BINARY_TITLE} tabIndex={0}>
			<p className="rpcn-bl-nobin-title">{NO_BINARY_TITLE}</p>
			<p className="rpcn-bl-nobin-text">{NO_BINARY_TEXT}</p>
			<div className="rpcn-bl-nobin-acts">
				{NO_BINARY_ACTIONS.map(({ label, message }, i) => (
					<button
						key={label} type="button" className={`rpcn-bl-nobin-act${i === 0 ? ' rpcn-bl-nobin-primary' : ''}`}
						onClick={() => post(message)}
					>
						{label}
					</button>
				))}
			</div>
		</section>
	);
}

export function TestPanel({ post, initialState, saveState, fileName: pageFile, samplesFile: pageSamples }: TestPanelProps) {
	const nextId = useRef(0);
	const withId = (row: MetaRow): EditableRow => ({ id: nextId.current++, key: row.key, value: row.value });
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [content, setContent] = useState(initialState.content);
	const [rows, setRows] = useState<readonly EditableRow[]>(() => initialState.meta.map(withId));
	const [inputTab, setInputTab] = useState<PanelTab>(initialState.inputTab);
	const [outputTab, setOutputTab] = useState<PanelTab>(initialState.outputTab);
	const [runOnChange, setRunOnChange] = useState(initialState.runOnChange);
	const [result, setResult] = useState<Result | null>(null);
	/** The last `ok` result since the panel opened: shown dimmed under an error card. */
	const [lastOk, setLastOk] = useState<OkResult | undefined>(initialState.lastOk);
	const [running, setRunning] = useState(false);
	const [focusRow, setFocusRow] = useState<number | undefined>(undefined);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	/** The latest input and toggle, for timers and host messages. */
	const latest = useRef({ content, rows, runOnChange });
	latest.current = { content, rows, runOnChange };
	/** Whether the restored input has had its chance to run since the first snapshot. */
	const restoredRun = useRef(false);
	/** The kind and source of the last snapshot; `undefined`: none yet. */
	const lastSource = useRef<string | undefined>(undefined);
	/** The binary's status as the host last reported it; `null`: not yet (4.15). */
	const [binary, setBinary] = useState<BinaryStatus | null>(null);
	/** The same, for timers and host messages. */
	const binaryNow = useRef<BinaryStatus | null>(null);
	/** Whether the last snapshot said the processor was removed (4.10), for timers and host messages. */
	const removedNow = useRef(false);
	const main = useRef<HTMLElement>(null);
	/** Where focus goes once the state has rendered (4.15): the region, the input, or nowhere. */
	const moveFocus = useRef<'region' | 'input' | undefined>(undefined);
	/** The mapping's samples, the selected one and the unreadable file's reason, as last known (4.9). */
	const [samples, setSamples] = useState<{ list: readonly BloblangSample[]; selected: string | null; error?: string }>({ list: [], selected: null });
	/** The same, for timers and host messages. */
	const samplesNow = useRef(samples);
	/** The pending save of the selected sample's edit (4.9). */
	const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	// The snapshot's names win over the page's (4.17: a rename changes them after the first paint).
	const fileName = snapshot?.fileName ?? pageFile;
	const samplesFile = snapshot?.samplesFile ?? pageSamples;
	const hasSamples = samplesFile !== undefined;

	/** Sets the samples state and its mirror. */
	const putSamples = useCallback((next: { list: readonly BloblangSample[]; selected: string | null; error?: string }) => {
		samplesNow.current = next;
		setSamples(next);
	}, []);

	/** Posts the pending edit of the selected sample now, and keeps it in the samples' copy (4.9). */
	const flushSave = useCallback(() => {
		if (saveTimer.current === undefined) {
			return;
		}
		clearTimeout(saveTimer.current);
		saveTimer.current = undefined;
		const { list, selected, error } = samplesNow.current;
		if (selected === null || error !== undefined) {
			return;
		}
		const content = latest.current.content;
		const meta: InputMeta = inputMeta(latest.current.rows);
		putSamples({ list: list.map((s) => (s.name === selected ? { ...s, content, meta } : s)), selected });
		post({ type: 'inputEdited', content, meta });
	}, [post, putSamples]);

	/** With a sample selected, saves the input after the run's pause (4.9). */
	const scheduleSave = useCallback(() => {
		clearTimeout(saveTimer.current);
		saveTimer.current = undefined;
		if (hasSamples && samplesNow.current.selected !== null && samplesNow.current.error === undefined) {
			saveTimer.current = setTimeout(flushSave, RUN_DEBOUNCE_MS);
		}
	}, [hasSamples, flushSave]);

	/** Makes `sample` the input: its content and metadata rows (4.9). */
	const takeInput = useCallback((sample: Pick<BloblangSample, 'content' | 'meta'>) => {
		const nextRows = Object.entries(sample.meta).map(([key, value]) => withId({ key, value }));
		latest.current = { ...latest.current, content: sample.content, rows: nextRows };
		setContent(sample.content);
		setRows(nextRows);
		if (sample.content === '') {
			clearTimeout(timer.current);
			timer.current = undefined;
			setResult(null);
			setRunning(false);
		}
	// `withId` only reads a ref.
	}, []);

	/**
	 * Takes the host's samples (4.9). The input becomes the selected sample's when it is another
	 * sample, or the same one with another input and no edit pending: `switched` or `edited`.
	 */
	const takeSamples = useCallback((message: { samples: readonly BloblangSample[]; selected: string | null; samplesError?: string }): 'switched' | 'edited' | undefined => {
		if (!hasSamples) {
			return undefined;
		}
		const before = samplesNow.current.selected;
		putSamples({
			list: message.samples, selected: message.selected, ...(message.samplesError !== undefined ? { error: message.samplesError } : {}),
		});
		const sample = message.samples.find((s) => s.name === message.selected);
		if (!sample || isSampleInput(sample, latest.current.content, latest.current.rows)) {
			return undefined;
		}
		const switched = message.selected !== before;
		if (!switched && saveTimer.current !== undefined) {
			// The user's pending edit of this sample wins; it is saved next.
			return undefined;
		}
		clearTimeout(saveTimer.current);
		saveTimer.current = undefined;
		takeInput(sample);
		return switched ? 'switched' : 'edited';
	}, [hasSamples, putSamples, takeInput]);

	useEffect(() => {
		saveState({
			content, meta: rows.map(({ key, value }) => ({ key, value })), inputTab, outputTab, runOnChange, ...(lastOk ? { lastOk } : {}),
		});
	}, [saveState, content, rows, inputTab, outputTab, runOnChange, lastOk]);

	const cancel = () => {
		clearTimeout(timer.current);
		timer.current = undefined;
	};

	/** Runs the latest input now (an empty content runs nothing). */
	const runNow = useCallback(() => {
		clearTimeout(timer.current);
		timer.current = undefined;
		const { content: text, rows: current } = latest.current;
		if (text === '' || noBinaryIn(binaryNow.current) || removedNow.current) {
			return;
		}
		setRunning(true);
		post({ type: 'run', content: text, meta: inputMeta(current) });
	}, [post]);

	/** With Run on change on and a content, runs the latest input after the pause. */
	const schedule = useCallback((text: string, on: boolean) => {
		clearTimeout(timer.current);
		timer.current = undefined;
		if (on && text !== '' && !noBinaryIn(binaryNow.current) && !removedNow.current) {
			timer.current = setTimeout(runNow, RUN_DEBOUNCE_MS);
		}
	}, [runNow]);

	/**
	 * Takes the host's binary `status` (4.15). Entering the no-binary state cancels the pending run
	 * and drops the result. Whether it left the state (not `ok` → `ok`): the caller then runs once.
	 */
	const binaryChanged = useCallback((status: BinaryStatus): boolean => {
		const before = binaryNow.current;
		binaryNow.current = status;
		setBinary(status);
		// The focused element is still the one about to unmount: decide where focus goes after the render.
		const focused = document.activeElement;
		if (noBinaryIn(status) !== noBinaryIn(before)) {
			const from = noBinaryIn(status) ? main.current : main.current?.querySelector('.rpcn-bl-nobin');
			moveFocus.current = focused && from?.contains(focused) ? (noBinaryIn(status) ? 'region' : 'input') : undefined;
		}
		if (noBinaryIn(status) && !noBinaryIn(before)) {
			clearTimeout(timer.current);
			timer.current = undefined;
			setResult(null);
			setRunning(false);
		}
		return noBinaryIn(before) && status === 'ok';
	}, []);

	useEffect(() => {
		const onMessage = (event: MessageEvent<unknown>) => {
			const message = parseBloblangHostMessage(event.data);
			if (message?.type === 'snapshot') {
				setSnapshot(message);
				// The removed state (4.10): entering it cancels the pending run; leaving it runs once (Run on change).
				const wasRemoved = removedNow.current;
				removedNow.current = message.removed === true;
				const back = wasRemoved && !removedNow.current;
				if (removedNow.current && !wasRemoved) {
					// As entering the no-binary state: the pending run and the last result go.
					clearTimeout(timer.current);
					timer.current = undefined;
					setResult(null);
					setRunning(false);
				}
				const taken = takeSamples(message);
				const recovered = binaryChanged(message.binary);
				// The kind and source last seen: a run follows a change of either.
				const seen = JSON.stringify([message.kind, message.source]);
				const first = lastSource.current === undefined;
				const sourceChanged = !first && lastSource.current !== seen;
				lastSource.current = seen;
				if (first && !restoredRun.current) {
					// A recreated panel runs its restored input once (with Run on change on), so the output is
					// back too; with no binary it does not (the recovery run brings it back).
					restoredRun.current = true;
					if (latest.current.runOnChange || recovered) {
						runNow();
					}
				} else if (removedNow.current) {
					// Nothing runs while removed.
				} else if (recovered || taken === 'switched' || (taken === 'edited' && latest.current.runOnChange)) {
					runNow();
				} else if (back) {
					if (latest.current.runOnChange) {
						runNow();
					}
				} else if (sourceChanged) {
					schedule(latest.current.content, latest.current.runOnChange);
				}
			} else if (message?.type === 'samples') {
				const taken = takeSamples(message);
				if (taken === 'switched' || (taken === 'edited' && latest.current.runOnChange)) {
					runNow();
				}
			} else if (message?.type === 'binary') {
				// Recovery runs the current input once, whatever Run on change says, so the panel is not left empty.
				if (binaryChanged(message.status)) {
					runNow();
				}
			} else if (message?.type === 'result' && (noBinaryIn(binaryNow.current) || removedNow.current)) {
				// A result arriving with no binary, or while removed (4.10), is dropped.
				setRunning(false);
			} else if (message?.type === 'result' && latest.current.content !== '') {
				// A result arriving after the content was cleared is dropped: the empty state stays.
				setResult(message);
				setRunning(false);
				if (message.result.kind === 'ok') {
					setLastOk(message.result);
				}
			}
		};
		// A pending save goes out before the page does (4.9).
		const onHide = () => flushSave();
		window.addEventListener('message', onMessage);
		window.addEventListener('pagehide', onHide);
		post({ type: 'ready' });
		return () => {
			window.removeEventListener('message', onMessage);
			window.removeEventListener('pagehide', onHide);
			clearTimeout(timer.current);
			flushSave();
		};
	}, [post, runNow, schedule, binaryChanged, takeSamples, flushSave]);

	const contentChanged = (text: string) => {
		setContent(text);
		latest.current = { ...latest.current, content: text };
		restoredRun.current = true;
		scheduleSave();
		if (text === '') {
			// An empty content runs nothing and shows the empty state again.
			cancel();
			setResult(null);
			setRunning(false);
			return;
		}
		schedule(text, runOnChange);
	};

	const rowsChanged = (next: readonly EditableRow[]) => {
		setRows(next);
		latest.current = { ...latest.current, rows: next };
		restoredRun.current = true;
		scheduleSave();
		schedule(content, runOnChange);
	};

	/** Picks another sample (4.9): its input, a run, and the choice saved. */
	const switchSample = (name: string) => {
		const sample = samples.list.find((s) => s.name === name);
		if (!sample) {
			return;
		}
		flushSave();
		putSamples({ ...samplesNow.current, selected: name });
		post({ type: 'sampleSwitched', name });
		takeInput(sample);
		runNow();
	};

	/** New sample (4.9): the input as "sample 1", else an empty "sample N"; nothing runs. */
	const newSample = () => {
		flushSave();
		const { list } = samplesNow.current;
		const name = nextSampleName(list);
		if (list.length === 0) {
			const sample = { name, content: latest.current.content, meta: inputMeta(latest.current.rows) };
			putSamples({ list: [sample], selected: name });
			post({ type: 'sampleAdded', name });
			post({ type: 'inputEdited', content: sample.content, meta: sample.meta });
			return;
		}
		putSamples({ list: [...list, { name, content: '', meta: {} }], selected: name });
		post({ type: 'sampleAdded', name });
		takeInput({ content: '', meta: {} });
	};

	const renameSample = (to: string) => {
		const { list, selected } = samplesNow.current;
		if (selected === null) {
			return;
		}
		flushSave();
		putSamples({ list: list.map((s) => (s.name === selected ? { ...s, name: to } : s)), selected: to });
		post({ type: 'sampleRenamed', from: selected, to });
	};

	const deleteSample = () => {
		const { selected } = samplesNow.current;
		if (selected === null) {
			return;
		}
		flushSave();
		post({ type: 'sampleDeleted', name: selected });
	};

	const toggleChanged = (on: boolean) => {
		setRunOnChange(on);
		if (!on) {
			cancel();
		}
	};

	const status = running ? { text: RUNNING_TEXT, tone: 'running' as const } : result ? statusOf(result) : undefined;
	const okResult = result?.result.kind === 'ok' ? result.result : undefined;
	const dimmed = result !== null && lastOk !== undefined && result.result.kind !== 'ok' && result.result.kind !== 'deleted';
	const goToLine = useCallback((line: number) => post({ type: 'goToLine', line }), [post]);
	const noBinary = noBinaryIn(binary);
	const removed = snapshot?.removed === true;

	useEffect(() => {
		const to = moveFocus.current;
		moveFocus.current = undefined;
		const root = main.current;
		const target = to === 'region'
			? root?.querySelector<HTMLElement>('.rpcn-bl-nobin')
			: to === 'input'
				// The content input; on the Metadata tab, Run, or the tab itself while Run is disabled.
				? ['#rpcn-bl-input', '.rpcn-bl-run:not(:disabled)', '#rpcn-bl-in-tab-meta'].map((q) => root?.querySelector<HTMLElement>(q)).find((el) => el)
				: undefined;
		target?.focus();
	}, [noBinary]);

	return (
		<main className="rpcn-bl" ref={main}>
			<header className="rpcn-bl-header">
				<div className="rpcn-bl-where">
					<h1 className="rpcn-bl-title">{snapshot?.title ?? 'Bloblang'}</h1>
					{snapshot && <span className="rpcn-bl-kind">{snapshot.kind}</span>}
				</div>
				{status && !noBinary && !removed && <span className={`rpcn-bl-pill rpcn-bl-pill-${status.tone}`} role="status">{status.text}</span>}
			</header>
			{/* The polite live region (4.15): always mounted; the no-binary state is announced once on entry. */}
			<div className="rpcn-bl-sr" role="status" aria-live="polite" aria-atomic="true">
				{removed ? removedText(fileName ?? DEFAULT_FILE_NAME) : noBinary ? `${NO_BINARY_TITLE}. ${NO_BINARY_TEXT}` : ''}
			</div>
			{removed
				? (
					<section className="rpcn-bl-removed" role="region" aria-label={REMOVED_TITLE}>
						<p className="rpcn-bl-removed-text">{removedText(fileName ?? DEFAULT_FILE_NAME)}</p>
					</section>
				)
				: noBinary
				? <NoBinaryView post={post} />
				: (
					<>
						<div className="rpcn-bl-toolbar">
							{hasSamples && (
								<SamplePicker
									samples={samples.list} selected={samples.selected} disabled={samples.error !== undefined}
									onSwitch={switchSample} onNew={newSample} onRename={renameSample} onDelete={deleteSample}
								/>
							)}
							<span className="rpcn-bl-spacer" />
							<label className="rpcn-bl-check">
								<input type="checkbox" className="rpcn-bl-auto" checked={runOnChange} onChange={(e) => toggleChanged(e.target.checked)} />
								{RUN_ON_CHANGE_LABEL}
							</label>
							<button type="button" className="rpcn-bl-run" disabled={content === ''} onClick={runNow}>{RUN_LABEL}</button>
							{hasSamples && samples.error !== undefined && (
								<p className="rpcn-bl-samples-error" role="alert">{SAMPLES_ERROR_PREFIX}{samples.error}</p>
							)}
							{hasSamples && samples.error === undefined && samples.list.length > 0 && (
								<p className="rpcn-bl-saved">{savedIn(samplesFile)}</p>
							)}
						</div>
						{hasSamples && snapshot?.unlabelledPath !== undefined && (
							<div className="rpcn-bl-labelnote" role="note">
								<p className="rpcn-bl-labelnote-text">
									{NO_LABEL_BEFORE}<code>{snapshot.unlabelledPath}</code>{NO_LABEL_AFTER}
								</p>
								<button type="button" className="rpcn-bl-btn rpcn-bl-addlabel" onClick={() => post({ type: 'addLabelRequested' })}>
									{ADD_LABEL_LABEL}
								</button>
							</div>
						)}
						<div className="rpcn-bl-io">
							<section className="rpcn-bl-col rpcn-bl-in" aria-label={INPUT_LABEL}>
								<ColumnHead id="rpcn-bl-in" label={INPUT_LABEL} selected={inputTab} count={String(metaRowCount(rows))} onSelect={setInputTab} />
								<div className="rpcn-bl-colbody" role="tabpanel" id="rpcn-bl-in-panel" aria-labelledby={`rpcn-bl-in-tab-${inputTab}`}>
									{inputTab === 'content'
										? (
											<textarea
												id="rpcn-bl-input"
												className="rpcn-bl-input"
												aria-label="Input content"
												spellCheck={false}
												rows={12}
												value={content}
												placeholder='{"a": 1}'
												onChange={(event) => contentChanged(event.target.value)}
											/>
										)
										: (
											<InputMetadata
												rows={rows}
												onChange={(i, row) => rowsChanged(rows.map((r, j) => (j === i ? { ...r, ...row } : r)))}
												onAdd={() => {
													const row = withId({ key: '', value: '' });
													setFocusRow(row.id);
													rowsChanged([...rows, row]);
												}}
												onRemove={(i) => rowsChanged(rows.filter((_, j) => j !== i))}
												focusId={focusRow}
												onFocused={() => setFocusRow(undefined)}
											/>
										)}
								</div>
								<footer className="rpcn-bl-foot">{lineCount(content)}</footer>
							</section>
							<section className="rpcn-bl-col rpcn-bl-out" aria-label={OUTPUT_LABEL} aria-live="polite">
								<ColumnHead
									id="rpcn-bl-out" label={OUTPUT_LABEL} selected={outputTab}
									count={okResult ? String(Object.keys(okResult.meta).length) : '–'} onSelect={setOutputTab}
								/>
								<div className="rpcn-bl-colbody" role="tabpanel" id="rpcn-bl-out-panel" aria-labelledby={`rpcn-bl-out-tab-${outputTab}`}>
									{result
										? (
											<OutputBody
												result={result.result} tab={outputTab} lastOk={lastOk}
												fileName={fileName ?? DEFAULT_FILE_NAME} onGoToLine={goToLine}
											/>
										)
										: <p className="rpcn-bl-note rpcn-bl-pad">{EMPTY_TEXT}</p>}
								</div>
								{result && <ResultFooter result={result.result} dimmed={dimmed} />}
							</section>
						</div>
					</>
				)}
		</main>
	);
}
