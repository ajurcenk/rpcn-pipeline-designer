// The composer (story 8.12): Enter sends, Shift+Enter starts a new line. Typing `/` at the start opens
// the list of `/design`, `/build` and `/test` (narrowed as more is typed): the arrow keys move through it,
// Enter or Tab picks (the command and a space are inserted), Escape closes it. `/build` and `/test` can be
// picked but not sent yet: Send is off, with the command's hint. A message with no command is `/design`.
// While a run goes the composer stays, and Send becomes Stop. The text is the parent's (a chip sets it).

import { useState, type KeyboardEvent } from 'react';
import {
	ASSISTANT_COMMANDS, COMMAND_DESCRIPTIONS, COMMAND_HINTS, MAX_REQUEST_CHARS, parseCommand, REQUEST_PLACEHOLDER,
	type AssistantCommand, type AssistantWebviewMessage,
} from '../../../src/shared/assistantProtocol';

export const SEND_LABEL = 'Send';
export const STOP_LABEL = 'Stop';

/** The commands the list offers for `text` (`undefined`: no list: the text is no bare `/…` start). */
export function commandsFor(text: string): AssistantCommand[] | undefined {
	const m = /^\/(\S*)$/.exec(text);
	return m ? ASSISTANT_COMMANDS.filter((c) => c.startsWith(m[1])) : undefined;
}

/** What Send would post for `text`, or why not (`hint`: the command is not offered yet). */
export function sendable(text: string): { readonly command: AssistantCommand; readonly ok: boolean; readonly hint: string | null } {
	const parsed = parseCommand(text);
	const command = parsed.command ?? 'design';
	const hint = COMMAND_HINTS[command];
	return { command, ok: hint === null && parsed.rest !== '', hint };
}

export function Composer({ text, setText, busy, post }: {
	readonly text: string; readonly setText: (text: string) => void; readonly busy: boolean; readonly post: (m: AssistantWebviewMessage) => void;
}) {
	const [index, setIndex] = useState(0);
	const [closed, setClosed] = useState(false);
	const offered = closed ? undefined : commandsFor(text);
	const list = offered && offered.length > 0 ? offered : undefined;
	const at = list ? Math.min(index, list.length - 1) : 0;
	const send = sendable(text);

	const change = (value: string) => {
		setText(value);
		setClosed(false);
		setIndex(0);
	};
	const pick = (command: AssistantCommand) => {
		setText(`/${command} `);
		setClosed(true);
	};
	const submit = () => {
		if (!busy && send.ok) {
			post({ type: 'runRequested', command: send.command, request: text.trim() });
			setText('');
		}
	};
	const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (list) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				setIndex((at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length);
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				pick(list[at]);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				setClosed(true);
				return;
			}
		}
		if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			submit();
		}
	};

	return (
		<div className="rpcn-assistant-composer">
			{list ? (
				<ul className="rpcn-assistant-commands" role="listbox" aria-label="Commands" id="rpcn-assistant-commands">
					{list.map((c, i) => (
						<li
							key={c}
							id={`rpcn-assistant-command-${c}`}
							role="option"
							aria-selected={i === at}
							aria-disabled={COMMAND_HINTS[c] !== null || undefined}
							className={`rpcn-assistant-command-option${i === at ? ' rpcn-assistant-command-active' : ''}${COMMAND_HINTS[c] !== null ? ' rpcn-assistant-command-off' : ''}`}
							onMouseDown={(e) => {
								e.preventDefault();
								pick(c);
							}}
						>
							<span className="rpcn-assistant-command-name">/{c}</span>
							<span className="rpcn-assistant-command-description">{COMMAND_HINTS[c] ?? COMMAND_DESCRIPTIONS[c]}</span>
						</li>
					))}
				</ul>
			) : null}
			<textarea
				aria-label="Message"
				placeholder={REQUEST_PLACEHOLDER}
				maxLength={MAX_REQUEST_CHARS}
				value={text}
				rows={3}
				aria-expanded={list ? true : undefined}
				aria-controls={list ? 'rpcn-assistant-commands' : undefined}
				aria-activedescendant={list ? `rpcn-assistant-command-${list[at]}` : undefined}
				onChange={(e) => change(e.target.value)}
				onKeyDown={keyDown}
			/>
			<div className="rpcn-assistant-composer-bar">
				{send.hint ? <span className="rpcn-assistant-hint" role="status">{send.hint}</span> : <span />}
				{busy ? (
					<button type="button" className="rpcn-assistant-stop" onClick={() => post({ type: 'stopRequested' })}>{STOP_LABEL}</button>
				) : (
					<button type="button" className="rpcn-assistant-send" disabled={!send.ok} onClick={submit}>{SEND_LABEL}</button>
				)}
			</div>
		</div>
	);
}
