// Ticket 46: the files one `redpandaConnect.resourceFiles` entry names, as the binary reads it
// (`--resources` takes Go `filepath.Glob` patterns; probed on 4.112.0: `r[1-2].yaml` reads both
// files, a pattern that matches nothing reads none and is no error). No `vscode` import, so the
// corpus harness checks it against the pinned binaries.

import * as fs from 'fs';
import * as path from 'path';

const GLOB_META = /[*?[]/;

/**
 * Go's `filepath.Match` pattern for one path segment as a RegExp: `*` any run and `?` any one
 * character but the separator, `[...]` a class (`^` negates, `a-z` ranges), `\` escapes (not on
 * Windows, where it is the separator). `undefined` for a malformed pattern (Go's `ErrBadPattern`:
 * the binary matches nothing). Pure.
 */
export function globSegmentRegExp(segment: string, windows = process.platform === 'win32'): RegExp | undefined {
	const escape = (c: string) => c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
	let out = '';
	for (let i = 0; i < segment.length; i++) {
		const c = segment[i];
		if (c === '*') {
			out += '[^/\\\\]*';
		} else if (c === '?') {
			out += '[^/\\\\]';
		} else if (c === '\\' && !windows) {
			if (++i >= segment.length) {
				return undefined;
			}
			out += escape(segment[i]);
		} else if (c === '[') {
			// As Go's `matchChunk` / `getEsc`: `-` and `]` only as a range's dash and the closing bracket.
			let j = i + 1;
			const negated = segment[j] === '^';
			if (negated) {
				j++;
			}
			const getEsc = (): string | undefined => {
				let ch = segment[j];
				if (j >= segment.length || ch === '-' || ch === ']') {
					return undefined;
				}
				if (ch === '\\' && !windows) {
					if (++j >= segment.length) {
						return undefined;
					}
					ch = segment[j];
				}
				j++;
				return ch;
			};
			const parts: string[] = [];
			while (!(segment[j] === ']' && parts.length > 0)) {
				const lo = getEsc();
				if (lo === undefined) {
					return undefined;
				}
				if (segment[j] === '-') {
					j++;
					const hi = getEsc();
					if (hi === undefined) {
						return undefined;
					}
					parts.push(hi < lo ? '' : `${escape(lo)}-${escape(hi)}`); // a reversed range matches nothing, as in Go
				} else {
					parts.push(escape(lo));
				}
			}
			out += `[${negated ? '^/\\\\' : ''}${parts.join('')}]`;
			i = j;
		} else {
			out += escape(c);
		}
	}
	return new RegExp(`^${out}$`);
}

/**
 * The files one `redpandaConnect.resourceFiles` entry names, as the binary reads it: the path
 * itself without glob characters, else Go's `filepath.Glob` (`*`, `?`, `[...]` within one path
 * segment, no `**`; dot files match too; each directory's matches sorted), existing paths only.
 * None when nothing matches or the pattern is malformed. Never throws.
 */
export function expandResourceEntry(entry: string): string[] {
	if (!GLOB_META.test(entry)) {
		return [entry];
	}
	const parsed = path.parse(entry);
	const segments = entry.slice(parsed.root.length).split(path.sep).filter((s) => s !== '');
	let current = [parsed.root || '.'];
	for (const segment of segments) {
		if (!GLOB_META.test(segment)) {
			current = current.map((dir) => path.join(dir, segment));
			continue;
		}
		const pattern = globSegmentRegExp(segment);
		if (!pattern) {
			return [];
		}
		const next: string[] = [];
		for (const dir of current) {
			let names: string[];
			try {
				names = fs.readdirSync(dir).sort();
			} catch {
				continue;
			}
			next.push(...names.filter((n) => pattern.test(n)).map((n) => path.join(dir, n)));
		}
		current = next;
	}
	return current.filter((p) => fs.existsSync(p));
}
