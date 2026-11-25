// A turn's step rows (story 8.12): each with its mark (running, ok, failed; a plain line of the run
// without one), its label and its short result. An earlier turn folds them to one line, which opens on
// click.

import { useState } from 'react';
import type { AssistantStepMark, AssistantStepView } from '../../../src/shared/assistantProtocol';

/** Each mark's sign and its name (the sign is never the only signal: the name is its label). */
export const MARKS: Readonly<Record<AssistantStepMark, { readonly sign: string; readonly name: string }>> = {
	running: { sign: '◌', name: 'running' },
	ok: { sign: '✓', name: 'ok' },
	failed: { sign: '✗', name: 'failed' },
	info: { sign: '·', name: '' },
};

/** The folded line of an earlier turn's steps. */
export function foldedText(steps: readonly AssistantStepView[]): string {
	const tools = steps.filter((s) => s.mark !== 'info');
	const failed = tools.filter((s) => s.mark === 'failed').length;
	const n = tools.length || steps.length;
	return `${n} step${n === 1 ? '' : 's'}${failed > 0 ? `, ${failed} failed` : ''}`;
}

function Rows({ steps }: { readonly steps: readonly AssistantStepView[] }) {
	return (
		<ol className="rpcn-assistant-steps" aria-label="Steps">
			{steps.map((s) => (
				<li key={s.id} className={`rpcn-assistant-step rpcn-assistant-step-${s.mark}`}>
					<span className="rpcn-assistant-step-mark" aria-label={MARKS[s.mark].name || undefined} aria-hidden={MARKS[s.mark].name ? undefined : true}>{MARKS[s.mark].sign}</span>
					<span className="rpcn-assistant-step-label">{s.label}</span>
					{s.result ? <span className="rpcn-assistant-step-result">{s.result}</span> : null}
				</li>
			))}
		</ol>
	);
}

export function StepRows({ steps, folded }: { readonly steps: readonly AssistantStepView[]; readonly folded: boolean }) {
	const [open, setOpen] = useState(false);
	if (steps.length === 0) {
		return null;
	}
	if (!folded) {
		return <Rows steps={steps} />;
	}
	return (
		<div className="rpcn-assistant-fold">
			<button type="button" className="rpcn-assistant-fold-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
				<span aria-hidden="true">{open ? '▾' : '▸'}</span> {foldedText(steps)}
			</button>
			{open ? <Rows steps={steps} /> : null}
		</div>
	);
}
