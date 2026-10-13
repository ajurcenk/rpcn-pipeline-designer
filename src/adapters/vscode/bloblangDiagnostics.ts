// Live Bloblang syntax diagnostics (ticket 4.5, AD-14, AD-21). While a detected `file:` config is
// edited, 300 ms after the last change, every `mapping` / `mutation` processor whose decoded
// Bloblang changed is parsed by the binary (`parseMapping`: `blobl --file`, stdin closed). Parse
// errors go to our own collection (`redpanda-connect-bloblang`, source `Bloblang`, Error) on the one
// character the 4.3 position map gives for the binary's `line L char C`. Other failures (an unset
// `${VAR}`, a timeout) give no diagnostic and one output-channel line per distinct message.
//
// Results are cached by text, so an unchanged processor never spawns again. Each processor path
// runs one parse at a time with the latest text pending. The collection is always rebuilt from the
// document's current processors and the cache, so a result for text that is no longer there is
// never shown. A file whose YAML does not parse, that closes or stops being detected, or any file
// while there is no usable binary, has none. A processor whose new text is still being parsed
// keeps its last diagnostic until the result. Only deterministic outcomes are cached (a parse, a
// parse error, an unset env var); a timeout or spawn failure is parsed again on the next trigger.
// Lint (AD-12) reads `liveErrorsFor` to hide its duplicate of a live error.

import * as vscode from 'vscode';
import type { BloblParseOutcome } from '../../core/bloblangParse';
import { bloblangProcessors } from '../../core/bloblangProcessors';
import type { BinaryState } from '../redpandaConnect/binary';
import type { DetectionView } from './diagnostics';
import { parsedDocument } from './parseCache';

export const BLOBLANG_SOURCE = 'Bloblang';
export const BLOBLANG_COLLECTION_NAME = 'redpanda-connect-bloblang';
export const BLOBLANG_DEBOUNCE_MS = 300;
/** Parses running at once, over all files (opening a file with many mappings spawns them all). */
const MAX_CONCURRENT = 4;
/** Cached outcomes kept (by text); the oldest goes first. */
const CACHE_SIZE = 1000;

/** What the service needs from VS Code (tests may pass fakes). */
export interface BloblangDiagnosticsSource {
	readonly textDocuments: readonly vscode.TextDocument[];
	readonly onDidChangeTextDocument: vscode.Event<vscode.TextDocumentChangeEvent>;
	readonly onDidCloseTextDocument: vscode.Event<vscode.TextDocument>;
	readonly onDidChangeConfiguration: vscode.Event<vscode.ConfigurationChangeEvent>;
	createDiagnosticCollection(name: string): vscode.DiagnosticCollection;
}

export interface BloblangDiagnosticsOptions {
	readonly detection: DetectionView;
	readonly binary: { readonly state: BinaryState; readonly onDidChange: vscode.Event<BinaryState> };
	/** Parses one mapping (`parseMapping` with the current binary state in production). */
	readonly parse: (source: string) => Promise<BloblParseOutcome>;
	readonly log: (line: string) => void;
	readonly debounceMs?: number;
	readonly source?: BloblangDiagnosticsSource;
}

/** A processor as last seen in its document. */
interface Current {
	readonly source: string;
	/** UTF-16 document offset of the `mapping` / `mutation` key. */
	readonly keyStart: number;
	readonly offsetAt: (line: number, char: number) => number;
}

/** A published live error, and the 1-based lines where lint would report its duplicate. */
export interface LiveBloblangError {
	/** The mapping key's line. */
	readonly firstLine: number;
	/** The line after the value's last character (lint puts a one-line mapping's error there). */
	readonly lastLine: number;
	/** The binary's message; lint's duplicate starts with it (lint appends `, got: …`). */
	readonly message: string;
}

interface Shown {
	readonly diagnostic: vscode.Diagnostic;
	readonly live: LiveBloblangError;
}

interface DocState {
	timer: NodeJS.Timeout | undefined;
	/** Processors by path, from the last debounced update; empty while the YAML does not parse. */
	current: Map<string, Current>;
	/** The published diagnostic per processor path. */
	shown: Map<string, Shown>;
}

