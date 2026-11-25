// The assistant's reply as Markdown (story 8.12): a small hand-written renderer that builds React
// elements, so there is no HTML path at all (no `innerHTML`, no raw HTML passed through: `<script>` is
// text). It knows paragraphs, headings, bold, italic, inline code, fenced code, lists (flat), links
// and tables. A link is a focusable element without an `href`: a click posts `openLink` to the host,
// which opens only http(s) links and workspace files; a link of any other kind is plain text.

import { Fragment, type KeyboardEvent, type ReactNode } from 'react';

export type OpenLink = (href: string) => void;

/** Whether a link may be offered: http(s), or a path with no scheme (the host checks it is in the workspace). */
export function linkable(href: string): boolean {
	const h = href.trim();
	if (/^https?:\/\//i.test(h)) {
		return true;
	}
	return h !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith('//');
}

// `code`, **bold**, __bold__, *italic*, _italic_, [text](href).
const INLINE = /(`+)([\s\S]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*(?!\s)([\s\S]+?)\*|(?<![\p{L}\p{N}])_(?!\s)([\s\S]+?)_(?![\p{L}\p{N}])|\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/u;

function Link({ href, children, openLink }: { readonly href: string; readonly children: ReactNode; readonly openLink: OpenLink }) {
	const open = () => openLink(href);
	return (
		<a
			className="rpcn-assistant-link"
			role="link"
			tabIndex={0}
			title={href}
			onClick={(e) => {
				e.preventDefault();
				open();
			}}
			onKeyDown={(e: KeyboardEvent) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					open();
				}
			}}
		>
			{children}
		</a>
	);
}

/** Inline Markdown as React nodes. */
export function inline(text: string, openLink: OpenLink, key = 'i'): ReactNode[] {
	const out: ReactNode[] = [];
	let rest = text;
	let n = 0;
	while (rest !== '') {
		const m = INLINE.exec(rest);
		if (!m) {
			out.push(rest);
			break;
		}
		if (m.index > 0) {
			out.push(rest.slice(0, m.index));
		}
		const k = `${key}-${n++}`;
		if (m[1] !== undefined) {
			out.push(<code key={k}>{m[2]}</code>);
		} else if (m[3] !== undefined || m[4] !== undefined) {
			out.push(<strong key={k}>{inline(m[3] ?? m[4], openLink, k)}</strong>);
		} else if (m[5] !== undefined || m[6] !== undefined) {
			out.push(<em key={k}>{inline(m[5] ?? m[6], openLink, k)}</em>);
		} else {
			const label = inline(m[7], openLink, k);
			out.push(linkable(m[8]) ? <Link key={k} href={m[8]} openLink={openLink}>{label}</Link> : <Fragment key={k}>{label}</Fragment>);
		}
		rest = rest.slice(m.index + m[0].length);
	}
	return out;
}

const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
	return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** Markdown text as React block elements. */
export function blocks(text: string, openLink: OpenLink): ReactNode[] {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	const out: ReactNode[] = [];
	let i = 0;
	const key = () => `b${out.length}`;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === '') {
			i++;
			continue;
		}
		const fence = FENCE.exec(line);
		if (fence) {
			const body: string[] = [];
			i++;
			while (i < lines.length && !lines[i].trim().startsWith(fence[1])) {
				body.push(lines[i]);
				i++;
			}
			i++;
			out.push(<pre key={key()} className="rpcn-assistant-code"><code>{body.join('\n')}</code></pre>);
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			const level = Math.min(heading[1].length + 2, 6);
			const Tag = `h${level}` as 'h3' | 'h4' | 'h5' | 'h6';
			out.push(<Tag key={key()} className="rpcn-assistant-heading">{inline(heading[2], openLink, key())}</Tag>);
			i++;
			continue;
		}
		if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
			const head = cells(line);
			const rows: string[][] = [];
			i += 2;
			while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
				rows.push(cells(lines[i]));
				i++;
			}
			const k = key();
			out.push(
				<div key={k} className="rpcn-assistant-table-wrap">
					<table className="rpcn-assistant-table">
						<thead><tr>{head.map((c, ci) => <th key={ci}>{inline(c, openLink, `${k}-h${ci}`)}</th>)}</tr></thead>
						<tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, ci) => <td key={ci}>{inline(r[ci] ?? '', openLink, `${k}-${ri}-${ci}`)}</td>)}</tr>)}</tbody>
					</table>
				</div>,
			);
			continue;
		}
		const item = ITEM.exec(line);
		if (item) {
			const ordered = /\d/.test(item[1]);
			const items: string[] = [];
			while (i < lines.length) {
				const it = ITEM.exec(lines[i]);
				if (it && /\d/.test(it[1]) === ordered) {
					items.push(it[2]);
				} else if (lines[i].trim() !== '' && /^\s+/.test(lines[i]) && items.length > 0 && !ITEM.test(lines[i])) {
					items[items.length - 1] += ` ${lines[i].trim()}`;
				} else {
					break;
				}
				i++;
			}
			const k = key();
			const children = items.map((t, ii) => <li key={ii}>{inline(t, openLink, `${k}-${ii}`)}</li>);
			out.push(ordered ? <ol key={k}>{children}</ol> : <ul key={k}>{children}</ul>);
			continue;
		}
		const para: string[] = [];
		while (i < lines.length && lines[i].trim() !== '' && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !ITEM.test(lines[i])
			&& !(lines[i].includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]))) {
			para.push(lines[i].trim());
			i++;
		}
		const k = key();
		out.push(<p key={k}>{inline(para.join(' '), openLink, k)}</p>);
	}
	return out;
}

export function Markdown({ text, openLink }: { readonly text: string; readonly openLink: OpenLink }) {
	return <div className="rpcn-assistant-reply">{blocks(text, openLink)}</div>;
}
