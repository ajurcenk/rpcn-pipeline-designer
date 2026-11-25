// The RPCN AI Assistant's view (story 8.1, AD-26; story 8.12: a chat, the prototype's option A): the
// header with New conversation, the stage strip (Design › Author › Test, Design ✓ once this
// conversation's note is `ready`; the target folder), the transcript (`Transcript.tsx`: the turns, and
// before them the reason a request cannot start, with its button, and "Skills: local copy"), and the
// composer (`Composer.tsx`). The current turn holds the skill's questions as cards (the skill's pick
// first and chosen until another is, an Other text answer) and the row saying the run waits for the
// approval dialog. Every state comes from the host; the view keeps only what is being typed and chosen,
// and which folded steps are open. Theme colours only.

import { useEffect, useState, type FormEvent } from 'react';
import {
	BAD_BASE_URL_TEXT, BAD_SKILLS_PATH_TEXT, BAD_SKILLS_PATH_TEXTS, BASE_URL_CHANGED_TEXT, LOCAL_SKILLS_TEXT, unavailableText,
	INSTALL_RUNTIME_LABEL, RETRY_LABEL, RUNTIME_INSTALLING_TEXT, RUNTIME_MISSING_TEXT, runtimeFailedText, runtimeOutdatedText, UPDATE_RUNTIME_LABEL, NO_ACCESS_TEXT, NO_BINARY_TEXT, NO_UV_TEXT, NO_WORKSPACE_TEXT, OPEN_SETTINGS_LABEL,
	NEW_CONVERSATION_LABEL, OTHER_LABEL, OTHER_PLACEHOLDER, parseAssistantHostMessage, SET_UP_ACCESS_LABEL, STAGES,
	type AssistantAccess, type AssistantRuntimeView, type SkillsPathProblem, type AssistantQuestionsView, type AssistantQuestionView, type AssistantStateMessage, type AssistantWebviewMessage,
} from '../../../src/shared/assistantProtocol';

import { Composer } from './Composer';
import { Transcript } from './Transcript';

/** Story 8.12: the header (option A's "RPCN ASSISTANT"). */
export const HEADER_TITLE = 'RPCN ASSISTANT';
export const SEND_ANSWERS_LABEL = 'Send answers';
export const WAITING_APPROVAL_TEXT = 'Waiting for your decision in the dialog.';

/** One card's choice: the chosen option labels, and the Other text when Other is chosen. */
interface Choice {
	readonly labels: readonly string[];
	readonly other: boolean;
	readonly otherText: string;
}

/** The first choices of a set of cards, by card index (review 20): each card's pick, else nothing. */
export function initialChoices(questions: AssistantQuestionsView): Choice[] {
	return questions.questions.map((q) => {
		const pick = q.options.find((o) => o.pick);
		return { labels: pick ? [pick.label] : [], other: false, otherText: '' };
	});
}

/** Each state a request cannot start in: its text, and its button (`undefined`: none). */
export function accessPanel(
	access: Exclude<AssistantAccess, 'ready'>, platform: string | null = null, skillsProblem: SkillsPathProblem | null = null, runtime: AssistantRuntimeView | null = null,
): { readonly text: string; readonly button?: { readonly label: string; readonly message: AssistantWebviewMessage } } {
	const install = { label: INSTALL_RUNTIME_LABEL, message: { type: 'installRuntimeRequested' } as const };
	const setUp = { label: SET_UP_ACCESS_LABEL, message: { type: 'setUpAccessRequested' } as const };
	const openSettings = { label: OPEN_SETTINGS_LABEL, message: { type: 'openSettingsRequested' } as const };
	switch (access) {
		case 'unavailable': return { text: unavailableText(platform ?? 'this platform') };
		case 'runtimeMissing': return { text: RUNTIME_MISSING_TEXT, button: install };
		case 'runtimeInstalling': return { text: RUNTIME_INSTALLING_TEXT };
		case 'runtimeOutdated': return {
			text: runtimeOutdatedText(runtime?.installed ?? 'another version', runtime?.pinned ?? 'a newer one'),
			button: { label: UPDATE_RUNTIME_LABEL, message: { type: 'updateRuntimeRequested' } },
		};
		case 'runtimeFailed': return { text: runtimeFailedText(runtime?.error ?? null), button: { label: RETRY_LABEL, message: install.message } };
		case 'badSkillsPath': return { text: skillsProblem ? BAD_SKILLS_PATH_TEXTS[skillsProblem] : BAD_SKILLS_PATH_TEXT, button: openSettings };
		case 'noAccess': return { text: NO_ACCESS_TEXT, button: setUp };
		case 'badBaseUrl': return { text: BAD_BASE_URL_TEXT, button: openSettings };
		case 'baseUrlChanged': return { text: BASE_URL_CHANGED_TEXT, button: setUp };
		case 'noBinary': return { text: NO_BINARY_TEXT };
		case 'noUv': return { text: NO_UV_TEXT };
		case 'noWorkspace': return { text: NO_WORKSPACE_TEXT };
	}
}

