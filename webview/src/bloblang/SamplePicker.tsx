// The test panel's sample controls (ticket 4.9, the prototype's toolbar): the "Sample" label and
// picker, then New sample, Rename and Delete. Rename turns the picker into a text field: Enter saves
// a valid name (1–100 characters after trimming, unique), Esc and blur cancel, and an invalid name
// shows its error inline and keeps the field; a change of the selection or of `disabled` cancels it. While the samples file can't be read, every control is
// disabled. It only reports intents; the panel (`TestPanel.tsx`) keeps the samples.
// Ticket 4.18: with a previous step (`previousStep`, its title), **From previous step** follows
// Delete, named "New sample from <previousStep>"; the host runs that step and saves its output.

import { useEffect, useRef, useState } from 'react';
import { MAX_SAMPLE_NAME_LENGTH, type BloblangSample } from '../../../src/shared/bloblangProtocol';

export const SAMPLE_LABEL = 'Sample';
export const NEW_SAMPLE_LABEL = 'New sample';
export const RENAME_LABEL = 'Rename';
export const DELETE_LABEL = 'Delete';
export const FROM_PREVIOUS_LABEL = 'From previous step';
/** From previous step's accessible name (4.18). */
export const fromPreviousName = (previousStep: string): string => `New sample from ${previousStep}`;
/** The picker's option while no sample is selected. */
export const UNSAVED_INPUT = 'Unsaved input';
export const NAME_LENGTH_ERROR = `Name must be 1–${MAX_SAMPLE_NAME_LENGTH} characters`;
export const NAME_EXISTS_ERROR = 'A sample with this name exists';

/** The first free `sample N` (N from 1). */
export function nextSampleName(samples: readonly Pick<BloblangSample, 'name'>[]): string {
	const names = new Set(samples.map((s) => s.name));
	let n = 1;
	while (names.has(`sample ${n}`)) {
		n++;
	}
	return `sample ${n}`;
}

/** Why `name` (trimmed) can't rename `from` among `samples`; `undefined`: it can. */
export function renameError(name: string, from: string, samples: readonly Pick<BloblangSample, 'name'>[]): string | undefined {
	const to = name.trim();
	if (to.length < 1 || to.length > MAX_SAMPLE_NAME_LENGTH) {
		return NAME_LENGTH_ERROR;
	}
	return to !== from && samples.some((s) => s.name === to) ? NAME_EXISTS_ERROR : undefined;
}

export interface SamplePickerProps {
	readonly samples: readonly BloblangSample[];
	readonly selected: string | null;
	/** The samples file can't be read: every control is disabled. */
	readonly disabled: boolean;
	readonly onSwitch: (name: string) => void;
	readonly onNew: () => void;
	/** Renames the selected sample to `to` (trimmed, valid, not its name). */
	readonly onRename: (to: string) => void;
	readonly onDelete: () => void;
	/** The previous step's title (4.18); none: no From previous step. */
	readonly previousStep?: string;
	readonly onFromPrevious?: () => void;
}

export function SamplePicker({ samples, selected, disabled, onSwitch, onNew, onRename, onDelete, previousStep, onFromPrevious }: SamplePickerProps) {
	/** The rename field's text; `undefined`: not renaming. */
	const [draft, setDraft] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const field = useRef<HTMLInputElement>(null);
	const picker = useRef<HTMLSelectElement>(null);
	/** Where focus goes once the rename field closes. */
	const refocus = useRef(false);
	const renaming = draft !== undefined && selected !== null && !disabled;

	// Another selection, or a field that can't show (unreadable file, nothing selected), cancels the rename.
	useEffect(() => {
		setDraft(undefined);
		setError(undefined);
	}, [selected, disabled]);

	useEffect(() => {
		if (renaming) {
			field.current?.focus();
			field.current?.select();
		} else if (refocus.current) {
			refocus.current = false;
			picker.current?.focus();
		}
	}, [renaming]);

	const close = (focus: boolean) => {
		refocus.current = focus;
		setDraft(undefined);
		setError(undefined);
	};

	const save = () => {
		if (draft === undefined || selected === null) {
			return;
		}
		const why = renameError(draft, selected, samples);
		if (why) {
			setError(why);
			return;
		}
		const to = draft.trim();
		close(true);
		if (to !== selected) {
			onRename(to);
		}
	};

	return (
		<div className="rpcn-bl-samples">
			<label htmlFor={renaming ? 'rpcn-bl-sample-name' : 'rpcn-bl-sample'} className="rpcn-bl-samples-label">{SAMPLE_LABEL}</label>
			{renaming
				? (
					<span className="rpcn-bl-rename">
						<input
							id="rpcn-bl-sample-name" ref={field} className="rpcn-bl-sample-name" type="text" value={draft}
							aria-invalid={error !== undefined} aria-describedby={error ? 'rpcn-bl-rename-error' : undefined}
							onChange={(e) => {
								setDraft(e.target.value);
								setError(undefined);
							}}
							onKeyDown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									save();
								} else if (e.key === 'Escape') {
									// Esc cancels the rename; it does not reach the panel's Esc (back to the YAML, 4.11).
									e.preventDefault();
									e.stopPropagation();
									close(true);
								}
							}}
							onBlur={() => close(false)}
						/>
						{error && <span id="rpcn-bl-rename-error" className="rpcn-bl-rename-error" role="alert">{error}</span>}
					</span>
				)
				: (
					<select
						id="rpcn-bl-sample" ref={picker} className="rpcn-bl-sample" value={selected ?? ''}
						disabled={disabled || samples.length === 0}
						onChange={(e) => {
							if (e.target.value !== '' && e.target.value !== selected) {
								onSwitch(e.target.value);
							}
						}}
					>
						{selected === null && <option value="" disabled>{UNSAVED_INPUT}</option>}
						{samples.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
					</select>
				)}
			<button type="button" className="rpcn-bl-btn rpcn-bl-new" disabled={disabled} onClick={onNew}>{NEW_SAMPLE_LABEL}</button>
			<button
				type="button" className="rpcn-bl-btn rpcn-bl-rename-btn" disabled={disabled || selected === null || renaming}
				onMouseDown={(e) => e.preventDefault()}
				onClick={() => {
					setDraft(selected ?? '');
					setError(undefined);
				}}
			>
				{RENAME_LABEL}
			</button>
			<button type="button" className="rpcn-bl-btn rpcn-bl-delete" disabled={disabled || selected === null} onClick={onDelete}>{DELETE_LABEL}</button>
			{previousStep !== undefined && (
				<button
					type="button" className="rpcn-bl-btn rpcn-bl-from-prev" disabled={disabled} aria-label={fromPreviousName(previousStep)}
					onClick={onFromPrevious}
				>
					{FROM_PREVIOUS_LABEL}
				</button>
			)}
		</div>
	);
}
