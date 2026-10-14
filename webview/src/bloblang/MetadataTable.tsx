// The Bloblang test panel's Key / Value tables (ticket 4.7): the input's, editable (text inputs,
// "+ Add metadata", a Remove button per row), and the output's, read-only with added and changed
// keys marked.

import type { ResultMeta } from '../../../src/shared/bloblangProtocol';
import { metaValueText, type MetaRow } from './changes';

export const ADD_METADATA_LABEL = '+ Add metadata';
export const REMOVE_LABEL = 'Remove';
export const NO_METADATA_TEXT = 'No metadata.';

/** An input row with the id React keys it by. */
export interface EditableRow extends MetaRow {
	readonly id: number;
}

export interface InputMetadataProps {
	readonly rows: readonly EditableRow[];
	readonly onChange: (index: number, row: MetaRow) => void;
	readonly onAdd: () => void;
	readonly onRemove: (index: number) => void;
	/** The id of the row whose key input takes focus when it appears (the one just added). */
	readonly focusId?: number;
	/** The `focusId` row's key input took focus: it must not take it again (a tab round trip). */
	readonly onFocused?: () => void;
}

export function InputMetadata({ rows, onChange, onAdd, onRemove, focusId, onFocused }: InputMetadataProps) {
	return (
		<div className="rpcn-bl-metawrap">
			<table className="rpcn-bl-meta">
				<thead><tr><th scope="col">Key</th><th scope="col">Value</th><th scope="col"><span className="rpcn-bl-sr">Actions</span></th></tr></thead>
				<tbody>
					{rows.map((row, i) => (
						<tr key={row.id}>
							<td>
								<input
									type="text"
									className="rpcn-bl-meta-key"
									spellCheck={false}
									aria-label={`Metadata key ${i + 1}`}
									autoFocus={row.id === focusId}
									onFocus={row.id === focusId ? onFocused : undefined}
									value={row.key}
									onChange={(e) => onChange(i, { key: e.target.value, value: row.value })}
								/>
							</td>
							<td>
								<input
									type="text"
									className="rpcn-bl-meta-value"
									spellCheck={false}
									aria-label={`Metadata value ${i + 1}`}
									value={row.value}
									onChange={(e) => onChange(i, { key: row.key, value: e.target.value })}
								/>
							</td>
							<td>
								<button type="button" className="rpcn-bl-link rpcn-bl-meta-remove" aria-label={`${REMOVE_LABEL} metadata row ${i + 1}`} onClick={() => onRemove(i)}>
									{REMOVE_LABEL}
								</button>
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<div className="rpcn-bl-addrow">
				<button type="button" className="rpcn-bl-link rpcn-bl-meta-add" onClick={onAdd}>{ADD_METADATA_LABEL}</button>
			</div>
		</div>
	);
}

export interface OutputMetadataProps {
	readonly meta: ResultMeta;
	/** Keys the run added or changed. */
	readonly marked: readonly string[];
}

export function OutputMetadata({ meta, marked }: OutputMetadataProps) {
	const keys = Object.keys(meta);
	if (keys.length === 0) {
		return <p className="rpcn-bl-note rpcn-bl-pad">{NO_METADATA_TEXT}</p>;
	}
	return (
		<div className="rpcn-bl-metawrap">
			<table className="rpcn-bl-meta">
				<thead><tr><th scope="col">Key</th><th scope="col">Value</th></tr></thead>
				<tbody>
					{keys.map((key) => (
						<tr key={key} className={marked.includes(key) ? 'rpcn-bl-mark' : undefined}>
							<td>{key}</td>
							<td>{metaValueText(meta[key] ?? null)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
