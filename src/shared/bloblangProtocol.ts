// The host<->webview contract of the Bloblang test panel (AD-5, ticket 4.2): every message of the
// second webview, as discriminated unions on `type`, plus the pure validators both sides use on
// what they receive. The panel adapter (`src/adapters/bloblangPanel`), the core run parser and
// `webview/src/bloblang` import it; no Bloblang panel message is defined anywhere else. This
// module imports nothing (AD-15).

/** The processor kinds the panel tests (AD-21). */
export type BloblangProcessorKind = 'mapping' | 'mutation';

/**
 * The outcome of one test run (AD-21): the output content, the mapping's own error on the input,
 * a deleted message, or a run that could not produce a result (the binary's stderr, verbatim).
 */
export type BloblangResult =
	| { readonly kind: 'ok'; readonly content: string }
	| { readonly kind: 'failed'; readonly message: string }
	| { readonly kind: 'deleted' }
	| { readonly kind: 'error'; readonly message: string };

/** host→webview */
export type BloblangHostMessage =
	/** The panel's whole state, sent on `ready`: its title and the processor's kind and Bloblang. */
	| { readonly type: 'snapshot'; readonly title: string; readonly kind: BloblangProcessorKind; readonly source: string }
	/** The result of the latest `run`, how long it took, and the binary that ran it (`null`: none). */
	| { readonly type: 'result'; readonly result: BloblangResult; readonly durationMs: number; readonly binary: string | null };

/** webview→host */
export type BloblangWebviewMessage =
	| { readonly type: 'ready' }
	/** Run the mapping on `input`, the message content as typed. */
	| { readonly type: 'run'; readonly input: string };

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isKind = (v: unknown): v is BloblangProcessorKind => v === 'mapping' || v === 'mutation';

function isResult(r: unknown): r is BloblangResult {
	if (!isObject(r)) {
		return false;
	}
	switch (r.kind) {
		case 'ok':
			return isString(r.content);
		case 'failed':
		case 'error':
			return isString(r.message);
		case 'deleted':
			return true;
		default:
			return false;
	}
}

/** Validates a message from the host; it is returned unchanged when well formed. */
export function parseBloblangHostMessage(message: unknown): BloblangHostMessage | undefined {
	try {
		if (!isObject(message)) {
			return undefined;
		}
		switch (message.type) {
			case 'snapshot':
				return isString(message.title) && isKind(message.kind) && isString(message.source)
					? message as unknown as BloblangHostMessage
					: undefined;
			case 'result':
				return isResult(message.result)
					&& typeof message.durationMs === 'number' && Number.isFinite(message.durationMs) && message.durationMs >= 0
					&& (message.binary === null || isString(message.binary))
					? message as unknown as BloblangHostMessage
					: undefined;
			default:
				return undefined;
		}
	} catch {
		return undefined;
	}
}

/** Validates a message from the webview; a fresh, typed copy with only the message's own fields. */
export function parseBloblangWebviewMessage(message: unknown): BloblangWebviewMessage | undefined {
	try {
		if (!isObject(message)) {
			return undefined;
		}
		switch (message.type) {
			case 'ready':
				return { type: 'ready' };
			case 'run':
				return isString(message.input) ? { type: 'run', input: message.input } : undefined;
			default:
				return undefined;
		}
	} catch {
		return undefined;
	}
}
