// A scripted, in-memory `AssistantHost` (story 8.1, AD-26): the integration suites run the assistant
// view against it without the SDK or a model. Each run plays `script` in order:
//   { emit }         sends one event;
//   { write }        writes a file in the run's workspace folder, then sends its `fileWritten`;
//   { waitAnswer }   waits for `answer(id, …)` of the question it names (send the `question` first);
//   { waitApproval } waits for `approve(id, …)`;
//   { delayMs }      waits that long.
// A script that ends without a `result` or `error` gets `{ result, stopped: false }`. `cancel` stops the
// script where it is: the open wait is refused and the run's last event is `{ result, stopped: true }`.
// Every run is recorded (its config, request, answers, approvals, events). No vscode or SDK import.

import * as fs from 'fs';
import * as path from 'path';
import type {
	AssistantAnswers, AssistantEvent, AssistantHost, AssistantHostConfig, AssistantHostFactory, AssistantListener, AssistantQuestion, AssistantRequest,
} from '../../adapters/assistant/host';

export type FakeAssistantStep =
	| { readonly emit: AssistantEvent }
	| { readonly write: { readonly file: string; readonly content: string } }
	| { readonly waitAnswer: string }
	| { readonly waitApproval: string }
	| { readonly delayMs: number };

/** Spike 65 run 2's two questions, as `rpcn-design` asked them (the pick marked "(My pick)", not first). */
export const RUN_2_QUESTIONS: readonly AssistantQuestion[] = [
	{
		question: 'Do orders need to reach the API in order?', header: 'Ordering', multiSelect: false,
		options: [
			{ label: 'Per customer_id', description: 'Keep each customer\'s orders in order' },
			{ label: 'No ordering (My pick)', description: 'Fastest; the API does not depend on order' },
			{ label: 'Overall', description: 'One at a time, in topic order' },
		],
	},
	{
		question: 'What should happen to duplicate orders?', header: 'Duplicates', multiSelect: false,
		options: [
			{ label: 'No dedupe (My pick)', description: 'At-least-once; the API tolerates a repeat' },
			{ label: 'Dedupe on order id', description: 'A cache keyed on the order id' },
			{ label: 'API dedupes on id', description: 'Rely on the API' },
		],
	},
];

/** A `ready` design note as `rpcn-design` writes one (its handoff header; the body shortened). */
export function readyNote(pipeline: string, status = 'ready'): string {
	return `---\nartifact: design\nformat: design@1\npipeline: ${pipeline}\nstatus: ${status}\nproduced_by: rpcn-design@0.1.0\nrpcn_version: 4.112.0\ninputs: []\nupdated: 2026-11-24\n---\n\n# ${pipeline}\n\nA fake note.\n`;
}

/** The happy path: progress, the two questions, then the note written and the run done. */
export function happyScript(pipeline = 'orders_to_api'): FakeAssistantStep[] {
	return [
		{ emit: { type: 'progress', text: 'Running the rpcn-design skill' } },
		{ emit: { type: 'progress', text: 'Checking with rpcn_check binary' } },
		{ emit: { type: 'question', id: 'q1', questions: RUN_2_QUESTIONS } },
		{ waitAnswer: 'q1' },
		{ emit: { type: 'progress', text: `Writing ${pipeline}.design.md` } },
		{ write: { file: `${pipeline}.design.md`, content: readyNote(pipeline) } },
		{ emit: { type: 'result', stopped: false, text: 'The design note is ready.' } },
	];
}

export class FakeAssistantHost implements AssistantHost {
	readonly requests: AssistantRequest[] = [];
	readonly events: AssistantEvent[] = [];
	readonly answers = new Map<string, AssistantAnswers | undefined>();
	readonly approvals = new Map<string, boolean>();
	cancelled = false;
	private waiting: { readonly id: string; readonly resolve: () => void } | undefined;
	private stopped = false;

	constructor(readonly config: AssistantHostConfig, private readonly script: readonly FakeAssistantStep[]) {}

	async start(request: AssistantRequest, listener: AssistantListener): Promise<void> {
		this.requests.push(request);
		let ended = false;
		const emit = (event: AssistantEvent) => {
			if (ended) {
				return;
			}
			ended = event.type === 'result' || event.type === 'error';
			this.events.push(event);
			listener(event);
		};
		for (const step of this.script) {
			if (this.stopped || ended) {
				break;
			}
			if ('emit' in step) {
				emit(step.emit);
			} else if ('write' in step) {
				const file = path.resolve(this.config.workspace, step.write.file);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, step.write.content);
				emit({ type: 'fileWritten', path: file });
			} else if ('waitAnswer' in step) {
				await this.wait(step.waitAnswer, () => this.answers.has(step.waitAnswer));
			} else if ('waitApproval' in step) {
				await this.wait(step.waitApproval, () => this.approvals.has(step.waitApproval));
			} else {
				await new Promise((r) => setTimeout(r, step.delayMs));
			}
		}
		emit(this.stopped ? { type: 'result', stopped: true } : { type: 'result', stopped: false });
	}

	answer(id: string, answers: AssistantAnswers | undefined): void {
		this.answers.set(id, answers);
		if (this.waiting?.id === id) {
			this.waiting.resolve();
		}
	}

	approve(id: string, allow: boolean): void {
		this.approvals.set(id, allow);
		if (this.waiting?.id === id) {
			this.waiting.resolve();
		}
	}

	cancel(): void {
		this.cancelled = true;
		this.stopped = true;
		this.waiting?.resolve();
	}

	/** Whether the run waits on `id` now. */
	isWaitingOn(id: string): boolean {
		return this.waiting?.id === id;
	}

	private wait(id: string, done: () => boolean): Promise<void> {
		if (done() || this.stopped) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.waiting = {
				id, resolve: () => {
					this.waiting = undefined;
					resolve();
				},
			};
		});
	}
}

/** The factory a suite hands the view: every run gets a new host playing `script`. */
export class FakeAssistantHosts {
	readonly made: FakeAssistantHost[] = [];

	constructor(public script: readonly FakeAssistantStep[]) {}

	readonly factory: AssistantHostFactory = (config) => {
		const host = new FakeAssistantHost(config, this.script);
		this.made.push(host);
		return host;
	};

	get last(): FakeAssistantHost | undefined {
		return this.made[this.made.length - 1];
	}
}
