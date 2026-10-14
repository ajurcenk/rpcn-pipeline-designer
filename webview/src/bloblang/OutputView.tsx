// The Bloblang test panel's output column body (ticket 4.7): for `ok`, the content (pretty JSON with
// the lines of each added or changed top-level field marked) or the metadata table; any other result
// keeps 4.2's text until 4.8 replaces it. Plus the "Changed:" footer.

import type { BloblangResult } from '../../../src/shared/bloblangProtocol';
import { changeTags, markedLines, shownContent } from './changes';
import type { PanelTab } from './host';
import { OutputMetadata } from './MetadataTable';

export const DELETED_TEXT = 'The mapping deleted the message.';
export const FAILED_TEXT = 'The mapping failed on this input.';
export const ERROR_TEXT = 'The test could not run.';
export const CHANGED_LABEL = 'Changed:';
export const NO_CHANGES_TEXT = 'No changes';

type OkResult = Extract<BloblangResult, { kind: 'ok' }>;

function OkContent({ result }: { readonly result: OkResult }) {
	const shown = shownContent(result.content);
	const fields = result.changes.fields;
	const marked = markedLines(shown, fields ? [...fields.added, ...fields.changed] : []);
	return (
		<pre className="rpcn-bl-output" aria-label="Output content">
			{shown.lines.map((line, i) => (
				<span key={i}>
					<span className={marked.has(i) ? 'rpcn-bl-line rpcn-bl-mark' : 'rpcn-bl-line'}>{line}</span>
					{i < shown.lines.length - 1 ? '\n' : ''}
				</span>
			))}
		</pre>
	);
}

export function OutputBody({ result, tab }: { readonly result: BloblangResult; readonly tab: PanelTab }) {
	switch (result.kind) {
		case 'ok':
			return tab === 'content'
				? <OkContent result={result} />
				: <OutputMetadata meta={result.meta} marked={[...result.changes.meta.added, ...result.changes.meta.changed]} />;
		case 'deleted':
			return <p className="rpcn-bl-note rpcn-bl-pad">{DELETED_TEXT}</p>;
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

/** The output footer of an `ok` result: "Changed:" and its tags, or "No changes". */
export function ChangesFooter({ result }: { readonly result: OkResult }) {
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
