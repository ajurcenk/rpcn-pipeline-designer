// The Bloblang test panel's output column body and footer (tickets 4.7, 4.8). For `ok`, the content
// (pretty JSON with the lines of each added or changed top-level field marked) or the metadata table,
// and the "Changed:" footer. Every other result has the prototype's card (E4 R6): a parse error, a
// mapping that failed on the input, an input the mapping can't read and a run that could not happen
// are alerts with the binary's message (a parse error and a located failure offer Go to line); a
// deleted message is a dashed info card. Under an alert, the last `ok` output since the panel opened
// stays, dimmed, unmarked and labelled; a deleted message dims nothing.
// Ticket 4.11: the cards are not live regions (the panel's one announcer says each result), and the
// output content is focusable, so it can be read and scrolled by keyboard.
// Ticket 16: a generate mapping's output (`marks` off, `changes` off) has no change marks and no
// "Changed:" footer: there is no input to compare; its invalid-input card's hint (`generate`) says the
// message is empty instead of pointing at an input.
// Ticket 32: a run that could not happen because the config uses variables nothing sets
// (`missingVariables`) has a Set NAME… button for each after its message (`onSetVariable`).
// Ticket 40: the output content has a line-number gutter: each line's number is its `data-line`,
// drawn by the stylesheet's `::before` (so it is not in the text, not copied, not selectable and not
// read by screen readers); the lines, the change marks and the focusable `pre` are unchanged.

import type { CSSProperties, ReactNode } from 'react';
import type { BloblangResult } from '../../../src/shared/bloblangProtocol';
import { changeTags, markedLines, shownContent } from './changes';
import type { PanelTab } from './host';
import { OutputMetadata } from './MetadataTable';

export const PARSE_ERROR_TITLE = "Mapping doesn't parse";
export const FAILED_NO_LINE_TITLE = 'The mapping failed on this input';
export const INVALID_INPUT_TITLE = "This input can't be read by the mapping";
export const DELETED_TITLE = 'The mapping deleted this message';
export const ERROR_TITLE = 'The test could not run';
export const LAST_OK_LABEL = 'Last successful output';
export const PARSE_ERROR_FOOTER = 'Fix the mapping to run it again.';
export const DIMMED_FOOTER = 'Showing the last successful output, dimmed.';
export const DELETED_FOOTER = 'No output and no metadata.';
export const CHANGED_LABEL = 'Changed:';
export const NO_CHANGES_TEXT = 'No changes';
/** The file's name when the page was not given one. */
export const DEFAULT_FILE_NAME = 'YAML';

/** "Failed on mapping line N". */
export const failedTitle = (line: number): string => `Failed on mapping line ${line}`;
/** "Set NAME…" (ticket 32). */
export const setVariableLabel = (name: string): string => `Set ${name}\u2026`;
/** "Go to line F". */
export const goToLineLabel = (line: number): string => `Go to line ${line}`;

export type OkResult = Extract<BloblangResult, { kind: 'ok' }>;

/** The output content; `marks` off for the dimmed last output. */
function OkContent({ result, marks }: { readonly result: OkResult; readonly marks: boolean }) {
	const shown = shownContent(result.content);
	const fields = result.changes.fields;
	const marked = marks ? markedLines(shown, fields ? [...fields.added, ...fields.changed] : []) : new Set<number>();
	return (
		<pre
			className="rpcn-bl-output" aria-label="Output content" tabIndex={0}
			style={{ '--rpcn-bl-gutter': `${Math.max(2, String(shown.lines.length).length)}ch` } as CSSProperties}
		>
			{shown.lines.map((line, i) => (
				<span key={i} data-line={i + 1}>
					<span className={marked.has(i) ? 'rpcn-bl-line rpcn-bl-mark' : 'rpcn-bl-line'}>{line}</span>
					{i < shown.lines.length - 1 ? '\n' : ''}
				</span>
			))}
		</pre>
	);
}

/** An `ok` output: content or metadata, with or without the change marks. */
function OkOutput({ result, tab, marks }: { readonly result: OkResult; readonly tab: PanelTab; readonly marks: boolean }) {
	return tab === 'content'
		? <OkContent result={result} marks={marks} />
		: <OutputMetadata meta={result.meta} marked={marks ? [...result.changes.meta.added, ...result.changes.meta.changed] : []} />;
}

interface CardProps {
	readonly title: string;
	readonly subtitle?: string;
	readonly message: string;
	/** The file line Go to line goes to; none: no button. */
	readonly goTo?: number;
	readonly onGoToLine: (line: number) => void;
	readonly hint?: ReactNode;
	/** The variables Set NAME… is offered for (ticket 32); none: no button. */
	readonly variables?: readonly string[];
	readonly onSetVariable?: (name: string) => void;
}

/** An error card: its title and subtitle, the message, and Go to line. */
function ErrorCard({ title, subtitle, message, goTo, onGoToLine, hint, variables, onSetVariable }: CardProps) {
	return (
		<div className="rpcn-bl-card rpcn-bl-card-error">
			<p className="rpcn-bl-card-head">
				<span className="rpcn-bl-card-title">{title}</span>
				{subtitle !== undefined && <small className="rpcn-bl-card-sub">{subtitle}</small>}
			</p>
			<pre className="rpcn-bl-message">{message}</pre>
			{hint !== undefined && <p className="rpcn-bl-card-hint">{hint}</p>}
			{goTo !== undefined && (
				<div className="rpcn-bl-card-acts">
					<button type="button" className="rpcn-bl-link rpcn-bl-goto" onClick={() => onGoToLine(goTo)}>{goToLineLabel(goTo)}</button>
				</div>
			)}
			{variables !== undefined && variables.length > 0 && onSetVariable && (
				<div className="rpcn-bl-card-acts">
					{variables.map((name) => (
						<button key={name} type="button" className="rpcn-bl-link rpcn-bl-setvar" onClick={() => onSetVariable(name)}>{setVariableLabel(name)}</button>
					))}
				</div>
			)}
		</div>
	);
}

