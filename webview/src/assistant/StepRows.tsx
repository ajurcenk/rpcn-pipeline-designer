// A turn's step rows (story 8.12; manual checks 1 and 2: option A's outcome-level rows), in a bordered
// card: each with its mark (running, ok, failed; a plain line of the run without one), its label, its short
// result and, for a shell command, the command as a muted second line. Consecutive steps with the same
// label are one row with a count ("Ran a shell command ×12"), which opens to show each step; every read
// of the skills' own references is one row ("Read N skill references"). A failed step the run carried on
// past is a warning (!), not an error (✗): only the turn's last step, or any failed step of a turn that
// ended in error, keeps the error mark.
//   - While the turn runs, the card shows its last `LIVE_ROWS` rows, under a "… N earlier steps" line that
//     opens the rest.
//   - Once it has ended, the card folds to one summary line ("▸ 27 steps · 1 warning"), which opens on
//     click; a turn that ended in error keeps its rows open.

import { useState } from 'react';
import { CopyButton } from './CopyButton';

export const COPY_COMMAND_LABEL = 'Copy command';

/** Manual check 3: a step's command as selectable text, with its copy button (never inside a button). */
function Command({ text }: { readonly text: string }) {
	return (
		<span className="rpcn-assistant-step-command">
			<code className="rpcn-assistant-step-detail" title={text}>{text}</code>
			<CopyButton label={COPY_COMMAND_LABEL} text={text} />
		</span>
	);
}
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

/** While a turn runs, how many of its last rows the card shows. */
export const LIVE_ROWS = 6;

export interface StepRow {
	readonly id: string;
	readonly label: string;
	readonly mark: RowMark;
	readonly result: string;
	readonly detail: string;
	/** How many steps the row stands for. */
	readonly count: number;
	/** The steps a grouped row stands for (each with its own mark), in order; one step: none. */
	readonly members: readonly StepRow[];
}

const RANK: Readonly<Record<AssistantStepMark, number>> = { info: 0, ok: 1, failed: 2, running: 3 };

/** The worst of two marks: running, then failed, then ok. */
function worst(a: AssistantStepMark, b: AssistantStepMark): AssistantStepMark {
	return RANK[b] > RANK[a] ? b : a;
}

interface Draft {
	id: string;
	label: string;
	mark: AssistantStepMark;
	result: string;
	detail: string;
	steps: AssistantStepView[];
	reads: boolean;
}

/**
 * The rows of a turn's steps: the skill reads as one row where the first was; then consecutive steps with
 * the same label as one row (the worst mark, the last result, a count, the steps it stands for); then a
 * failure followed by a later tool step, in a turn that did not end in error, as a warning.
 */
export function stepRows(steps: readonly AssistantStepView[], outcome: AssistantOutcome): StepRow[] {
	const toolSteps = steps.filter((s) => s.mark !== 'info');
	const lastTool = toolSteps[toolSteps.length - 1];
	const shown = (s: AssistantStepView): RowMark => (s.mark === 'failed' && outcome !== 'error' && s !== lastTool ? 'warning' : s.mark);
	const drafts: Draft[] = [];
	let reads: Draft | undefined;
	for (const s of steps) {
		if (s.label === SKILL_READ_LABEL) {
			if (!reads) {
				reads = { id: s.id, label: '', mark: 'ok', result: '', detail: '', steps: [], reads: true };
				drafts.push(reads);
			}
			reads.steps.push(s);
			reads.mark = worst(reads.mark, s.mark);
			continue;
		}
		const last = drafts[drafts.length - 1];
		if (last && !last.reads && last.label === s.label && s.mark !== 'info') {
			last.steps.push(s);
			last.mark = worst(last.mark, s.mark);
			last.result = s.result;
			continue;
		}
		drafts.push({ id: s.id, label: s.label, mark: s.mark, result: s.result, detail: s.detail ?? '', steps: [s], reads: false });
	}
	const one = (s: AssistantStepView): StepRow => ({ id: s.id, label: s.label, mark: shown(s), result: s.result, detail: s.detail ?? '', count: 1, members: [] });
	return drafts.map((d) => {
		if (d.steps.length === 1 && !d.reads) {
			return one(d.steps[0]);
		}
		const members = d.steps.map(one);
		// A group is a warning when its worst is a failure the run went on past (no member keeps the error mark).
		const mark: RowMark = d.mark === 'failed' && !members.some((m) => m.mark === 'failed') ? 'warning' : d.mark;
		const label = d.reads ? skillReadsText(d.steps.length) : `${d.label} ×${d.steps.length}`;
		return { id: d.id, label, mark, result: d.reads ? '' : d.result, detail: '', count: d.steps.length, members: d.steps.length > 1 ? members : [] };
	});
}