/** A card's answer, or `undefined` while it has none. */
export function answerOf(q: AssistantQuestionView, choice: Choice | undefined): string | undefined {
	if (!choice) {
		return undefined;
	}
	const other = choice.other ? choice.otherText.trim() : '';
	if (choice.other && !other) {
		return undefined;
	}
	const parts = q.multiSelect ? [...choice.labels, ...(other ? [other] : [])] : [other || choice.labels[0]].filter((p): p is string => !!p);
	return parts.length ? parts.join(', ') : undefined;
}

function QuestionCards({ questions, post }: { readonly questions: AssistantQuestionsView; readonly post: (m: AssistantWebviewMessage) => void }) {
	const [choices, setChoices] = useState<Choice[]>(() => initialChoices(questions));
	useEffect(() => setChoices(initialChoices(questions)), [questions.id]);
	const answers = questions.questions.map((q, i) => answerOf(q, choices[i]));
	const complete = answers.every((a) => a !== undefined);
	const set = (index: number, next: Choice) => setChoices((c) => c.map((x, i) => (i === index ? next : x)));
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (complete) {
			post({ type: 'answered', id: questions.id, answers: answers as string[] });
		}
	};
	return (
		<form className="rpcn-assistant-questions" onSubmit={submit}>
			{questions.questions.map((q, qi) => {
				const choice = choices[qi] ?? { labels: [], other: false, otherText: '' };
				const type = q.multiSelect ? 'checkbox' : 'radio';
				const name = `q-${questions.id}-${qi}`;
				return (
					<fieldset className="rpcn-assistant-card" key={qi}>
						<legend>{q.header || `Question ${qi + 1}`}</legend>
						<p className="rpcn-assistant-question">{q.question}</p>
						{q.options.map((o) => {
							const checked = choice.labels.includes(o.label);
							return (
								<label className={`rpcn-assistant-option${o.pick ? ' rpcn-assistant-pick' : ''}`} key={o.label}>
									<input
										type={type}
										name={name}
										value={o.label}
										checked={checked}
										onChange={() => set(qi, q.multiSelect
											? { ...choice, labels: checked ? choice.labels.filter((l) => l !== o.label) : [...choice.labels, o.label] }
											: { ...choice, labels: [o.label], other: false })}
									/>
									<span className="rpcn-assistant-option-label">{o.label}</span>
									{o.description ? <span className="rpcn-assistant-option-description">{o.description}</span> : null}
								</label>
							);
						})}
						<label className="rpcn-assistant-option rpcn-assistant-other">
							<input
								type={type}
								name={name}
								value={OTHER_LABEL}
								checked={choice.other}
								onChange={() => set(qi, q.multiSelect ? { ...choice, other: !choice.other } : { ...choice, labels: [], other: true })}
							/>
							<span className="rpcn-assistant-option-label">{OTHER_LABEL}</span>
							<input
								type="text"
								className="rpcn-assistant-other-text"
								aria-label={`${OTHER_LABEL}: ${q.header || q.question}`}
								placeholder={OTHER_PLACEHOLDER}
								value={choice.otherText}
								onChange={(e) => set(qi, { ...choice, other: true, labels: q.multiSelect ? choice.labels : [], otherText: e.target.value })}
							/>
						</label>
					</fieldset>
				);
			})}
			<button type="submit" disabled={!complete}>{SEND_ANSWERS_LABEL}</button>
		</form>
	);
}

