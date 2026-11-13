// Pure: the 1-based line of an offset in a text (story 50: written once for the Cloud check, the
// Bloblang names and the Cloud translation). No imports.

/** The 1-based line of `offset` in `text`. */
export function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) {
		line++;
	}
	return line;
}

/** The 1-based line of each offset of `text`, by a running count (offsets in increasing order). */
export function lineCounter(text: string): (offset: number) => number {
	let at = 0;
	let line = 1;
	return (offset) => {
		for (; at < offset; at++) {
			if (text.charCodeAt(at) === 10) {
				line++;
			}
		}
		return line;
	};
}
