// The files a turn changed (story 8.12): each with its +N/−N; a click opens its diff against the copy
// from before the turn while that copy is kept (until Keep or Undo); a file over 1 MB says "too large to
// undo", with no diff.

import { TOO_LARGE_TEXT, type AssistantFileView } from '../../../src/shared/assistantProtocol';

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

export function FileRows({ files, clickable, open }: {
	readonly files: readonly AssistantFileView[]; readonly clickable: boolean; readonly open: (path: string) => void;
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
							<Counts file={f} />
						</button>
					) : (
						<span className="rpcn-assistant-file-text">
							<span className="rpcn-assistant-file-path">{f.path}</span>
							<Counts file={f} />
						</span>
					)}
				</li>
			))}
		</ul>
	);
}
