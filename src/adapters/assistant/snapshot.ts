// Story 8.12: a file's content just before the assistant first writes it in a run, so the view can show
// the turn's diff and undo it. Kept in memory only (the view holds it); a file over `SNAPSHOT_MAX_BYTES`
// is not read. Shared by the SDK adapter's PreToolUse hook and the scripted fake host. No `vscode` import.

import * as fs from 'fs';
import { SNAPSHOT_MAX_BYTES, type AssistantEvent } from './host';

/** The tools whose call writes the file in its input (`file_path`, or `notebook_path`). */
export const SNAPSHOT_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * The `fileChanging` event of `file` (absolute) as it is now: its text, `null` when it does not exist,
 * or `tooLarge`; `undefined` when it cannot be read (no snapshot, so no undo).
 */
export async function snapshotOf(file: string): Promise<Extract<AssistantEvent, { type: 'fileChanging' }> | undefined> {
	let size: number;
	try {
		const stat = await fs.promises.stat(file);
		if (!stat.isFile()) {
			return undefined;
		}
		size = stat.size;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { type: 'fileChanging', path: file, before: null } : undefined;
	}
	if (size > SNAPSHOT_MAX_BYTES) {
		return { type: 'fileChanging', path: file, before: null, tooLarge: true };
	}
	try {
		return { type: 'fileChanging', path: file, before: await fs.promises.readFile(file, 'utf8') };
	} catch {
		return undefined;
	}
}