/** The folded line of a turn's steps: the steps, then how many warnings and failures ("27 steps · 1 warning"). */
export function foldedText(rows: readonly StepRow[]): string {
	const tools = rows.filter((r) => r.mark !== 'info');
	const n = tools.reduce((sum, r) => sum + r.count, 0) || rows.length;
	const marks = rows.flatMap((r) => (r.members.length > 0 ? r.members : [r])).map((r) => r.mark);
	const warnings = marks.filter((m) => m === 'warning').length;
	const failed = marks.filter((m) => m === 'failed').length;
	return [
		`${n} step${n === 1 ? '' : 's'}`,
		...(warnings > 0 ? [`${warnings} warning${warnings === 1 ? '' : 's'}`] : []),
		...(failed > 0 ? [`${failed} failed`] : []),
	].join(' · ');
}

function Mark({ mark }: { readonly mark: RowMark }) {
	return <span className="rpcn-assistant-step-mark" aria-label={MARKS[mark].name || undefined} aria-hidden={MARKS[mark].name ? undefined : true}>{MARKS[mark].sign}</span>;
}

function Row({ row }: { readonly row: StepRow }) {
	const [open, setOpen] = useState(false);
	const body = (detail: boolean) => (
		<>
			<Mark mark={row.mark} />
			<span className="rpcn-assistant-step-text">
				<span className="rpcn-assistant-step-label">{row.label}</span>
				{detail && row.detail ? <Command text={row.detail} /> : null}
			</span>
			{row.result ? <span className="rpcn-assistant-step-result">{row.result}</span> : null}
		</>
	);
	if (row.members.length === 0) {
		return <li className={`rpcn-assistant-step rpcn-assistant-step-${row.mark}`}>{body(true)}</li>;
	}
	return (
		<li className={`rpcn-assistant-step-group rpcn-assistant-step-${row.mark}`}>
			<button type="button" className="rpcn-assistant-step rpcn-assistant-step-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{body(false)}</button>
			{open ? (
				<ol className="rpcn-assistant-step-members" aria-label={row.label}>
					{row.members.map((m) => (
						<li key={m.id} className={`rpcn-assistant-step rpcn-assistant-step-${m.mark}`}>
							<Mark mark={m.mark} />
							<span className="rpcn-assistant-step-text">
								{m.detail ? <Command text={m.detail} /> : <span className="rpcn-assistant-step-label">{m.label}</span>}
							</span>
							{m.result ? <span className="rpcn-assistant-step-result">{m.result}</span> : null}
						</li>
					))}
				</ol>
			) : null}
		</li>
	);
}

function Rows({ rows }: { readonly rows: readonly StepRow[] }) {
	return (
		<ol className="rpcn-assistant-steps" aria-label="Steps">
			{rows.map((r) => <Row key={r.id} row={r} />)}
		</ol>
	);
}

export function StepRows({ steps, outcome }: { readonly steps: readonly AssistantStepView[]; readonly outcome: AssistantOutcome }) {
	const [open, setOpen] = useState(false);
	if (steps.length === 0) {
		return null;
	}
	const rows = stepRows(steps, outcome);
	if (outcome === 'running') {
		const hidden = open ? 0 : Math.max(0, rows.length - LIVE_ROWS);
		return (
			<div className="rpcn-assistant-fold">
				{hidden > 0 ? (
					<button type="button" className="rpcn-assistant-fold-line" aria-expanded={false} onClick={() => setOpen(true)}>
						… {hidden} earlier step{hidden === 1 ? '' : 's'}
					</button>
				) : null}
				<Rows rows={rows.slice(hidden)} />
			</div>
		);
	}
	if (outcome === 'error') {
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
