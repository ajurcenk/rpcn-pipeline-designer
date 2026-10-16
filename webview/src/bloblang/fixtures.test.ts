// The Bloblang test panel's fixture messages (ticket 4.4): every file in src/test/fixtures/bloblang
// is a host message the webview accepts, and together they cover every result kind and the
// `samples` (4.9: also an unreadable file's), `binary` and `snapshot` messages that the panel lane (4.7–4.9) renders.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBloblangHostMessage, type BloblangHostMessage, type BloblangResult } from '../../../src/shared/bloblangProtocol';

const FIXTURES = new URL('../../../src/test/fixtures/bloblang/', import.meta.url);
const NAMES = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();

function fixture(name: string): unknown {
	return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
}

const RESULT_KINDS: readonly BloblangResult['kind'][] = ['ok', 'failed', 'parseError', 'invalidInput', 'deleted', 'error'];

describe('Bloblang panel fixtures (4.4)', () => {
	it.each(NAMES)('%s passes parseBloblangHostMessage, unchanged', (name) => {
		const message = fixture(name);
		expect(parseBloblangHostMessage(message)).toBe(message);
	});

	it('cover every result kind and the samples, binary and snapshot messages', () => {
		const messages = NAMES.map((n) => parseBloblangHostMessage(fixture(n))).filter((m): m is BloblangHostMessage => m !== undefined);
		const kinds = new Set(messages.flatMap((m) => (m.type === 'result' ? [m.result.kind] : [])));
		expect([...kinds].sort()).toEqual([...RESULT_KINDS].sort());
		const samples = messages.find((m) => m.type === 'samples' && m.samplesError === undefined);
		expect(samples?.type === 'samples' && samples.samples.length).toBe(3);
		// 4.9: the unreadable samples file.
		expect(messages.some((m) => m.type === 'samples' && m.samplesError !== undefined && m.samples.length === 0)).toBe(true);
		expect(messages.some((m) => m.type === 'binary' && m.status === 'missing')).toBe(true);
		expect(messages.some((m) => m.type === 'snapshot')).toBe(true);
		// 4.16: an unlabelled processor's snapshot.
		expect(messages.some((m) => m.type === 'snapshot' && m.unlabelledPath !== undefined)).toBe(true);
		// 4.10: a removed processor's snapshot.
		expect(messages.some((m) => m.type === 'snapshot' && m.removed === true)).toBe(true);
		// 4.17: a snapshot carrying the file's and samples file's names.
		expect(messages.some((m) => m.type === 'snapshot' && m.fileName !== undefined && m.samplesFile !== undefined)).toBe(true);
		const ok = messages.find((m) => m.type === 'result' && m.result.kind === 'ok');
		expect(ok?.type === 'result' && ok.result.kind === 'ok' && ok.result.changes.fields).toEqual({ added: ['c'], changed: ['b'], removed: [] });
		const failed = messages.find((m) => m.type === 'result' && m.result.kind === 'failed');
		expect(failed?.type === 'result' && failed.result.kind === 'failed' && [failed.result.mappingLine, failed.result.fileLine]).toEqual([2, 9]);
	});
});
