import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RedpandaConnect } from '../../../adapters/redpandaConnect/binary';
import { SchemaSnapshot, SchemaStore, STALE_CACHE_MS } from '../../../adapters/redpandaConnect/schema';
import { DRAFT_07, isJsonObject, JsonObject, schemaFileName } from '../../../core/schema';
import { connectScript, fixtureBodies, makeTempDir, readCounter, writeFakeBinary } from '../../helpers/fakeBinary';

const SMALL_SCHEMA = `echo '{"definitions":{},"properties":{"http":{"type":"object","properties":{"enabled":{"type":"boolean","is_advanced":false}}}}}'`;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Sets a file's mtime to `ageMs` ago. */
function age(file: string, ageMs: number): void {
	const t = new Date(Date.now() - ageMs);
	fs.utimesSync(file, t, t);
}

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(file)) {
		assert.ok(Date.now() < deadline, `${file} did not appear`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

const SMALL_DOCS = `echo '{"config":[{"name":"http","description":"Configures the HTTP server.","children":[{"name":"enabled","default":true}]}]}'`;

// Rows of the plan's I/O & edge-case matrix. Each test has its own PATH-less environment,
// storage directory and fake binaries; the binary is selected through the injected setting.
suite('adapters/redpandaConnect SchemaStore', () => {
	let root: string;
	let storage: string;
	let counter: string;
	let setting: string;
	let lines: string[];
	const disposables: vscode.Disposable[] = [];

	const log = (line: string) => lines.push(line);
	const schemaLines = () => lines.filter((l) => l.startsWith('Schema'));

	/** A RedpandaConnect + SchemaStore pair, as wired in `src/extension.ts`. */
	function start(storageDir = storage): { rc: RedpandaConnect; store: SchemaStore; events: (SchemaSnapshot | undefined)[] } {
		const rc = new RedpandaConnect({
			log,
			environment: () => ({ binaryPathSetting: setting, envPath: '', homeDir: root, workspaceFolder: undefined }),
		});
		const store = new SchemaStore({ binary: rc, storageUri: vscode.Uri.file(storageDir), log });
		const events: (SchemaSnapshot | undefined)[] = [];
		disposables.push(rc, store, store.onDidChange((s) => events.push(s)));
		return { rc, store, events };
	}

	/** Writes a fake binary at `name` (counting into `counter`). */
	function fake(name: string, version: string, bodies: { jsonschema?: string; jsonFull?: string } = {}, sleep?: number): string {
		return writeFakeBinary(root, name, connectScript({
			version,
			jsonschema: bodies.jsonschema ?? SMALL_SCHEMA,
			jsonFull: bodies.jsonFull ?? SMALL_DOCS,
			counterFile: counter,
			listSleepSeconds: sleep,
		}));
	}

	const cacheFiles = () => (fs.existsSync(storage) ? fs.readdirSync(storage).filter((f) => f.startsWith('schema-')).sort() : []);
	const listRuns = () => readCounter(counter).filter((l) => l !== 'version');

	setup(() => {
		root = makeTempDir('rpcn-schema-');
		storage = path.join(root, 'globalStorage');
		counter = path.join(root, 'count');
		setting = '';
		lines = [];
	});
	teardown(() => {
		for (const d of disposables.splice(0)) {
			d.dispose();
		}
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('FIRST_GEN + DOC_MERGE: one generation from the real 4.112.0 output, file written, onDidChange fires', async function () {
		this.timeout(30_000);
		setting = fake('redpanda-connect', '4.112.0', fixtureBodies('4.112.0'));
		const { rc, store, events } = start();
		assert.strictEqual(store.current, undefined);
		await rc.refresh();
		const current = await store.settled();

		assert.deepStrictEqual(listRuns(), ['jsonschema', 'json-full']);
		const file = path.join(storage, schemaFileName(setting, '4.112.0'));
		assert.deepStrictEqual(cacheFiles(), [path.basename(file)]);
		assert.ok(current);
		assert.strictEqual(current.uri.fsPath, file);
		assert.strictEqual(current.path, setting);
		assert.strictEqual(current.version, '4.112.0');
		assert.strictEqual(current.json.$schema, DRAFT_07);
		assert.strictEqual(fs.readFileSync(file, 'utf8'), JSON.stringify(current.json));
		assert.deepStrictEqual(events, [current]);

		// DOC_MERGE: kafka_franz.seed_brokers has its description and examples; components carry their summary.
		const input = (current.json.definitions as JsonObject).input as JsonObject;
		const anyOf = ((input.allOf as JsonObject[])[0]).anyOf as JsonObject[];
		const franz = (anyOf.find((o) => isJsonObject(o.properties) && 'kafka_franz' in o.properties)!.properties as JsonObject)
			.kafka_franz as JsonObject;
		assert.ok(String(franz.markdownDescription).startsWith('A Kafka input'));
		const seed = (franz.properties as JsonObject).seed_brokers as JsonObject;
		assert.ok(String(seed.markdownDescription).includes('A list of broker addresses'));
		assert.ok(String(seed.markdownDescription).includes('```yaml\n- - localhost:9092'));
		assert.deepStrictEqual(schemaLines(), [`Schema: generated for Redpanda Connect 4.112.0 (${file}).`]);
	});

	test('CACHE_HIT: a later activation with a matching cache file spawns no list and exposes the cached schema', async () => {
		setting = fake('redpanda-connect', '4.112.0');
		const first = start();
		await first.rc.refresh();
		const generated = await first.store.settled();
		first.store.dispose();
		first.rc.dispose();
		assert.deepStrictEqual(listRuns(), ['jsonschema', 'json-full']);

		age(generated!.uri.fsPath, 20 * DAY_MS);
		lines = [];
		const second = start();
		await second.rc.refresh();
		const cached = await second.store.settled();
		assert.ok(Date.now() - fs.statSync(generated!.uri.fsPath).mtimeMs < DAY_MS, 'a cache hit refreshes the mtime');
		assert.deepStrictEqual(listRuns(), ['jsonschema', 'json-full'], 'no list process on the second activation');
		assert.ok(cached);
		assert.deepStrictEqual(cached.json, generated!.json);
		assert.strictEqual(cached.uri.fsPath, generated!.uri.fsPath);
		assert.deepStrictEqual(second.events, [cached]);
		assert.deepStrictEqual(schemaLines(), [`Schema: using the cached schema for Redpanda Connect 4.112.0 (${cached.uri.fsPath}).`]);
	});

	test('CACHE_CORRUPT: an unparseable cache file is regenerated and rewritten, logged once', async () => {
		setting = fake('redpanda-connect', '4.112.0');
		const file = path.join(storage, schemaFileName(setting, '4.112.0'));
		fs.mkdirSync(storage, { recursive: true });
		fs.writeFileSync(file, '{"definitions": {');
		const { rc, store } = start();
		await rc.refresh();
		const current = await store.settled();
		assert.ok(current);
		assert.deepStrictEqual(listRuns(), ['jsonschema', 'json-full']);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), current.json);
		assert.deepStrictEqual(schemaLines(), [
			`Schema: the cached schema ${file} is unreadable; regenerating.`,
			`Schema: generated for Redpanda Connect 4.112.0 (${file}).`,
		]);
	});

	test('VERSION_CHANGE: ok 4.100.0 → ok 4.112.0 gives a new hash and file, keeps the recently used old one, fires', async () => {
		const old = fake('rc-old', '4.100.0');
		const next = fake('rc-new', '4.112.0');
		setting = old;
		const { rc, store, events } = start();
		await rc.refresh();
		const first = await store.settled();
		assert.deepStrictEqual(cacheFiles(), [schemaFileName(old, '4.100.0')]);
		// An unrelated file in globalStorage is left alone.
		fs.writeFileSync(path.join(storage, 'other.json'), '{}');

		setting = next; // as Set path / Retry would
		await rc.refresh();
		const second = await store.settled();
		assert.ok(first && second);
		assert.notStrictEqual(second.uri.fsPath, first.uri.fsPath);
		assert.strictEqual(second.version, '4.112.0');
		assert.deepStrictEqual(cacheFiles(), [schemaFileName(old, '4.100.0'), schemaFileName(next, '4.112.0')].sort());
		assert.ok(fs.existsSync(path.join(storage, 'other.json')));
		assert.deepStrictEqual(events, [first, second]);
	});

	test('OTHER_WINDOW: another schema file used within 30 days is not removed', async () => {
		setting = fake('redpanda-connect', '4.112.0');
		fs.mkdirSync(storage, { recursive: true });
		const other = path.join(storage, 'schema-aaaaaaaaaaaaaaaa.json');
		fs.writeFileSync(other, '{}');
		age(other, STALE_CACHE_MS - DAY_MS);
		const { rc, store } = start();
		await rc.refresh();
		assert.ok(await store.settled());
		assert.ok(fs.existsSync(other));
	});

	test('STALE_FILE: a schema file unused for over 30 days is removed after a successful write; non-cache names are kept', async () => {
		setting = fake('redpanda-connect', '4.112.0');
		fs.mkdirSync(storage, { recursive: true });
		const stale = path.join(storage, 'schema-0123456789abcdef.json');
		const foreign = path.join(storage, 'schema-notes.json');
		for (const f of [stale, foreign]) {
			fs.writeFileSync(f, '{}');
			age(f, STALE_CACHE_MS + DAY_MS);
		}
		const { rc, store } = start();
		await rc.refresh();
		const current = await store.settled();
		assert.ok(current);
		assert.ok(!fs.existsSync(stale), 'stale cache file was kept');
		assert.ok(fs.existsSync(foreign), 'a non-cache file name was removed');
		assert.ok(fs.existsSync(current.uri.fsPath));
	});

	test('STALE_FILE: the clock is injectable; nothing is removed when the write fails', async () => {
		setting = fake('redpanda-connect', '4.112.0', { jsonschema: 'exit 1' });
		fs.mkdirSync(storage, { recursive: true });
		const stale = path.join(storage, 'schema-0123456789abcdef.json');
		fs.writeFileSync(stale, '{}');
		age(stale, STALE_CACHE_MS + DAY_MS);
		const { rc, store } = start();
		await rc.refresh();
		assert.strictEqual(await store.settled(), undefined);
		assert.ok(fs.existsSync(stale));
		store.dispose();

		// With a clock 31 days ahead, a just-written sibling counts as stale.
		setting = fake('rc-b', '4.112.0');
		const fresh = path.join(storage, 'schema-fedcba9876543210.json');
		fs.writeFileSync(fresh, '{}');
		const later = new SchemaStore({
			binary: rc, storageUri: vscode.Uri.file(storage), log, now: () => Date.now() + STALE_CACHE_MS + DAY_MS,
		});
		disposables.push(later);
		await rc.refresh();
		const current = await later.settled();
		assert.ok(current);
		assert.ok(!fs.existsSync(fresh) && !fs.existsSync(stale));
		assert.ok(fs.statSync(current.uri.fsPath).mtimeMs > Date.now() + STALE_CACHE_MS, 'the write sets the mtime from the clock');
	});

	test('binary changes during json-full: the stale run writes nothing and the other binary\'s cache file survives', async () => {
		const started = path.join(root, 'json-full-started');
		const slow = fake('rc-slow', '4.100.0', { jsonFull: `touch '${started}'; sleep 1; ${SMALL_DOCS}` });
		const fast = fake('rc-fast', '4.112.0');
		setting = slow;
		const { rc, store, events } = start();
		await rc.refresh();
		await waitForFile(started);
		setting = fast;
		await rc.refresh();
		const current = await store.settled();
		await new Promise((r) => setTimeout(r, 1200)); // let the slow json-full finish
		await store.settled();
		assert.ok(current);
		assert.strictEqual(current.path, fast);
		assert.deepStrictEqual(cacheFiles(), [schemaFileName(fast, '4.112.0')]);
		assert.strictEqual(store.current, current);
		assert.deepStrictEqual(events, [current]);
	});

	test('dispose during json-full: nothing is written', async () => {
		const started = path.join(root, 'json-full-started');
		setting = fake('redpanda-connect', '4.112.0', { jsonFull: `touch '${started}'; sleep 1; ${SMALL_DOCS}` });
		const { rc, store } = start();
		await rc.refresh();
		await waitForFile(started);
		store.dispose();
		await store.settled();
		assert.deepStrictEqual(cacheFiles(), []);
	});

	test('NOT_OK: binaryState → missing / invalid makes current undefined; onDidChange fires once', async () => {
		setting = fake('redpanda-connect', '4.112.0');
		const { rc, store, events } = start();
		await rc.refresh();
		const first = await store.settled();
		assert.ok(first);

		setting = path.join(root, 'nope');
		await rc.refresh();
		assert.strictEqual(rc.state.kind, 'missing');
		assert.strictEqual(await store.settled(), undefined);
		assert.deepStrictEqual(events, [first, undefined]);

		setting = fake('rc-old', '4.63.0');
		await rc.refresh();
		assert.strictEqual(rc.state.kind, 'invalid');
		assert.strictEqual(store.current, undefined);
		assert.deepStrictEqual(events, [first, undefined], 'no second event while staying not ok');
	});

	test('NOT_OK during a generation: the late result is discarded', async () => {
		setting = fake('redpanda-connect', '4.112.0', {}, 1);
		const { rc, store, events } = start();
		await rc.refresh(); // generation now sleeping in `list`
		setting = path.join(root, 'nope');
		await rc.refresh();
		assert.strictEqual(await store.settled(), undefined);
		assert.strictEqual(store.current, undefined);
		assert.deepStrictEqual(events, []);
	});

	test('CONCURRENT: overlapping triggers share one generation and get its result', async () => {
		setting = fake('redpanda-connect', '4.112.0', {}, 1);
		const { store, events } = start();
		const [a, b] = await Promise.all([store.refresh(), store.refresh()]);
		assert.ok(a);
		assert.strictEqual(a, b);
		assert.deepStrictEqual(listRuns(), ['jsonschema', 'json-full']);
		assert.deepStrictEqual(readCounter(counter).filter((l) => l === 'version'), ['version']);
		assert.deepStrictEqual(events, [a]);
	});

	test('REFRESH_CMD: re-resolves the binary and regenerates even on a cache hit', async () => {
		setting = fake('redpanda-connect', '4.112.0');
		const first = start();
		await first.rc.refresh();
		await first.store.settled();
		first.store.dispose();
		first.rc.dispose();

		const { rc, store, events } = start();
		await rc.refresh();
		const cached = await store.settled();
		const before = readCounter(counter);
		const refreshed = await store.refresh();
		assert.deepStrictEqual(readCounter(counter).slice(before.length), ['version', 'jsonschema', 'json-full']);
		assert.ok(cached && refreshed);
		assert.notStrictEqual(refreshed, cached);
		assert.strictEqual(refreshed.uri.fsPath, cached.uri.fsPath);
		assert.deepStrictEqual(events, [cached, refreshed]);
	});

	test('GEN_FAILS: a non-zero list exit is logged once; schema undefined; never throws', async () => {
		setting = fake('redpanda-connect', '4.112.0', { jsonschema: 'echo "boom: no" >&2; exit 4' });
		const { rc, store, events } = start();
		await rc.refresh();
		assert.strictEqual(await store.settled(), undefined);
		assert.deepStrictEqual(events, []);
		assert.deepStrictEqual(schemaLines(), [
			'Schema generation failed for Redpanda Connect 4.112.0: list --format jsonschema exited with code 4: boom: no',
		]);
		assert.deepStrictEqual(cacheFiles(), []);
		assert.deepStrictEqual(listRuns(), ['jsonschema'], 'json-full is not run after a failed jsonschema');
	});

	test('GEN_FAILS: invalid JSON is logged once', async () => {
		setting = fake('redpanda-connect', '4.112.0', { jsonschema: 'echo "not json"' });
		const { rc, store } = start();
		await rc.refresh();
		assert.strictEqual(await store.settled(), undefined);
		assert.deepStrictEqual(schemaLines(), [
			'Schema generation failed for Redpanda Connect 4.112.0: list --format jsonschema printed no JSON schema',
		]);
	});

	test('GEN_FAILS: the previous schema is kept when it belongs to the same path + version', async () => {
		const failFlag = path.join(root, 'fail');
		setting = fake('redpanda-connect', '4.112.0', {
			jsonschema: `if [ -f '${failFlag}' ]; then echo bad >&2; exit 1; fi\n${SMALL_SCHEMA}`,
		});
		const { rc, store, events } = start();
		await rc.refresh();
		const first = await store.settled();
		assert.ok(first);
		fs.writeFileSync(failFlag, '');
		lines = [];
		assert.strictEqual(await store.refresh(), first);
		assert.strictEqual(store.current, first);
		assert.deepStrictEqual(events, [first]);
		assert.deepStrictEqual(schemaLines(), [
			'Schema generation failed for Redpanda Connect 4.112.0: list --format jsonschema exited with code 1: bad',
		]);
	});

	test('GEN_FAILS: a write error is logged once and leaves no schema', async () => {
		setting = fake('redpanda-connect', '4.112.0');
		const blocker = path.join(root, 'file');
		fs.writeFileSync(blocker, '');
		const { rc, store } = start(path.join(blocker, 'storage'));
		await rc.refresh();
		assert.strictEqual(await store.settled(), undefined);
		const failed = schemaLines();
		assert.strictEqual(failed.length, 1, failed.join('\n'));
		assert.ok(failed[0].startsWith('Schema generation failed for Redpanda Connect 4.112.0: could not write '), failed[0]);
	});

	test('DOC_FAILS: json-full fails, the schema is produced without docs, logged once', async () => {
		setting = fake('redpanda-connect', '4.112.0', { jsonFull: 'echo nope >&2; exit 1' });
		const { rc, store } = start();
		await rc.refresh();
		const current = await store.settled();
		assert.ok(current);
		assert.ok(!JSON.stringify(current.json).includes('markdownDescription'));
		assert.strictEqual(current.json.$schema, DRAFT_07);
		const file = path.join(storage, schemaFileName(setting, '4.112.0'));
		assert.deepStrictEqual(schemaLines(), [
			'Schema: docs unavailable for Redpanda Connect 4.112.0 (list --format json-full exited with code 1: nope); '
				+ 'the schema has no descriptions or defaults.',
			`Schema: generated for Redpanda Connect 4.112.0 (${file}).`,
		]);
	});

	test('DOC_FAILS: invalid json-full JSON gives a schema without docs', async () => {
		setting = fake('redpanda-connect', '4.112.0', { jsonFull: 'echo "{"' });
		const { rc, store } = start();
		await rc.refresh();
		const current = await store.settled();
		assert.ok(current && !JSON.stringify(current.json).includes('markdownDescription'));
		assert.strictEqual(schemaLines().filter((l) => l.startsWith('Schema: docs unavailable')).length, 1);
	});

	test('small docs merge end to end: description and default', async () => {
		setting = fake('redpanda-connect', '4.112.0');
		const { rc, store } = start();
		await rc.refresh();
		const http = ((await store.settled())!.json.properties as JsonObject).http as JsonObject;
		assert.strictEqual(http.markdownDescription, 'Configures the HTTP server.');
		const enabled = (http.properties as JsonObject).enabled as JsonObject;
		assert.strictEqual(enabled.default, true);
		assert.strictEqual(enabled.is_advanced, false);
		assert.ok(Array.isArray(enabled.anyOf));
	});

	test('no spawn after dispose', async () => {
		setting = fake('redpanda-connect', '4.112.0');
		const { rc, store } = start();
		store.dispose();
		await rc.refresh();
		assert.strictEqual(await store.refresh(), undefined);
		await store.settled();
		assert.deepStrictEqual(listRuns(), []);
	});
});
