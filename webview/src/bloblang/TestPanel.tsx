// The Bloblang test panel's view (tickets 4.2, 4.7), after the prototype's success layout: a header
// with the title, the kind and a status pill; a toolbar with Run on change (on by default) and Run;
// an Input column (Content and Metadata tabs) and an Output column (Content and Metadata tabs, the
// added or changed fields and keys marked, and a "Changed:" footer). Each run posts
// `run {content, meta}`: from Run at once, or with Run on change 300 ms after the last content or
// metadata edit, or after a snapshot whose kind or source differs (an empty content runs nothing). The
// host answers with `result`; results other than `ok` keep 4.2's text until 4.8. The `samples` and
// `binary` messages are ignored for now, and anything that fails `parseBloblangHostMessage` is
// ignored. It holds no domain state and runs nothing itself (AD-3): the input, the tabs and the
// toggle are view state, kept by the host page across reloads.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
	parseBloblangHostMessage, type BloblangHostMessage, type BloblangWebviewMessage,
} from '../../../src/shared/bloblangProtocol';
import { inputMeta, metaRowCount, type MetaRow } from './changes';
import type { PanelTab, ViewState } from './host';
import { InputMetadata, type EditableRow } from './MetadataTable';
import { ChangesFooter, OutputBody } from './OutputView';

export { DELETED_TEXT, ERROR_TEXT, FAILED_TEXT } from './OutputView';

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

type Snapshot = Extract<BloblangHostMessage, { type: 'snapshot' }>;
type Result = Extract<BloblangHostMessage, { type: 'result' }>;

export interface TestPanelProps {
	readonly post: (message: BloblangWebviewMessage) => void;
	/** The view state saved by an earlier load of the panel. */
	readonly initialState: ViewState;
	readonly saveState: (state: ViewState) => void;
}

/** The status pill's text and style for the last result (`ok`: duration and binary; else 4.2's text). */
function statusOf(result: Result): { text: string; tone: 'ok' | 'plain' } {
	const ms = Math.round(result.durationMs);
	if (result.result.kind === 'ok') {
		return { text: `✓ Ran in ${ms} ms${result.binary ? ` · ${result.binary}` : ''}`, tone: 'ok' };
	}
	return { text: `${ms} ms${result.binary ? ` · ${result.binary}` : ''}`, tone: 'plain' };
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

export function TestPanel({ post, initialState, saveState }: TestPanelProps) {
	const nextId = useRef(0);
	const withId = (row: MetaRow): EditableRow => ({ id: nextId.current++, key: row.key, value: row.value });
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [content, setContent] = useState(initialState.content);
	const [rows, setRows] = useState<readonly EditableRow[]>(() => initialState.meta.map(withId));
	const [inputTab, setInputTab] = useState<PanelTab>(initialState.inputTab);
	const [outputTab, setOutputTab] = useState<PanelTab>(initialState.outputTab);
	const [runOnChange, setRunOnChange] = useState(initialState.runOnChange);
	const [result, setResult] = useState<Result | null>(null);
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

	useEffect(() => {
		saveState({ content, meta: rows.map(({ key, value }) => ({ key, value })), inputTab, outputTab, runOnChange });
	}, [saveState, content, rows, inputTab, outputTab, runOnChange]);

	const cancel = () => {
		clearTimeout(timer.current);
		timer.current = undefined;
	};

	/** Runs the latest input now (an empty content runs nothing). */
	const runNow = useCallback(() => {
		clearTimeout(timer.current);
		timer.current = undefined;
		const { content: text, rows: current } = latest.current;
		if (text === '') {
			return;
		}
		setRunning(true);
		post({ type: 'run', content: text, meta: inputMeta(current) });
	}, [post]);

	/** With Run on change on and a content, runs the latest input after the pause. */
	const schedule = useCallback((text: string, on: boolean) => {
		clearTimeout(timer.current);
		timer.current = undefined;
		if (on && text !== '') {
			timer.current = setTimeout(runNow, RUN_DEBOUNCE_MS);
		}
	}, [runNow]);

	useEffect(() => {
		const onMessage = (event: MessageEvent<unknown>) => {
			const message = parseBloblangHostMessage(event.data);
			if (message?.type === 'snapshot') {
				setSnapshot(message);
				// The kind and source last seen: a run follows a change of either.
				const seen = JSON.stringify([message.kind, message.source]);
				const first = lastSource.current === undefined;
				const sourceChanged = !first && lastSource.current !== seen;
				lastSource.current = seen;
				if (first && !restoredRun.current) {
					// A recreated panel runs its restored input once (with Run on change on), so the output is back too.
					restoredRun.current = true;
					if (latest.current.runOnChange) {
						runNow();
					}
				} else if (sourceChanged) {
					schedule(latest.current.content, latest.current.runOnChange);
				}
			} else if (message?.type === 'result' && latest.current.content !== '') {
				// A result arriving after the content was cleared is dropped: the empty state stays.
				setResult(message);
				setRunning(false);
			}
		};
		window.addEventListener('message', onMessage);
		post({ type: 'ready' });
		return () => {
			window.removeEventListener('message', onMessage);
			clearTimeout(timer.current);
		};
	}, [post, runNow, schedule]);

	const contentChanged = (text: string) => {
		setContent(text);
		restoredRun.current = true;
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
		restoredRun.current = true;
		schedule(content, runOnChange);
	};

	const toggleChanged = (on: boolean) => {
		setRunOnChange(on);
		if (!on) {
			cancel();
		}
	};

	const status = running ? { text: RUNNING_TEXT, tone: 'running' as const } : result ? statusOf(result) : undefined;
	const okResult = result?.result.kind === 'ok' ? result.result : undefined;

	return (
		<main className="rpcn-bl">
			<header className="rpcn-bl-header">
				<div className="rpcn-bl-where">
					<h1 className="rpcn-bl-title">{snapshot?.title ?? 'Bloblang'}</h1>
					{snapshot && <span className="rpcn-bl-kind">{snapshot.kind}</span>}
				</div>
				{status && <span className={`rpcn-bl-pill rpcn-bl-pill-${status.tone}`} role="status">{status.text}</span>}
			</header>
			<div className="rpcn-bl-toolbar">
				<span className="rpcn-bl-spacer" />
				<label className="rpcn-bl-check">
					<input type="checkbox" className="rpcn-bl-auto" checked={runOnChange} onChange={(e) => toggleChanged(e.target.checked)} />
					{RUN_ON_CHANGE_LABEL}
				</label>
				<button type="button" className="rpcn-bl-run" disabled={content === ''} onClick={runNow}>{RUN_LABEL}</button>
			</div>
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
						{result ? <OutputBody result={result.result} tab={outputTab} /> : <p className="rpcn-bl-note rpcn-bl-pad">{EMPTY_TEXT}</p>}
					</div>
					{okResult && <ChangesFooter result={okResult} />}
				</section>
			</div>
		</main>
	);
}
