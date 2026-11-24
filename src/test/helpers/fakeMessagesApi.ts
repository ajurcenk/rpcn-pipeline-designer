// A local fake of the Anthropic Messages API (story 8.1, AD-26), ported from spike 65's offline run
// (`scripts/spike/assistant-host/check/fake-run.cjs`): one HTTP server on 127.0.0.1, so the embedded
// Agent SDK runs end to end with no model call.
//   - `POST /v1/messages`: the main conversation (a request whose tools include `AskUserQuestion`) is
//     scripted as `turns`, one per assistant turn so far: a `tool_use` turn, or a text turn; after the
//     script, a final text turn. Any other call (a side request) gets a short text answer. Streaming
//     (SSE, the standard event sequence) when the request asks for it, else JSON.
//   - `POST /v1/messages/count_tokens`: `{ input_tokens }`.
//   - Anything else: 404 in Anthropic's error format.
//   - `failure`: every Messages call answered with that status and body instead (ADP's 401 by default).
// Every request is recorded (method, path, headers, body), and each tool result the conversation sends
// back, by the `tool_use` id the script gave it (`toolu_fake_<turn>`), for the tests' checks.

import * as http from 'http';
import type { AddressInfo } from 'net';

export type FakeTurn =
	| { readonly tool: string; readonly input: Record<string, unknown> }
	| { readonly text: string };

export interface FakeMessagesRequest {
	readonly method: string;
	readonly path: string;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: string;
	/** Whether it was a main-conversation call (its tools include `AskUserQuestion`). */
	readonly main: boolean;
	readonly model: unknown;
}

export interface FakeToolResult {
	readonly isError: boolean;
	readonly text: string;
}

/** ADP's own 401 (spike 65, capture 07): `code`, `message`, `details[{@type, reason, domain}]`. */
export const ADP_401 = {
	status: 401,
	body: { code: 16, message: 'invalid api key', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'UNAUTHENTICATED', domain: 'adp' }] },
};

export const FINAL_TEXT = 'Fake answer: done.';

export const toolUseId = (turn: number) => `toolu_fake_${String(turn).padStart(2, '0')}`;

export class FakeMessagesApi {
	readonly requests: FakeMessagesRequest[] = [];
	/** The tool results sent back, by `tool_use` id. */
	readonly results = new Map<string, FakeToolResult>();
	turns: readonly FakeTurn[] = [];
	failure: { readonly status: number; readonly body: unknown } | undefined;
	/** Waits this long before answering each main-conversation call (a slow model turn). */
	delayMs = 0;
	private server: http.Server | undefined;
	private port = 0;

	get url(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** The main-conversation calls so far. */
	get mainCalls(): FakeMessagesRequest[] {
		return this.requests.filter((r) => r.main);
	}

	async start(): Promise<void> {
		this.server = http.createServer((req, res) => {
			let raw = '';
			req.on('data', (d: Buffer) => {
				raw += d.toString('utf8');
			});
			req.on('end', () => {
				void this.answer(req, res, raw).catch(() => {
					if (!res.headersSent) {
						res.writeHead(500);
					}
					res.end();
				});
			});
		});
		await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
		this.port = (this.server.address() as AddressInfo).port;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (server) {
			server.closeAllConnections?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	/** Forgets the recorded requests and results (the script stays). */
	reset(): void {
		this.requests.length = 0;
		this.results.clear();
	}

	private async answer(req: http.IncomingMessage, res: http.ServerResponse, raw: string): Promise<void> {
		let body: Record<string, unknown> = {};
		try {
			body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
		} catch {
			// not JSON
		}
		const urlPath = (req.url ?? '').replace(/\?.*$/, '');
		const tools = Array.isArray(body.tools) ? (body.tools as { name?: unknown }[]).map((t) => t.name) : [];
		const main = tools.includes('AskUserQuestion');
		this.requests.push({ method: req.method ?? '', path: urlPath, headers: req.headers, body: raw, main, model: body.model });
		const messages = Array.isArray(body.messages) ? body.messages as { role?: unknown; content?: unknown }[] : [];
		for (const m of messages) {
			if (m.role !== 'user' || !Array.isArray(m.content)) {
				continue;
			}
			for (const b of m.content as Record<string, unknown>[]) {
				if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
					this.results.set(b.tool_use_id, { isError: b.is_error === true, text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
				}
			}
		}
		const json = (status: number, value: unknown) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(value));
		};
		if (urlPath === '/v1/messages/count_tokens') {
			json(200, { input_tokens: 10 });
			return;
		}
		if (urlPath !== '/v1/messages') {
			json(404, { type: 'error', error: { type: 'not_found_error', message: 'Not found' } });
			return;
		}
		if (this.failure) {
			json(this.failure.status, this.failure.body);
			return;
		}
		if (main && this.delayMs > 0) {
			await new Promise((r) => setTimeout(r, this.delayMs));
		}
		const step = main ? messages.filter((m) => m.role === 'assistant').length : -1;
		const turn: FakeTurn = main && step < this.turns.length ? this.turns[step] : { text: main ? FINAL_TEXT : 'ok' };
		const usage = { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
		const id = 'tool' in turn ? toolUseId(step) : undefined;
		const block = 'tool' in turn ? { type: 'tool_use', id, name: turn.tool, input: turn.input } : { type: 'text', text: turn.text };
		const stop = 'tool' in turn ? 'tool_use' : 'end_turn';
		const msg = { id: `msg_fake_${this.requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [] as unknown[], stop_reason: null, stop_sequence: null, usage };
		if (!body.stream) {
			json(200, { ...msg, content: [block], stop_reason: stop });
			return;
		}
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		const ev = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		ev('message_start', { type: 'message_start', message: msg });
		if ('tool' in turn) {
			ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: turn.tool, input: {} } });
			ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(turn.input) } });
		} else {
			ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
			ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } });
		}
		ev('content_block_stop', { type: 'content_block_stop', index: 0 });
		ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
		ev('message_stop', { type: 'message_stop' });
		res.end();
	}
}
