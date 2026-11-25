// A turn's step rows (story 8.12; manual check 1: option A's outcome-level rows), in a bordered card:
// each with its mark (running, ok, failed; a plain line of the run without one), its label and its short
// result. Consecutive steps with the same label are one row with a count ("… ×8"), and every read of the
// skills' own references is one row ("Read N skill references"). A failed step the run carried on past
// is a warning (!), not an error (✗): only the turn's last step, or any failed step of a turn that ended
// in error, keeps the error mark. An earlier turn folds the rows to one line, which opens on click.

import { useState } from 'react';
import { SKILL_READ_LABEL, skillReadsText, type AssistantOutcome, type AssistantStepMark, type AssistantStepView } from '../../../src/shared/assistantProtocol';

/** A row's mark as shown: a step's, or `warning` for a failure the run went on past. */
export type RowMark = AssistantStepMark | 'warning';

/** Each mark's sign and its name (the sign is never the only signal: the name is its label). */
export const MARKS: Readonly<Record<RowMark, { readonly sign: string; readonly name: string }>> = {
	running: { sign: '◌', name: 'running' },
	ok: { sign: '✓', name: 'ok' },
	failed: { sign: '✗', name: 'failed' },
	warning: { sign: '!', name: 'failed, the run went on' },
	info: { sign: '·', name: '' },
};

export interface StepRow {
	readonly id: string;
	readonly label: string;
	readonly mark: RowMark;
	readonly result: string;
	/** How many steps the row stands for. */
	readonly count: number;
}

const RANK: Readonly<Record<AssistantStepMark, number>> = { info: 0, ok: 1, failed: 2, running: 3 };

/** The worst of two marks: running, then failed, then ok. */
function worst(a: AssistantStepMark, b: AssistantStepMark): AssistantStepMark {
	return RANK[b] > RANK[a] ? b : a;
}

/**
 * The rows of a turn's steps: the skill reads as one row where the first was; then consecutive steps with
 * the same label as one row (the worst mark, the last result, a count); then a failure followed by a
 * later tool row, in a turn that did not end in error, as a warning.
 */
export function stepRows(steps: readonly AssistantStepView[], outcome: AssistantOutcome): StepRow[] {
	const reads = steps.filter((s) => s.label === SKILL_READ_LABEL);
	const rows: { id: string; label: string; mark: AssistantStepMark; result: string; count: number }[] = [];
	let readsAt = -1;
	for (const s of steps) {
		if (s.label === SKILL_READ_LABEL) {
			if (readsAt < 0) {
				readsAt = rows.length;
				rows.push({ id: s.id, label: skillReadsText(reads.length), mark: reads.reduce((m, r) => worst(m, r.mark), 'ok' as AssistantStepMark), result: '', count: reads.length });
			}
			continue;
		}
		const last = rows[rows.length - 1];
		if (last && rows.length - 1 !== readsAt && last.label === s.label && s.mark !== 'info') {
			last.mark = worst(last.mark, s.mark);
			last.result = s.result;
			last.count++;
			continue;
		}
		rows.push({ id: s.id, label: s.label, mark: s.mark, result: s.result, count: 1 });
	}
	const lastTool = rows.map((r) => r.mark !== 'info').lastIndexOf(true);
	return rows.map((r, i) => ({
		...r,
		label: r.count > 1 && i !== readsAt ? `${r.label} ×${r.count}` : r.label,
		mark: r.mark === 'failed' && outcome !== 'error' && i < lastTool ? 'warning' : r.mark,
	}));
}

/** The folded line of an earlier turn's steps. */
export function foldedText(rows: readonly StepRow[]): string {
	const tools = rows.filter((s) => s.mark !== 'info');
	const failed = tools.filter((s) => s.mark === 'failed').length;
	const n = tools.length || rows.length;
	return `${n} step${n === 1 ? '' : 's'}${failed > 0 ? `, ${failed} failed` : ''}`;
}

function Rows({ rows }: { readonly rows: readonly StepRow[] }) {
	return (
		<ol className="rpcn-assistant-steps" aria-label="Steps">
			{rows.map((s) => (
				<li key={s.id} className={`rpcn-assistant-step rpcn-assistant-step-${s.mark}`}>
					<span className="rpcn-assistant-step-mark" aria-label={MARKS[s.mark].name || undefined} aria-hidden={MARKS[s.mark].name ? undefined : true}>{MARKS[s.mark].sign}</span>
					<span className="rpcn-assistant-step-label">{s.label}</span>
					{s.result ? <span className="rpcn-assistant-step-result">{s.result}</span> : null}
				</li>
			))}
		</ol>
	);
}

export function StepRows({ steps, folded, outcome }: { readonly steps: readonly AssistantStepView[]; readonly folded: boolean; readonly outcome: AssistantOutcome }) {
	const [open, setOpen] = useState(false);
	if (steps.length === 0) {
		return null;
	}
	const rows = stepRows(steps, outcome);
	if (!folded) {
		return <Rows rows={rows} />;
	}
	return (
		<div className="rpcn-assistant-fold">
			<button type="button" className="rpcn-assistant-fold-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
				<span aria-hidden="true">{open ? '▾' : '▸'}</span> {foldedText(rows)}
			</button>
			{open ? <Rows rows={rows} /> : null}
		</div>
	);
}
