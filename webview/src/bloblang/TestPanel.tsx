// The Bloblang test panel's view (ticket 4.2): the processor's Bloblang (read-only), an input box
// for the message content, and the result of the latest run. Typing runs the mapping after a short
// pause, and the Run button at once (an empty input runs nothing); each run posts `run {content, meta: {}}` (no metadata
// yet, 4.7) and the host answers with `result`, of which only `ok.content` shows (4.7–4.9 show the rest). The `samples` and
// `binary` messages are ignored for now, and anything that fails `parseBloblangHostMessage` is ignored. It holds no domain state and
// runs nothing itself (AD-3): the typed input is view state, kept by the host page across reloads.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
	parseBloblangHostMessage, type BloblangHostMessage, type BloblangResult, type BloblangWebviewMessage,
} from '../../../src/shared/bloblangProtocol';

/** How long typing pauses before the input runs. */
export const RUN_DEBOUNCE_MS = 300;
export const INPUT_LABEL = 'Input';
export const RUN_LABEL = 'Run';
export const DELETED_TEXT = 'The mapping deleted the message.';
export const FAILED_TEXT = 'The mapping failed on this input.';
export const ERROR_TEXT = 'The test could not run.';
export const EMPTY_TEXT = 'Type the message content above to run the mapping on it.';

type Snapshot = Extract<BloblangHostMessage, { type: 'snapshot' }>;
type Result = Extract<BloblangHostMessage, { type: 'result' }>;

export interface TestPanelProps {
	readonly post: (message: BloblangWebviewMessage) => void;
	/** The input saved by an earlier load of the panel. */
	readonly initialInput: string;
	readonly saveInput: (input: string) => void;
}

function ResultView({ result }: { readonly result: BloblangResult }) {
	switch (result.kind) {
		case 'ok':
			return <pre className="rpcn-bl-output" aria-label="Output">{result.content}</pre>;
		case 'deleted':
			return <p className="rpcn-bl-note">{DELETED_TEXT}</p>;
		case 'failed':
			return (
				<div className="rpcn-bl-problem">
					<p className="rpcn-bl-problem-title">{FAILED_TEXT}</p>
					<pre className="rpcn-bl-message">{result.message}</pre>
				</div>
			);
		// Until 4.8 renders them, a parse error and an invalid input show as a run that could not happen.
		case 'parseError':
		case 'invalidInput':
		case 'error':
			return (
				<div className="rpcn-bl-problem">
					<p className="rpcn-bl-problem-title">{ERROR_TEXT}</p>
					<pre className="rpcn-bl-message">{result.message}</pre>
				</div>
			);
	}
}

export function TestPanel({ post, initialInput, saveInput }: TestPanelProps) {
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [input, setInput] = useState(initialInput);
	const [result, setResult] = useState<Result | null>(null);
	const [running, setRunning] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const inputRef = useRef(input);
	inputRef.current = input;
	/** Whether the restored input has run since the first snapshot. */
	const restoredRun = useRef(false);

	const run = useCallback((text: string) => {
		clearTimeout(timer.current);
		timer.current = undefined;
		setRunning(true);
		post({ type: 'run', content: text, meta: {} });
	}, [post]);

	useEffect(() => {
		const onMessage = (event: MessageEvent<unknown>) => {
			const message = parseBloblangHostMessage(event.data);
			if (message?.type === 'snapshot') {
				setSnapshot(message);
				// A recreated panel runs its restored input once, so the output is back too.
				if (!restoredRun.current) {
					restoredRun.current = true;
					if (inputRef.current !== '') {
						run(inputRef.current);
					}
				}
			} else if (message?.type === 'result' && inputRef.current !== '') {
				// A result arriving after the input was cleared is dropped: the empty state stays.
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
	}, [post, run]);

	const changed = (text: string) => {
		setInput(text);
		saveInput(text);
		restoredRun.current = true;
		clearTimeout(timer.current);
		timer.current = undefined;
		if (text === '') {
			// An empty input runs nothing and shows the empty state again.
			setResult(null);
			setRunning(false);
			return;
		}
		timer.current = setTimeout(() => run(text), RUN_DEBOUNCE_MS);
	};

	return (
		<main className="rpcn-bl">
			<header className="rpcn-bl-header">
				<h1 className="rpcn-bl-title">{snapshot?.title ?? 'Bloblang'}</h1>
				{snapshot && <span className="rpcn-bl-kind">{snapshot.kind}</span>}
			</header>
			{snapshot && <pre className="rpcn-bl-source" aria-label="Bloblang">{snapshot.source}</pre>}
			<label className="rpcn-bl-label" htmlFor="rpcn-bl-input">{INPUT_LABEL}</label>
			<textarea
				id="rpcn-bl-input"
				className="rpcn-bl-input"
				spellCheck={false}
				rows={8}
				value={input}
				placeholder='{"a": 1}'
				onChange={(event) => changed(event.target.value)}
			/>
			<div className="rpcn-bl-actions">
				<button type="button" className="rpcn-bl-run" disabled={input === ''} onClick={() => run(input)}>{RUN_LABEL}</button>
				{running && <span className="rpcn-bl-running">Running…</span>}
			</div>
			<section className="rpcn-bl-result" aria-label="Result" aria-live="polite">
				{result ? <ResultView result={result.result} /> : <p className="rpcn-bl-note">{EMPTY_TEXT}</p>}
				{result && (
					<p className="rpcn-bl-meta">
						{`${Math.round(result.durationMs)} ms`}
						{result.binary ? ` · ${result.binary}` : ''}
					</p>
				)}
			</section>
		</main>
	);
}