interface Flight {
	/** The text being parsed. */
	running: string | undefined;
	/** The cache epoch the running parse started in. */
	runningEpoch: number;
	/** The latest text asked for while running. */
	pending: string | undefined;
}

export function defaultBloblangDiagnosticsSource(): BloblangDiagnosticsSource {
	return {
		get textDocuments() { return vscode.workspace.textDocuments; },
		onDidChangeTextDocument: vscode.workspace.onDidChangeTextDocument,
		onDidCloseTextDocument: vscode.workspace.onDidCloseTextDocument,
		onDidChangeConfiguration: vscode.workspace.onDidChangeConfiguration,
		createDiagnosticCollection: (name) => vscode.languages.createDiagnosticCollection(name),
	};
}

export class BloblangDiagnostics implements vscode.Disposable {
	private readonly docs = new Map<string, DocState>();
	/** Per `<uri>#<path>`. */
	private readonly flights = new Map<string, Flight>();
	private readonly cache = new Map<string, BloblParseOutcome>();
	private readonly logged = new Set<string>();
	private readonly collection: vscode.DiagnosticCollection;
	private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly parsedEmitter = new vscode.EventEmitter<string>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly source: BloblangDiagnosticsSource;
	private readonly debounceMs: number;
	private readonly queue: (() => void)[] = [];
	private active = 0;
	/** Bumped when cached outcomes stop being valid (binary or env file change). */
	private epoch = 0;
	private disposed = false;
	private parses = 0;
	private flying = 0;

	/** Fires with a URI whenever its Bloblang diagnostics (and so `linesFor`) change. */
	readonly onDidChangeDiagnostics: vscode.Event<vscode.Uri> = this.emitter.event;
	/** Fires with the text of every parse that ran (a test seam). */
	readonly onDidParse: vscode.Event<string> = this.parsedEmitter.event;

