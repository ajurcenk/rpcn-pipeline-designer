// Manual check 3: a small copy icon button (a reply, a code block, a command). It posts `copyText`; the
// host writes the clipboard (`vscode.env.clipboard`), since the webview's own clipboard does not work in
// the assistant's view. "Copied" shows briefly after a click.

import { createContext, useContext, useEffect, useState } from 'react';
import { MAX_COPY_CHARS } from '../../../src/shared/assistantProtocol';

export const COPIED_LABEL = 'Copied';

/** How the view copies text (posts `copyText`); the default does nothing. */
export const CopyContext = createContext<(text: string) => void>(() => undefined);
/** How long "Copied" shows. */
export const COPIED_MS = 1500;

export function CopyButton({ label, text, className = '' }: { readonly label: string; readonly text: string; readonly className?: string }) {
	const copy = useContext(CopyContext);
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) {
			return undefined;
		}
		const timer = setTimeout(() => setCopied(false), COPIED_MS);
		return () => clearTimeout(timer);
	}, [copied]);
	const name = copied ? COPIED_LABEL : label;
	return (
		<button
			type="button"
			className={`rpcn-assistant-copy${copied ? ' rpcn-assistant-copied' : ''}${className ? ` ${className}` : ''}`}
			aria-label={name}
			title={name}
			onClick={() => {
				copy(text.slice(0, MAX_COPY_CHARS));
				setCopied(true);
			}}
		>
			{copied ? (
				<>
					<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 8.5l3 3 7-7" /></svg>
					<span className="rpcn-assistant-copied-text" aria-hidden="true">{COPIED_LABEL}</span>
				</>
			) : (
				<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
					<rect x="5.5" y="5.5" width="8" height="8" rx="1" /><path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
				</svg>
			)}
		</button>
	);
}
