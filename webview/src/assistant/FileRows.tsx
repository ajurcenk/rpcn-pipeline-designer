// The files a turn changed (story 8.12): each with its +N/−N; a click opens its diff against the copy
// from before the turn while that copy is kept (until Keep or Undo); a file over 1 MB says "too large to
// undo", with no diff. Manual check 1: the design note's row also shows its status badge.

import { TOO_LARGE_TEXT, type AssistantFileView, type AssistantNoteView } from '../../../src/shared/assistantProtocol';

/** Manual check 1: the design note's status badge (`ready`, `draft`, …). */
export function NoteStatus({ status }: { readonly status: string | null }) {
	return <span className={`rpcn-assistant-note-status rpcn-assistant-status-${status ?? 'none'}`}>{status ?? 'no status'}</span>;
}

function Counts({ file }: { readonly file: AssistantFileView }) {
	if (file.tooLarge) {
		return <span className="rpcn-assistant-file-large">{TOO_LARGE_TEXT}</span>;
	}
	return (
		<span className="rpcn-assistant-file-counts">
			<span className="rpcn-assistant-added">+{file.added}</span>
			<span className="rpcn-assistant-removed">−{file.removed}</span>
			{file.created ? <span className="rpcn-assistant-file-new">new</span> : null}
		</span>
	);
}

export function FileRows({ files, clickable, open, note = null }: {
	readonly files: readonly AssistantFileView[]; readonly clickable: boolean; readonly open: (path: string) => void;
	/** The turn's design note: its row also shows its status. */
	readonly note?: AssistantNoteView | null;
}) {
	if (files.length === 0) {
		return null;
	}
	return (
		<ul className="rpcn-assistant-files" aria-label="Files changed">
			{files.map((f) => (
				<li key={f.path} className="rpcn-assistant-file">
					{clickable && !f.tooLarge ? (
						<button type="button" className="rpcn-assistant-file-open" title={`Open the diff of ${f.path}`} onClick={() => open(f.path)}>
							<span className="rpcn-assistant-file-path">{f.path}</span>
							<span className="rpcn-assistant-file-end">
								{note?.file === f.path ? <NoteStatus status={note.status} /> : null}
								<Counts file={f} />
							</span>
						</button>
					) : (
						<span className="rpcn-assistant-file-text">
							<span className="rpcn-assistant-file-path">{f.path}</span>
							<span className="rpcn-assistant-file-end">
								{note?.file === f.path ? <NoteStatus status={note.status} /> : null}
								<Counts file={f} />
							</span>
						</span>
					)}
				</li>
			))}
		</ul>
	);
}