/** The card of a result that is not `ok` or `deleted`. */
function ProblemCard({ result, fileName, onGoToLine, generate, onSetVariable }: {
	readonly result: Exclude<BloblangResult, { kind: 'ok' | 'deleted' }>;
	readonly fileName: string;
	readonly onGoToLine: (line: number) => void;
	readonly generate: boolean;
	readonly onSetVariable?: (name: string) => void;
}) {
	switch (result.kind) {
		case 'parseError':
			return (
				<ErrorCard
					title={PARSE_ERROR_TITLE}
					subtitle={`mapping line ${result.mappingLine}, char ${result.mappingChar} · ${fileName} line ${result.fileLine}`}
					message={result.excerpt ? `${result.message}\n${result.excerpt}` : result.message}
					goTo={result.fileLine}
					onGoToLine={onGoToLine}
				/>
			);
		case 'failed':
			return result.mappingLine !== undefined && result.fileLine !== undefined
				? (
					<ErrorCard
						title={failedTitle(result.mappingLine)}
						subtitle={`${fileName} line ${result.fileLine}`}
						message={result.message}
						goTo={result.fileLine}
						onGoToLine={onGoToLine}
					/>
				)
				: <ErrorCard title={FAILED_NO_LINE_TITLE} message={result.message} onGoToLine={onGoToLine} />;
		case 'invalidInput':
			return (
				<ErrorCard
					title={INVALID_INPUT_TITLE}
					message={result.message}
					onGoToLine={onGoToLine}
					hint={generate
						? <>A generate input&apos;s message is empty: the mapping can&apos;t read <code>this</code>. Build the message with <code>root = …</code> instead.</>
						: <>The mapping reads the message as JSON (<code>this</code>); check the input&apos;s Content.</>}
				/>
			);
		case 'error':
			return (
				<ErrorCard
					title={ERROR_TITLE}
					message={result.message}
					onGoToLine={onGoToLine}
					variables={result.missingVariables}
					onSetVariable={onSetVariable}
				/>
			);
	}
}

export interface OutputBodyProps {
	readonly result: BloblangResult;
	readonly tab: PanelTab;
	/** The last `ok` result since the panel opened, if any. */
	readonly lastOk?: OkResult;
	/** The YAML file's name, for the cards' "<file> line F". */
	readonly fileName: string;
	readonly onGoToLine: (line: number) => void;
	/** Whether an ok output marks its added and changed fields and keys (default on; off for a generate mapping, 16). */
	readonly marks?: boolean;
	/** A generate mapping's output (16): the invalid-input card's hint says the message is empty. */
	readonly generate?: boolean;
	/** Set NAME… on a run stopped by unset variables (ticket 32); `undefined`: no button. */
	readonly onSetVariable?: (name: string) => void;
}

export function OutputBody({ result, tab, lastOk, fileName, onGoToLine, marks = true, generate = false, onSetVariable }: OutputBodyProps) {
	switch (result.kind) {
		case 'ok':
			return <OkOutput result={result} tab={tab} marks={marks} />;
		case 'deleted':
			return (
				<div className="rpcn-bl-card rpcn-bl-card-info">
					<b className="rpcn-bl-card-title">{DELETED_TITLE}</b>
				</div>
			);
		default:
			return (
				<>
					<ProblemCard result={result} fileName={fileName} onGoToLine={onGoToLine} generate={generate} onSetVariable={onSetVariable} />
					{lastOk && (
						<section className="rpcn-bl-stale" aria-label={LAST_OK_LABEL}>
							<p className="rpcn-bl-stale-label">{LAST_OK_LABEL}</p>
							<OkOutput result={lastOk} tab={tab} marks={false} />
						</section>
					)}
				</>
			);
	}
}

/**
 * The output footer of a result: "Changed:" and its tags (or "No changes") for `ok`, else the state's
 * line; with `changes` off (a generate mapping, 16), none for `ok`.
 */
export function ResultFooter({ result, dimmed, changes = true }: { readonly result: BloblangResult; readonly dimmed: boolean; readonly changes?: boolean }) {
	if (result.kind === 'ok') {
		if (!changes) {
			return null;
		}
		const tags = changeTags(result.changes);
		if (tags.length === 0) {
			return <footer className="rpcn-bl-foot">{NO_CHANGES_TEXT}</footer>;
		}
		return (
			<footer className="rpcn-bl-foot">
				<span>{CHANGED_LABEL}</span>
				{tags.map((tag, i) => <span key={i} className={`rpcn-bl-tag rpcn-bl-tag-${tag.kind}`}>{tag.text}</span>)}
			</footer>
		);
	}
	const text = result.kind === 'parseError' ? PARSE_ERROR_FOOTER
		: result.kind === 'deleted' ? DELETED_FOOTER
			: dimmed ? DIMMED_FOOTER : undefined;
	return text === undefined ? null : <footer className="rpcn-bl-foot">{text}</footer>;
}
