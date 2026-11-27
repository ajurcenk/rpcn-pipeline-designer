// The chat's transcript (story 8.12): before any turn, the panel saying why a request cannot start (with
// its one button) and the "Skills: local copy" line; then the turns, oldest first, the latest with what
// its run needs now (`live`) and the run's error line (story 8.3: and after it, `turnPanel`: the
// unreachable state's panel). An error with no turn to hold it stands alone.

import type { ReactNode } from 'react';
import type { AssistantCommand, AssistantStateMessage, AssistantWebviewMessage } from '../../../src/shared/assistantProtocol';
import { Turn } from './Turn';

export const EMPTY_TEXT = 'Describe the pipeline you want. Type / for the commands.';

export function Transcript({ state, panel, live, turnPanel, post, insert }: {
	readonly state: AssistantStateMessage;
	/** The access panel and the skills line (`null`: none). */
	readonly panel: ReactNode;
	readonly live: ReactNode;
	/** Story 8.3: a panel for the latest turn, after its error line (`null`: none). */
	readonly turnPanel?: ReactNode;
	readonly post: (m: AssistantWebviewMessage) => void;
	readonly insert: (command: AssistantCommand) => void;
}) {
	const last = state.turns.at(-1);
	const loneError = state.error && !(last && last.outcome === 'error') ? state.error : null;
	return (
		<div className="rpcn-assistant-transcript" aria-label="Conversation">
			{panel}
			{state.turns.length === 0 && (state.access === 'ready' || state.access === 'unreachable') ? <p className="rpcn-assistant-empty">{EMPTY_TEXT}</p> : null}
			{state.turns.map((t) => (
				<Turn
					key={t.id}
					turn={t}
					latest={t === last}
					live={t === last && t.outcome === 'running' ? live : undefined}
					error={t === last ? state.error : null}
					after={t === last ? turnPanel : undefined}
					post={post}
					insert={insert}
				/>
			))}
			{loneError ? <p className="rpcn-assistant-error" role="alert">{loneError}</p> : null}
		</div>
	);
}