	constructor(private readonly options: BloblangDiagnosticsOptions) {
		this.source = options.source ?? defaultBloblangDiagnosticsSource();
		this.debounceMs = options.debounceMs ?? BLOBLANG_DEBOUNCE_MS;
		this.collection = this.source.createDiagnosticCollection(BLOBLANG_COLLECTION_NAME);
		this.subscriptions.push(
			this.collection,
			this.emitter,
			this.parsedEmitter,
			this.source.onDidChangeTextDocument((e) => {
				if (e.contentChanges.length > 0) {
					this.schedule(e.document);
				}
			}),
			this.source.onDidCloseTextDocument((doc) => this.forget(doc.uri)),
			options.detection.onDidChangeDetection((e) => {
				const doc = this.document(e.uri);
				if (e.detected && doc) {
					this.schedule(doc);
				} else if (!e.detected) {
					this.forget(vscode.Uri.parse(e.uri));
				}
			}),
			options.binary.onDidChange(() => this.reset()),
			this.source.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('redpandaConnect.envFile')) {
					this.reset();
				}
			}),
		);
		for (const doc of this.source.textDocuments) {
			this.schedule(doc);
		}
	}

	/** The published Bloblang diagnostics of a URI. */
	diagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[] {
		return this.collection.get(uri) ?? [];
	}

	/** How many parses have started (a test seam). */
	get parseCount(): number {
		return this.parses;
	}

	/** How many parses are running or waiting for a slot (a test seam). */
	get inFlight(): number {
		return this.flying;
	}

	/** The published live errors of a URI, with the line spans computed when they were published. */
	liveErrorsFor(uri: vscode.Uri): readonly LiveBloblangError[] {
		const state = this.docs.get(uri.toString());
		return state && this.diagnostics(uri).length > 0 ? [...state.shown.values()].map((s) => s.live) : [];
	}

	dispose(): void {
		this.disposed = true;
		for (const state of this.docs.values()) {
			clearTimeout(state.timer);
		}
		this.docs.clear();
		this.queue.length = 0;
		for (const d of this.subscriptions.splice(0)) {
			d.dispose();
		}
	}

	private eligible(doc: vscode.TextDocument): boolean {
		return doc.uri.scheme === 'file' && this.options.detection.isDetected(doc.uri);
	}

	private schedule(doc: vscode.TextDocument): void {
		if (this.disposed || !this.eligible(doc)) {
			return;
		}
		const key = doc.uri.toString();
		let state = this.docs.get(key);
		if (!state) {
			state = { timer: undefined, current: new Map(), shown: new Map() };
			this.docs.set(key, state);
		}
		clearTimeout(state.timer);
		state.timer = setTimeout(() => {
			state.timer = undefined;
			this.update(key);
		}, this.debounceMs);
	}

	/** Reads the document's processors, asks for the parses it lacks, publishes. */
	private update(key: string): void {
		const state = this.docs.get(key);
		const doc = this.document(key);
		if (this.disposed || !state || !doc) {
			return;
		}
		if (!this.eligible(doc)) {
			this.forget(doc.uri);
			return;
		}
		const { parsed } = parsedDocument(doc);
		state.current = new Map();
		if (parsed && parsed.docs.every((d) => d.errors.length === 0)) {
			for (const p of bloblangProcessors(parsed)) {
				state.current.set(p.path, { source: p.source, keyStart: p.keyRange[0], offsetAt: p.positions.offsetAt });
			}
		}
		if (this.options.binary.state.kind === 'ok') {
			for (const [path, current] of state.current) {
				const flight = this.flights.get(`${key}#${path}`);
				if (this.cache.has(current.source)) {
					// The current text is answered: an older text waiting behind a running parse is not needed.
					if (flight) {
						flight.pending = undefined;
					}
				} else if (current.source.trim() !== '') {
					this.request(`${key}#${path}`, current.source);
				}
			}
		}
		this.publish(key);
	}

	/** Single flight per processor path: one parse at a time, the latest text next. */
	private request(flightKey: string, text: string): void {
		let flight = this.flights.get(flightKey);
		if (!flight) {
			flight = { running: undefined, runningEpoch: this.epoch, pending: undefined };
			this.flights.set(flightKey, flight);
		}
		if (flight.running !== undefined) {
			// The running parse answers for `text` unless its result will be void (a reset since it started).
			flight.pending = flight.running === text && flight.runningEpoch === this.epoch ? undefined : text;
			return;
		}
		void this.fly(flightKey, flight, text);
	}

	private async fly(flightKey: string, flight: Flight, first: string): Promise<void> {
		let text: string | undefined = first;
		while (text !== undefined && !this.disposed) {
			flight.running = text;
			flight.pending = undefined;
			const epoch = this.epoch;
			flight.runningEpoch = epoch;
			const outcome = await this.limited(text);
			if (this.disposed) {
				return;
			}
			if (epoch === this.epoch && outcome) {
				if (isDeterministic(outcome)) {
					this.remember(text, outcome);
				}
				if (outcome.kind === 'other') {
					this.logOnce(outcome.message);
				}
			}
			const pending: string | undefined = flight.pending;
			text = pending !== undefined && !this.cache.has(pending) ? pending : undefined;
			flight.running = text;
			flight.pending = undefined;
			if (text === undefined) {
				this.flights.delete(flightKey);
			}
			// The document's text is read again: only a processor whose current text is the parsed one shows it.
			this.publish(flightKey.slice(0, flightKey.lastIndexOf('#')));
		}
		if (this.flights.get(flightKey) === flight && flight.running === undefined) {
			this.flights.delete(flightKey);
		}
	}

	/** Runs one parse under the global concurrency limit; `undefined` when the binary went away. */
	private async limited(text: string): Promise<BloblParseOutcome | undefined> {
		this.flying++;
		if (this.active >= MAX_CONCURRENT) {
			await new Promise<void>((resolve) => this.queue.push(resolve));
		}
		this.active++;
		try {
			if (this.disposed || this.options.binary.state.kind !== 'ok') {
				return undefined;
			}
			this.parses++;
			const outcome = await this.options.parse(text);
			this.parsedEmitter.fire(text);
			return outcome;
		} catch (err) {
			return { kind: 'other', message: String(err) };
		} finally {
			this.flying--;
			this.active--;
			this.queue.shift()?.();
		}
	}

	private remember(text: string, outcome: BloblParseOutcome): void {
		this.cache.delete(text);
		this.cache.set(text, outcome);
		while (this.cache.size > CACHE_SIZE) {
			this.cache.delete(this.cache.keys().next().value as string);
		}
	}

	private logOnce(message: string): void {
		const line = `Bloblang parse: ${message.replace(/\s*\r?\n\s*/g, ' ')}`;
		if (!this.logged.has(line)) {
			this.logged.add(line);
			this.options.log(line);
		}
	}

	/** Rebuilds a document's diagnostics from its current processors and the cache. */
	private publish(key: string): void {
		const state = this.docs.get(key);
		const doc = this.document(key);
		// While an edit waits for its debounce, the processors read before it are stale: the update publishes.
		if (this.disposed || !state || !doc || state.timer !== undefined) {
			return;
		}
		const shown = new Map<string, Shown>();
		if (this.options.binary.state.kind === 'ok') {
			const text = doc.getText();
			for (const [path, current] of state.current) {
				const outcome = this.cache.get(current.source);
				if (outcome === undefined) {
					// Its new text is still being parsed: the last diagnostic stays until the result.
					const previous = state.shown.get(path);
					const flight = this.flights.get(`${key}#${path}`);
					if (previous && (flight?.running === current.source || flight?.pending === current.source)) {
						shown.set(path, previous);
					}
					continue;
				}
				if (outcome.kind !== 'parseError') {
					continue;
				}
				const start = Math.min(current.offsetAt(outcome.line, outcome.char), text.length);
				const at = doc.positionAt(start);
				const lineEnd = doc.lineAt(at.line).range.end;
				const end = at.isBefore(lineEnd) ? doc.positionAt(start + charLength(text, start)) : at;
				const diagnostic = new vscode.Diagnostic(new vscode.Range(at, end), outcome.message, vscode.DiagnosticSeverity.Error);
				diagnostic.source = BLOBLANG_SOURCE;
				// The value's end: `offsetAt` past the last line gives it.
				const valueEnd = Math.min(current.offsetAt(Number.MAX_SAFE_INTEGER, 1), text.length);
				shown.set(path, {
					diagnostic,
					live: {
						firstLine: doc.positionAt(current.keyStart).line + 1,
						lastLine: doc.positionAt(valueEnd).line + 2,
						message: outcome.message,
					},
				});
			}
		}
		state.shown = shown;
		const diagnostics = [...shown.values()].map((s) => s.diagnostic);
		const uri = doc.uri;
		if (signatureOf(diagnostics) === signatureOf(this.collection.get(uri) ?? [])) {
			return;
		}
		if (diagnostics.length > 0) {
			this.collection.set(uri, diagnostics);
		} else {
			this.collection.delete(uri);
		}
		this.emitter.fire(uri);
	}

	/** Close, undetect: the file's diagnostics go; running parses still fill the cache. */
	private forget(uri: vscode.Uri): void {
		const key = uri.toString();
		const state = this.docs.get(key);
		if (state) {
			clearTimeout(state.timer);
			this.docs.delete(key);
		}
		if (this.collection.get(uri)?.length) {
			this.collection.delete(uri);
			this.emitter.fire(uri);
		}
	}

	/** The binary or the env file changed: cached outcomes are void; every file is parsed again. */
	private reset(): void {
		if (this.disposed) {
			return;
		}
		this.epoch++;
		this.cache.clear();
		this.logged.clear();
		for (const doc of this.source.textDocuments) {
			if (this.docs.has(doc.uri.toString())) {
				this.publish(doc.uri.toString());
			}
			this.schedule(doc);
		}
	}

	private document(key: string): vscode.TextDocument | undefined {
		return this.source.textDocuments.find((d) => d.uri.toString() === key);
	}
}

/** A parse, a parse error and an unset env var depend only on the text (and the env file); a timeout or spawn failure does not. */
function isDeterministic(outcome: BloblParseOutcome): boolean {
	return outcome.kind !== 'other' || outcome.message.startsWith('failed to replace env vars:');
}

/** The UTF-16 length of the character at `offset` (2 for a surrogate pair). */
function charLength(text: string, offset: number): number {
	const code = text.charCodeAt(offset);
	const next = text.charCodeAt(offset + 1);
	return code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
}

function signatureOf(diagnostics: readonly vscode.Diagnostic[]): string {
	return JSON.stringify(diagnostics.map((d) => [d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character, d.message]));
}