function AccessPanel({ access, platform, skillsProblem, runtime, post }: {
	readonly access: Exclude<AssistantAccess, 'ready'>; readonly platform: string | null; readonly skillsProblem: SkillsPathProblem | null;
	readonly runtime: AssistantRuntimeView; readonly post: (m: AssistantWebviewMessage) => void;
}) {
	const panel = accessPanel(access, platform, skillsProblem, runtime);
	return (
		<section className="rpcn-assistant-state" role="status">
			<p className="rpcn-assistant-state-body">{panel.text}</p>
			{panel.button ? <button type="button" onClick={() => post(panel.button!.message)}>{panel.button.label}</button> : null}
		</section>
	);
}

export function AssistantView({ post }: { readonly post: (m: AssistantWebviewMessage) => void }) {
	const [state, setState] = useState<AssistantStateMessage | null>(null);
	const [text, setText] = useState('');
	useEffect(() => {
		const listener = (e: MessageEvent) => {
			const m = parseAssistantHostMessage(e.data);
			if (m) {
				setState(m);
			}
		};
		window.addEventListener('message', listener);
		post({ type: 'ready' });
		return () => window.removeEventListener('message', listener);
	}, [post]);

	const busy = state?.status === 'running' || state?.status === 'question' || state?.status === 'approval';
	const panel = state ? (
		<>
			{state.access !== 'ready' ? <AccessPanel access={state.access} platform={state.platform} skillsProblem={state.skillsProblem} runtime={state.runtime} post={post} /> : null}
			{state.skills === 'local' && state.access !== 'unavailable' ? <p className="rpcn-assistant-skills">{LOCAL_SKILLS_TEXT}</p> : null}
		</>
	) : null;
	const live = state ? (
		<>
			{state.questions ? <QuestionCards key={state.questions.id} questions={state.questions} post={post} /> : null}
			{state.status === 'approval' ? <p className="rpcn-assistant-waiting" role="status">{WAITING_APPROVAL_TEXT}</p> : null}
		</>
	) : null;

	return (
		<div className="rpcn-assistant">
			<header className="rpcn-assistant-header">
				<h1 className="rpcn-assistant-title">{HEADER_TITLE}</h1>
				{state && (state.turns.length > 0 || busy) ? (
					<button type="button" className="rpcn-assistant-new rpcn-assistant-secondary" onClick={() => post({ type: 'newConversation' })}>{NEW_CONVERSATION_LABEL}</button>
				) : null}
			</header>
			{state ? (
				<nav className="rpcn-assistant-stages" aria-label="Stages">
					<ol>
						{STAGES.map((stage, i) => (
							<li key={stage} className={`rpcn-assistant-stage${i === 0 && state.designReady ? ' rpcn-assistant-stage-done' : ''}`}>
								{i === 0 && state.designReady ? <span className="rpcn-assistant-stage-check" aria-label="done">✓ </span> : null}
								{stage}
							</li>
						))}
					</ol>
					{state.folder ? <span className="rpcn-assistant-folder" title="Target folder">{state.folder}</span> : null}
				</nav>
			) : null}
			{state ? (
				<Transcript
					state={state}
					panel={panel}
					live={live}
					post={post}
					insert={(command) => setText(`/${command} `)}
				/>
			) : null}
			{/* Review 4: the composer (and Stop) whenever a run is going, whatever the access says now. */}
			{state && (state.access === 'ready' || busy) ? <Composer text={text} setText={setText} busy={busy} post={post} /> : null}
		</div>
	);
}
