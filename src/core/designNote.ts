// The design note's handoff header (story 8.1, AD-26 "stage from files"): the `status` of a
// `<name>.design.md` note's frontmatter, read from the text on disk. Ported from spike 65's status
// parse; only the `---` block at the very start counts. Pure.

/** Whether a file name is a design note's. */
export function isDesignNote(fileName: string): boolean {
	return /\.design\.md$/.test(fileName);
}

/** The frontmatter `status` of a note (quotes and a trailing comment dropped); `null` when it has none. */
export function designNoteStatus(text: string): string | null {
	const lines = text.replace(/^﻿/, '').split(/\r?\n/);
	if (lines[0]?.trim() !== '---') {
		return null;
	}
	// Review 19: a frontmatter that never closes is not one.
	const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
	if (end < 0) {
		return null;
	}
	for (let i = 1; i < end; i++) {
		const m = /^status:\s*(.*)$/.exec(lines[i]);
		if (m) {
			const raw = m[1].trim();
			// A quoted value keeps a `#` inside its quotes; an unquoted one ends at a ` #` comment.
			const quoted = /^(['"])(.*?)\1(\s+#.*)?$/.exec(raw);
			const value = (quoted ? quoted[2] : raw.replace(/\s+#.*$/, '')).trim();
			return value === '' ? null : value;
		}
	}
	return null;
}
