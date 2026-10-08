import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BinaryState, RedpandaConnect } from '../adapters/redpandaConnect/binary';
import { BinaryNotifier, MISSING_MESSAGE, NOTIFICATION_ACTIONS } from '../adapters/redpandaConnect/notify';
import { createVsCodeNotifier, type ExtensionApi } from '../extension';
import { GapCompletionProvider } from '../adapters/vscode/completion';
import { SchemaSnapshot, SchemaStore } from '../adapters/redpandaConnect/schema';
import { schemaFileName } from '../core/schema';
import {
	connectScript, fixtureBodies, makeTempDir, readCounter, REPO_ROOT, SCHEMA_FIXTURES, toolPath, versionScript, writeFakeBinary,
} from './helpers/fakeBinary';

const EXTENSION_ID = 'ajurcenk.rpcn-pipeline-designer';

/** Output lines without the schema store's (`Schema…`), which interleave with binary resolution. */
const binaryLines = (api: ExtensionApi) => api.outputLines().filter((l) => !l.startsWith('Schema'));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return true;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	return predicate();
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return true;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return predicate();
}

// The tests in this suite run in order: NON_YAML must run before the extension is activated.
suite('Extension tracer path (integration)', () => {
	let dir: string;
	let fakeBinary: string;
	let counter: string;
	const originalPath = process.env.PATH;

	suiteSetup(async () => {
		// PATH wins over binaryPath (AD-9): hide any real rpk / redpanda-connect from the
		// extension host (same process) so these tests exercise the setting.
		process.env.PATH = (originalPath ?? '').split(path.delimiter)
			.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
			.join(path.delimiter);
		dir = makeTempDir('rpcn-integration-');
		counter = path.join(dir, 'count');
		fakeBinary = writeFakeBinary(dir, 'redpanda-connect', connectScript({ version: '4.112.0', counterFile: counter }));
		await vscode.workspace.getConfiguration('redpandaConnect')
			.update('binaryPath', fakeBinary, vscode.ConfigurationTarget.Global);
	});

	suiteTeardown(async () => {
		process.env.PATH = originalPath;
		await vscode.workspace.getConfiguration('redpandaConnect')
			.update('binaryPath', undefined, vscode.ConfigurationTarget.Global);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('the extension and its Red Hat YAML dependency are installed', () => {
		assert.ok(vscode.extensions.getExtension(EXTENSION_ID), `${EXTENSION_ID} not found`);
		assert.ok(vscode.extensions.getExtension('redhat.vscode-yaml'), 'redhat.vscode-yaml not installed');
	});

	test('NON_YAML: opening a non-YAML file does not activate the extension', async () => {
		const txt = path.join(dir, 'notes.txt');
		fs.writeFileSync(txt, 'hello\n');
		const doc = await vscode.workspace.openTextDocument(txt);
		await vscode.window.showTextDocument(doc);
		await new Promise((r) => setTimeout(r, 500));
		assert.strictEqual(vscode.extensions.getExtension(EXTENSION_ID)!.isActive, false);
	});

	test('HAPPY_PATH: opening a YAML file logs the binary version to the output channel', async () => {
		const yamlFile = path.join(dir, 'pipeline.yaml');
		fs.writeFileSync(yamlFile, 'input:\n  stdin: {}\noutput:\n  stdout: {}\n');
		const doc = await vscode.workspace.openTextDocument(yamlFile);
		assert.strictEqual(doc.languageId, 'yaml');
		await vscode.window.showTextDocument(doc);

		const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!;
		assert.ok(await waitFor(() => ext.isActive, 15_000), 'extension did not activate on a YAML file');

		const api = ext.exports;
		await api.activationResolved;
		assert.deepStrictEqual(api.redpandaConnect.state, {
			kind: 'ok', path: fakeBinary, version: '4.112.0', invocation: [fakeBinary],
		});
		assert.deepStrictEqual(binaryLines(api), [`Redpanda Connect 4.112.0 (${fakeBinary})`]);
	});

	test('SETTING_CHANGED: flipping binaryPath between ok, missing and invalid updates binaryState without a reload', async () => {
		const api = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
		const rc = api.redpandaConnect;
		const missing = path.join(dir, 'does-not-exist');
		const old = writeFakeBinary(dir, 'redpanda-connect-old', versionScript('4.63.0'));
		const events: BinaryState[] = [];
		const sub = rc.onDidChange((s) => events.push(s));
		const linesBefore = binaryLines(api).length;

		const setBinaryPath = async (value: string, expected: BinaryState['kind']) => {
			const changed = new Promise<BinaryState>((resolve) => {
				const once = rc.onDidChange((s) => { once.dispose(); resolve(s); });
			});
			await vscode.workspace.getConfiguration('redpandaConnect')
				.update('binaryPath', value, vscode.ConfigurationTarget.Global);
			const state = await Promise.race([
				changed,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no onDidChange for ${value}`)), 10_000)),
			]);
			await rc.refresh(); // settle any queued run
			assert.strictEqual(state.kind, expected);
			assert.strictEqual(rc.state.kind, expected);
		};

		try {
			await setBinaryPath(missing, 'missing');
			await setBinaryPath(old, 'invalid');
			assert.deepStrictEqual(rc.state, { kind: 'invalid', path: old, reason: 'belowMinimum', version: '4.63.0' });
			await setBinaryPath(fakeBinary, 'ok');
		} finally {
			sub.dispose();
		}

		assert.deepStrictEqual(events.map((e) => e.kind), ['missing', 'invalid', 'ok']);
		assert.deepStrictEqual(binaryLines(api).slice(linesBefore), [
			'No Redpanda Connect binary found: neither "rpk" nor "redpanda-connect" is on PATH, '
				+ `and no binary was found at redpandaConnect.binaryPath "${missing}".`,
			`Redpanda Connect 4.63.0 (${old}) is older than the minimum supported version 4.100.0.`,
			`Redpanda Connect 4.112.0 (${fakeBinary})`,
		]);
	});
	test('SCHEMA_ACCEPTANCE: the schema is cached in globalStorage; a second activation spawns no list; Refresh schema regenerates', async () => {
		const api = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
		const store = api.schemaStore;
		await api.redpandaConnect.refresh();
		const current = await store.settled();
		assert.ok(current, 'no schema after activation');
		assert.strictEqual(current.path, fakeBinary);
		assert.strictEqual(path.basename(current.uri.fsPath), schemaFileName(fakeBinary, '4.112.0'));
		assert.ok(fs.existsSync(current.uri.fsPath));
		const storageDir = path.dirname(current.uri.fsPath);

		// A second activation: a new store over the same globalStorage and binary state.
		const listRuns = () => readCounter(counter).filter((l) => l !== 'version').length;
		const before = listRuns();
		const lines: string[] = [];
		const second = new SchemaStore({ binary: api.redpandaConnect, storageUri: vscode.Uri.file(storageDir), log: (l) => lines.push(l) });
		try {
			const cached = await second.settled();
			assert.ok(cached);
			assert.deepStrictEqual(cached.json, current.json);
			assert.strictEqual(listRuns(), before, 'a list process was spawned on a cache hit');
			assert.deepStrictEqual(lines, [`Schema: using the cached schema for Redpanda Connect 4.112.0 (${current.uri.fsPath}).`]);
		} finally {
			second.dispose();
		}

		// Refresh schema: visible in the Command Palette, regenerates even on a cache hit.
		const pkg = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON as {
			contributes: { menus: { commandPalette: { command: string }[] } };
		};
		assert.ok(!pkg.contributes.menus.commandPalette.some((m) => m.command === 'redpandaConnect.refreshSchema'));
		const changed = new Promise<SchemaSnapshot | undefined>((resolve) => {
			const once = store.onDidChange((s) => { once.dispose(); resolve(s); });
		});
		await vscode.commands.executeCommand('redpandaConnect.refreshSchema');
		const refreshed = await changed;
		assert.ok(refreshed && refreshed !== current);
		assert.strictEqual(store.current, refreshed);
		assert.ok(listRuns() > before, 'Refresh schema did not run list');
	});

	test('NOTIFY_MISSING: a missing resolution goes through the real VS Code notifier without throwing', async () => {
		const lines: string[] = [];
		const real = createVsCodeNotifier((line) => lines.push(line));
		const shown: { message: string; actions: readonly string[] }[] = [];
		const notifier: BinaryNotifier = {
			...real,
			showWarning: (message, actions) => {
				shown.push({ message, actions });
				return real.showWarning(message, actions); // stays open: never clicked here
			},
		};
		const rc = new RedpandaConnect({
			log: (line) => lines.push(line),
			notifier,
			environment: () => ({ binaryPathSetting: '', envPath: '', homeDir: dir, workspaceFolder: undefined }),
		});
		try {
			assert.strictEqual((await rc.refresh()).kind, 'missing');
			assert.deepStrictEqual(shown, [{ message: MISSING_MESSAGE, actions: NOTIFICATION_ACTIONS }]);
			assert.ok(!lines.some((l) => l.includes('notification action failed')), lines.join('\n'));
		} finally {
			rc.dispose();
		}
	});

	test('SET_PATH_ACCEPTANCE: Set path writes the absolute path at Global scope and binaryState becomes ok without a reload', async () => {
		const config = () => vscode.workspace.getConfiguration('redpandaConnect');
		await config().update('binaryPath', path.join(dir, 'not-there'), vscode.ConfigurationTarget.Global);
		const lines: string[] = [];
		const real = createVsCodeNotifier((line) => lines.push(line));
		const shown: string[] = [];
		const notifier: BinaryNotifier = {
			...real,
			showWarning: async (message) => { shown.push(message); return 'Set path'; },
			pickBinary: async () => fakeBinary, // the picker itself needs a human
		};
		// Default environment: the real setting and the (filtered) PATH of the extension host.
		const rc = new RedpandaConnect({ log: () => undefined, notifier });
		try {
			assert.strictEqual((await rc.refresh()).kind, 'missing');
			assert.ok(await waitFor(() => rc.state.kind === 'ok', 10_000), `state stayed ${rc.state.kind}`);
			assert.deepStrictEqual(rc.state, { kind: 'ok', path: fakeBinary, version: '4.112.0', invocation: [fakeBinary] });
			assert.strictEqual(config().inspect<string>('binaryPath')?.globalValue, fakeBinary);
			assert.ok(path.isAbsolute(fakeBinary));
			await rc.refresh();
			assert.deepStrictEqual(shown, [MISSING_MESSAGE]);
			assert.deepStrictEqual(lines, [], 'no workspace override expected');
		} finally {
			rc.dispose();
		}
	});
});

// Ticket 2.1: completion and hover from the binary's schema through the Red Hat YAML contributor.
// Runs after the tracer-path suite above (the extension is already active by then).
suite('Schema contributor (integration)', function () {
	this.timeout(90_000);
	let dir: string;
	let fakeBinary: string;
	let changedBinary: string;
	const originalPath = process.env.PATH;
	const EXTRA_INPUT = 'rpcn_test_only_input';

	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;

	/** Waits until `store.current` was generated by `binary` at `version`. */
	async function schemaFrom(binary: string, version: string): Promise<SchemaSnapshot> {
		const store = api().schemaStore;
		assert.ok(await waitFor(() => store.current?.path === binary && store.current.version === version, 30_000),
			`no schema from ${binary} ${version}; current: ${store.current?.path} ${store.current?.version}; `
			+ `binaryState: ${JSON.stringify(api().redpandaConnect.state)}\n${api().outputLines().slice(-10).join('\n')}`);
		return store.current!;
	}

	async function setBinaryPath(value: string | undefined): Promise<void> {
		await vscode.workspace.getConfiguration('redpandaConnect').update('binaryPath', value, vscode.ConfigurationTarget.Global);
	}

	async function openYaml(name: string, text: string): Promise<vscode.TextDocument> {
		const file = path.join(dir, name);
		fs.writeFileSync(file, text);
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);
		assert.strictEqual(doc.languageId, 'yaml');
		return doc;
	}

	async function completionLabels(doc: vscode.TextDocument, position: vscode.Position): Promise<string[]> {
		const list = await vscode.commands.executeCommand<vscode.CompletionList>(
			'vscode.executeCompletionItemProvider', doc.uri, position);
		return (list?.items ?? []).map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
	}

	async function hoverText(doc: vscode.TextDocument, position: vscode.Position): Promise<string> {
		const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, position);
		return (hovers ?? []).flatMap((h) => h.contents)
			.map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : ''))
			.join('\n');
	}

	/** Polls completion until `expected` labels are all offered (the YAML server may still be starting). */
	async function completionOffers(doc: vscode.TextDocument, position: vscode.Position, expected: string[]): Promise<string[]> {
		let labels: string[] = [];
		const ok = await waitForAsync(async () => {
			labels = await completionLabels(doc, position);
			return expected.every((e) => labels.includes(e));
		}, 45_000);
		assert.ok(ok, `completion did not offer ${expected.join(', ')}; got: ${labels.slice(0, 40).join(', ')}`);
		return labels;
	}

	suiteSetup(async () => {
		const fixtures = fixtureBodies('4.112.0'); // absolute tool paths: resolved before PATH is filtered
		const cat = toolPath('cat');
		process.env.PATH = (originalPath ?? '').split(path.delimiter)
			.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
			.join(path.delimiter);
		dir = makeTempDir('rpcn-contributor-');
		fakeBinary = writeFakeBinary(dir, 'redpanda-connect', connectScript({ version: '4.112.0', ...fixtures }));

		// A "different binary version": the 4.112.0 schema plus one extra input component.
		const raw = JSON.parse(fs.readFileSync(path.join(SCHEMA_FIXTURES, 'jsonschema-4.112.0.json'), 'utf8'));
		raw.definitions.input.allOf[0].anyOf.push({
			type: 'object',
			properties: { [EXTRA_INPUT]: { type: 'object', additionalProperties: false, properties: {} } },
		});
		const changedSchema = path.join(dir, 'jsonschema-changed.json');
		fs.writeFileSync(changedSchema, JSON.stringify(raw));
		changedBinary = writeFakeBinary(dir, 'redpanda-connect-changed', connectScript({
			version: '4.113.0',
			jsonschema: `'${cat}' '${changedSchema}'`,
			jsonFull: fixtures.jsonFull,
		}));

		await setBinaryPath(fakeBinary);
		await schemaFrom(fakeBinary, '4.112.0');
		assert.strictEqual(await api().contributorRegistered, true, api().outputLines().join('\n'));
	});

	suiteTeardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		process.env.PATH = originalPath;
		await setBinaryPath(undefined);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('DETECTED: in a corpus config, completion under input: offers component names; hover shows the merged description', async () => {
		const corpusFile = path.join(REPO_ROOT, 'test', 'corpus', 'joining_streams.yaml');
		const doc = await vscode.workspace.openTextDocument(corpusFile);
		await vscode.window.showTextDocument(doc);
		assert.strictEqual(doc.languageId, 'yaml');
		assert.ok(doc.lineAt(1).text.startsWith('  broker:') && doc.lineAt(4).text.startsWith('          seed_brokers:'),
			'joining_streams.yaml layout changed');
		assert.strictEqual(api().detection.isDetected(doc.uri), true);
		const schemaUri = api().schemaContributor.requestSchema(doc.uri.toString());
		assert.ok(schemaUri?.startsWith('rpcn-schema://schema/'), String(schemaUri));

		// Completion at the `broker` key under `input:` offers the other input components.
		await completionOffers(doc, new vscode.Position(1, 2), ['generate', 'kafka_franz']);

		// Hover on `input.broker.inputs[0].redpanda.seed_brokers` shows the json-full description.
		let text = '';
		const ok = await waitForAsync(async () => {
			text = await hoverText(doc, new vscode.Position(4, 12));
			return text.includes('A list of broker addresses to connect to');
		}, 30_000);
		assert.ok(ok, `hover on redpanda.seed_brokers: ${text}`);
		assert.ok(!doc.isDirty);
	});

	test('NOT_DETECTED: a YAML file without Redpanda Connect keys gets no schema', async () => {
		const doc = await openYaml('k8s.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: web\n\n');
		assert.strictEqual(api().detection.isDetected(doc.uri), false);
		assert.strictEqual(api().schemaContributor.requestSchema(doc.uri.toString()), undefined);
		const labels = await completionLabels(doc, new vscode.Position(4, 0));
		for (const key of ['input', 'pipeline', 'output', 'cache_resources']) {
			assert.ok(!labels.includes(key), `unexpected Redpanda Connect completion "${key}": ${labels.join(', ')}`);
		}
		assert.strictEqual(await hoverText(doc, new vscode.Position(1, 1)), '');
	});

	test('INCOMPLETE_COMPONENT (2.13): a component missing a required field still offers its fields', async () => {
		await schemaFrom(fakeBinary, '4.112.0');
		const doc = await openYaml('incomplete.yaml', 'output:\n  file:\n    codec: lines\n    \n');
		await completionOffers(doc, new vscode.Position(3, 4), ['path']);
	});

	test('VALUE_OPTIONS (2.13): typing a value after codec: offers the documented options', async () => {
		await schemaFrom(fakeBinary, '4.112.0');
		// One character typed (as VS Code's quick suggestions do); an empty value inside a component
		// gets nothing from Red Hat 1.24.0 (open question in the E2 notes).
		const doc = await openYaml('options.yaml', 'output:\n  file:\n    path: x\n    codec: l\n');
		await completionOffers(doc, new vscode.Position(3, 12), ['all-bytes', 'append', 'delim:x', 'lines']);
		// The option descriptions reach the completion items.
		const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(3, 12));
		const allBytes = list.items.find((i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'all-bytes');
		const docText = (d: vscode.CompletionItem['documentation']) => (typeof d === 'string' ? d : d?.value ?? '');
		assert.ok(docText(allBytes?.documentation).startsWith('Only applicable to file based outputs.'), docText(allBytes?.documentation));
	});

	test('VALUE_OPTIONS outside a component: an empty logger.level offers its options', async () => {
		await schemaFrom(fakeBinary, '4.112.0');
		const doc = await openYaml('level.yaml', 'input:\n  stdin: {}\nlogger:\n  level: \n');
		await completionOffers(doc, new vscode.Position(3, 9), ['ERROR', 'WARN', 'INFO', 'DEBUG']);
	});

	test('FREE_STRING (2.13): a value outside the options gets no schema diagnostic', async () => {
		await schemaFrom(fakeBinary, '4.112.0');
		const doc = await openYaml('free.yaml', 'output:\n  file:\n    path: x\n    codec: delim:foobar\nlogger:\n  level: [1]\n');
		// Positive control: Red Hat validates this file (the wrong type for logger.level is flagged).
		const schemaDiagnostics = () => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source?.startsWith('yaml-schema'));
		assert.ok(await waitFor(() => schemaDiagnostics().length > 0, 30_000), 'Red Hat did not validate the file');
		assert.deepStrictEqual(schemaDiagnostics().filter((d) => d.range.start.line === 3).map((d) => d.message), []);
	});

	test('HOVER_NETWORK (2.15): hovering a field with options lists them', async () => {
		await schemaFrom(fakeBinary, '4.112.0');
		const doc = await openYaml('hover-options.yaml', 'input:\n  socket_server:\n    network: tcp\n    address: x\n');
		let text = '';
		assert.ok(await waitForAsync(async () => {
			text = await hoverText(doc, new vscode.Position(2, 6));
			return text.includes('Options: `unix`, `tcp`, `udp`, `tls`, `unixgram`');
		}, 30_000), text);
	});

	/** Our provider alone, with the live schema and detection (to tell our items from Red Hat's). */
	function ours(doc: vscode.TextDocument, position: vscode.Position, options: { schema?: boolean; detected?: boolean } = {}): string[] | undefined {
		const provider = new GapCompletionProvider({
			schema: () => (options.schema === false ? undefined : api().schemaStore.current?.json),
			isDetected: (uri) => (options.detected === false ? false : api().detection.isDetected(uri)),
		});
		return provider.provideCompletionItems(doc, position)?.map((it) => (typeof it.label === 'string' ? it.label : it.label.label));
	}

	/** Schema labels of the merged list (word suggestions dropped). */
	async function merged(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
		const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, position);
		return (list?.items ?? []).filter((it) => it.kind !== vscode.CompletionItemKind.Text);
	}
	const labelOf = (it: vscode.CompletionItem) => (typeof it.label === 'string' ? it.label : it.label.label);

	/** Waits until Red Hat has the schema for `doc` and answers: hover on its first (root) key. */
	async function redHatReady(doc: vscode.TextDocument): Promise<void> {
		let text = '';
		assert.ok(await waitForAsync(async () => {
			text = await hoverText(doc, new vscode.Position(0, 1));
			return text.length > 0;
		}, 30_000), `Red Hat did not answer for ${doc.uri.path}`);
	}

	test('GAP_COMPLETION (2.16): an empty socket block offers its 8 fields with docs; an empty option value its options', async () => {
		await schemaFrom(fakeBinary, '4.112.0');
		const block = await openYaml('gap-block.yaml', 'input:\n  socket:\n    \noutput:\n  stdout: {}\n\n');
		await completionOffers(block, new vscode.Position(2, 4), ['address', 'network', 'tls', 'codec']);
		const items = (await merged(block, new vscode.Position(2, 4))).filter((it) => it.kind === vscode.CompletionItemKind.Property);
		assert.deepStrictEqual(items.map(labelOf).sort(),
			['address', 'auto_replay_nacks', 'codec', 'max_buffer', 'network', 'open_message_mapping', 'scanner', 'tls']);
		const network = items.find((it) => labelOf(it) === 'network')!;
		assert.ok(network.documentation instanceof vscode.MarkdownString && network.documentation.value.includes('Options: `unix`, `tcp`'));
		const value = await openYaml('gap-value.yaml', 'input:\n  socket_server:\n    network: \n');
		await completionOffers(value, new vscode.Position(2, 13), ['unix', 'tcp', 'udp', 'tls', 'unixgram']);
		assert.deepStrictEqual(ours(value, new vscode.Position(2, 13)), ['unix', 'tcp', 'udp', 'tls', 'unixgram']);
	});

	test('NO_DUPLICATES / SILENT (2.16): at gaps only we answer; at Red Hat positions only Red Hat answers', async () => {
		await schemaFrom(fakeBinary, '4.112.0');
		// [text, line, ch, gap]; Red Hat readiness is checked by a hover on the first root key.
		const cases: [string, number, number, boolean][] = [
			['input:\n  socket:\n    \n', 2, 4, true],
			['input:\n  socket:\n    ad\n', 2, 6, true],
			['input:\n  socket:\n    network: tcp\n    tls:\n      \n', 4, 6, true],
			['pipeline:\n  processors:\n    - branch:\n        \n', 3, 8, true],
			['cache_resources:\n  - label: c\n    memory:\n      \n', 3, 6, true],
			['output:\n  broker:\n    outputs:\n      - stdout:\n          \n', 4, 10, true],
			['input:\n  socket_server:\n    network: \n', 2, 13, true],
			['input:\n  socket:\n    auto_replay_nacks: \n', 2, 23, true],
			['input:\n  socket_server:\n    network: tcp\n    tls:\n      client_auth: \n', 4, 19, true],
			['input:\n  socket:\n    network: tcp\n    \n', 3, 4, false],
			['input:\n  stdin: {}\nlogger:\n  \n', 3, 2, false],
			['input:\n  stdin: {}\nlogger:\n  level: \n', 3, 9, false],
			['input:\n  \n', 1, 2, false],
			['pipeline:\n  processors:\n    - \n', 2, 6, false],
			['input:\n  stdin: {}\nlogger:\n  file:\n    \n', 4, 4, false],
			['input:\n  stdin: {}\nhttp:\n  cors:\n    \n', 4, 4, false],
		];
		for (const [i, [body, line, ch, gap]] of cases.entries()) {
			const doc = await openYaml(`dup${i}.yaml`, body);
			await redHatReady(doc);
			const position = new vscode.Position(line, ch);
			const mine = ours(doc, position) ?? [];
			const all = (await merged(doc, position)).map(labelOf);
			const dupes = all.filter((l, j) => all.indexOf(l) !== j);
			assert.deepStrictEqual(dupes, [], `case ${i}: duplicates ${JSON.stringify(body)}`);
			if (gap) {
				assert.ok(mine.length > 0, `case ${i}: we should answer ${JSON.stringify(body)}`);
				assert.deepStrictEqual([...all].sort(), [...mine].sort(), `case ${i}: Red Hat answered at a gap ${JSON.stringify(body)}`);
			} else {
				assert.deepStrictEqual(mine, [], `case ${i}: we must stay silent ${JSON.stringify(body)}`);
				assert.ok(all.length > 0, `case ${i}: Red Hat should answer ${JSON.stringify(body)}`);
			}
		}
	});

	test('NOT_DETECTED / NO_SCHEMA (2.16): no items', async () => {
		await schemaFrom(fakeBinary, '4.112.0');
		const doc = await openYaml('gap-guard.yaml', 'input:\n  socket:\n    \n');
		const position = new vscode.Position(2, 4);
		assert.ok((ours(doc, position) ?? []).length > 0, 'control: items with schema and detection');
		assert.strictEqual(ours(doc, position, { detected: false }), undefined);
		assert.strictEqual(ours(doc, position, { schema: false }), undefined);
		const k8s = await openYaml('gap-k8s.yaml', 'kind: Pod\nspec:\n  socket:\n    \n');
		assert.ok(!api().detection.isDetected(k8s.uri));
		assert.strictEqual(ours(k8s, new vscode.Position(3, 4)), undefined);
	});

	test('SNIPPETS (2.16): object, scalar-with-default and partial-key items insert valid, indented YAML', async () => {
		await schemaFrom(fakeBinary, '4.112.0');
		const insert = async (body: string, line: number, ch: number, label: string): Promise<string> => {
			const doc = await openYaml(`snip-${label}.yaml`, body);
			const editor = await vscode.window.showTextDocument(doc);
			const provider = new GapCompletionProvider({ schema: () => api().schemaStore.current?.json, isDetected: () => true });
			const position = new vscode.Position(line, ch);
			const item = provider.provideCompletionItems(doc, position)!.find((it) => it.label === label)!;
			const range = doc.getWordRangeAtPosition(position) ?? new vscode.Range(position, position);
			assert.ok(await editor.insertSnippet(item.insertText as vscode.SnippetString, range));
			return doc.getText();
		};
		assert.strictEqual(await insert('input:\n  socket:\n    \n', 2, 4, 'tls'), 'input:\n  socket:\n    tls:\n      \n');
		assert.strictEqual(await insert('input:\n  socket:\n    \n', 2, 4, 'socket: required fields'),
			'input:\n  socket:\n    network: unix\n    address: \n', 'the first choice is inserted; lines keep the block indent');
		assert.strictEqual(await insert('input:\n  socket:\n    \n', 2, 4, 'max_buffer'), 'input:\n  socket:\n    max_buffer: 1000000\n');
		assert.strictEqual(await insert('input:\n  socket:\n    ad\n', 2, 6, 'address'), 'input:\n  socket:\n    address: \n');
		assert.strictEqual(await insert('input:\n  socket:\n    network: tcp\n    tls:\n      \n', 4, 6, 'client_certs'),
			'input:\n  socket:\n    network: tcp\n    tls:\n      client_certs:\n        - \n');
	});

	test('BECOMES_DETECTED: typing pipeline: into a new YAML file brings completion without reopening', async () => {
		const doc = await openYaml('becomes.yaml', '');
		assert.strictEqual(api().detection.isDetected(doc.uri), false);
		const edit = new vscode.WorkspaceEdit();
		edit.insert(doc.uri, new vscode.Position(0, 0), 'pipeline:\n  processors:\n    - \n');
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.strictEqual(api().detection.isDetected(doc.uri), true);
		await completionOffers(doc, new vscode.Position(2, 6), ['mapping', 'bloblang']);
	});

	test('BECOMES_DETECTED (2.2): typing input: fires one onDidChangeDetection without reopening', async () => {
		const doc = await openYaml('typed.yaml', '');
		const events: { uri: string; detected: boolean }[] = [];
		const sub = api().detection.onDidChangeDetection((e) => events.push(e));
		try {
			for (const text of ['in', 'put:', '\n  stdin: {}\n']) {
				const edit = new vscode.WorkspaceEdit();
				edit.insert(doc.uri, doc.positionAt(doc.getText().length), text);
				assert.ok(await vscode.workspace.applyEdit(edit));
			}
			assert.strictEqual(api().detection.isDetected(doc.uri), true);
			assert.deepStrictEqual(events, [{ uri: doc.uri.toString(), detected: true }]);
		} finally {
			sub.dispose();
		}
	});

	test('PATTERN (2.2): filePatterns detects a template and a key-less file; clearing it recomputes', async () => {
		const template = await openYaml('t.rpcn.yaml', 'name: t\ntype: input\nmapping: |\n  root = {}\ninput:\n  stdin: {}\n');
		const plain = await openYaml('p.rpcn.yaml', 'foo: 1\n');
		const detection = api().detection;
		assert.strictEqual(detection.isDetected(template.uri), false);
		assert.strictEqual(detection.isDetected(plain.uri), false);
		const config = vscode.workspace.getConfiguration('redpandaConnect');
		const events: { uri: string; detected: boolean }[] = [];
		const sub = detection.onDidChangeDetection((e) => events.push(e));
		const flips = (detected: boolean) => events.filter((e) => e.detected === detected).map((e) => e.uri).sort();
		const both = [template.uri.toString(), plain.uri.toString()].sort();
		try {
			await config.update('filePatterns', ['**/*.rpcn.yaml'], vscode.ConfigurationTarget.Global);
			assert.ok(await waitFor(() => detection.isDetected(template.uri) && detection.isDetected(plain.uri), 5_000));
			assert.deepStrictEqual(flips(true), both);
		} finally {
			await config.update('filePatterns', undefined, vscode.ConfigurationTarget.Global);
		}
		assert.ok(await waitFor(() => !detection.isDetected(template.uri) && !detection.isDetected(plain.uri), 5_000));
		sub.dispose();
		assert.deepStrictEqual(flips(true), both, 'one detected: true per file');
		assert.deepStrictEqual(flips(false), both, 'one detected: false per file');
	});

	test('SCHEMA_CHANGES: a snapshot for another binary version is used by the open file without reopening', async () => {
		const doc = await openYaml('changes.yaml', 'input:\n  \n');
		const before = await schemaFrom(fakeBinary, '4.112.0');
		const oldUri = api().schemaContributor.requestSchema(doc.uri.toString());
		const labels = await completionOffers(doc, new vscode.Position(1, 2), ['generate']);
		assert.ok(!labels.includes(EXTRA_INPUT));

		await setBinaryPath(changedBinary);
		const after = await schemaFrom(changedBinary, '4.113.0');
		assert.notStrictEqual(after, before);
		const newUri = api().schemaContributor.requestSchema(doc.uri.toString());
		assert.ok(newUri && newUri !== oldUri, `${oldUri} -> ${newUri}`);
		await completionOffers(doc, new vscode.Position(1, 2), [EXTRA_INPUT, 'generate']);
	});
});

suite('Lint on save (integration)', function () {
	this.timeout(90_000);
	let dir: string;
	let counter: string;
	const originalPath = process.env.PATH;
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const config = () => vscode.workspace.getConfiguration('redpandaConnect');

	/** Lint diagnostics (our source only) for `doc`, as `[line, severity, message]`. */
	const lintOf = (doc: vscode.TextDocument) => vscode.languages.getDiagnostics(doc.uri)
		.filter((d) => d.source === 'Redpanda Connect')
		.map((d) => [d.range.start.line + 1, d.severity, d.message]);

	async function openSaved(name: string, text: string): Promise<vscode.TextDocument> {
		const file = path.join(dir, name);
		fs.writeFileSync(file, text);
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);
		return doc;
	}

	/** Makes the document dirty with a no-op-looking edit, then saves it. */
	async function editAndSave(doc: vscode.TextDocument, text = '\n'): Promise<void> {
		const edit = new vscode.WorkspaceEdit();
		edit.insert(doc.uri, doc.positionAt(doc.getText().length), text);
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.ok(await doc.save());
	}

	suiteSetup(async () => {
		const fixtures = fixtureBodies('4.112.0'); // absolute tool paths: resolved before PATH is filtered
		const grep = toolPath('grep');
		const cut = toolPath('cut');
		const cat = toolPath('cat');
		process.env.PATH = (originalPath ?? '').split(path.delimiter)
			.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
			.join(path.delimiter);
		dir = makeTempDir('rpcn-lint-');
		counter = path.join(dir, 'counter');
		// Lints like the spike: findings for lines that contain `nope:` or `codec:` in the target.
		const syntaxLine = path.join(dir, 'syntax-line');
		const lint = [
			// For syntax.yaml: a YAML syntax error at (1,1) naming the line in `syntax-line`, like real lint.
			`case "$last" in */syntax.yaml) echo "$last(1,1) yaml: line $('${cat}' '${syntaxLine}'): did not find expected key" >&2; exit 1 ;; esac`,
			'found=0',
			`for n in $('${grep}' -n 'nope:' "$last" | '${cut}' -d: -f1); do echo "$last($n,1) field nope not recognised" >&2; found=1; done`,
			`for n in $('${grep}' -n 'codec:' "$last" | '${cut}' -d: -f1); do echo "$last($n,1) field codec is deprecated" >&2; found=1; done`,
			`for n in $('${grep}' -n 'topci:' "$last" | '${cut}' -d: -f1); do echo "$last($n,1) field topci not recognised" >&2; found=1; done`,
			`for n in $('${grep}' -n 'network: tpc' "$last" | '${cut}' -d: -f1); do echo "$last($n,1) value tpc is not a valid option for this field" >&2; found=1; done`,
			'exit $found',
		].join('\n');
		const bin = writeFakeBinary(dir, 'redpanda-connect', connectScript({ version: '4.112.0', ...fixtures, lint, counterFile: counter }));
		await config().update('binaryPath', bin, vscode.ConfigurationTarget.Global);
		assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'ok'
			&& (api().redpandaConnect.state as { path: string }).path === bin, 30_000), JSON.stringify(api().redpandaConnect.state));
	});

	suiteTeardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		process.env.PATH = originalPath;
		await config().update('binaryPath', undefined, vscode.ConfigurationTarget.Global);
		await config().update('resourceFiles', undefined, vscode.ConfigurationTarget.Global);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('UNKNOWN_FIELD / DEPRECATED / FIRST_EDIT: save shows Error and Warning on their lines; the first edit clears them', async () => {
		const doc = await openSaved('lint.yaml', 'input:\n  generate:\n    mapping: root = {}\n    nope: 1\noutput:\n  file:\n    path: x\n    codec: lines\n');
		assert.ok(api().detection.isDetected(doc.uri));
		await editAndSave(doc);
		assert.ok(await waitFor(() => lintOf(doc).length === 2, 15_000), JSON.stringify(vscode.languages.getDiagnostics(doc.uri).map((d) => [d.source, d.range.start.line, d.message])) + ' runs: ' + readCounter(counter).join(',') + '\n' + api().outputLines().slice(-3).join('\n'));
		assert.deepStrictEqual(lintOf(doc), [
			[4, vscode.DiagnosticSeverity.Error, 'field nope not recognised'],
			[8, vscode.DiagnosticSeverity.Warning, 'field codec is deprecated'],
		]);
		assert.deepStrictEqual(api().lintDiagnostics.diagnosticsFor(doc.uri).filter((d) => d.source === 'Redpanda Connect').length, 2);
		const edit = new vscode.WorkspaceEdit();
		edit.insert(doc.uri, new vscode.Position(0, 0), '# x\n');
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.deepStrictEqual(lintOf(doc), []);
	});

	test('NOT_DETECTED: saving a non-Redpanda-Connect YAML runs no lint', async () => {
		const lints = () => readCounter(counter).filter((l) => l === 'lint').length;
		const before = lints();
		const doc = await openSaved('k8s.yaml', 'kind: Pod\nnope: 1\n');
		assert.ok(!api().detection.isDetected(doc.uri));
		await editAndSave(doc);
		// Positive control: a detected save afterwards is linted, so the undetected one had its chance.
		const control = await openSaved('control.yaml', 'input:\n  generate:\n    nope: 1\n');
		await editAndSave(control);
		assert.ok(await waitFor(() => lintOf(control).length === 1, 15_000));
		assert.strictEqual(lints(), before + 1);
		assert.deepStrictEqual(lintOf(doc), []);
	});

	test('YAML_SYNTAX with real Red Hat: lint\'s syntax error (on another line) is hidden while Red Hat reports one', async () => {
		const doc = await openSaved('syntax.yaml', 'input:\n  generate:\n    mapping: root = {}\n  - bad\noutput:\n  stdout: {}\n');
		assert.ok(api().detection.isDetected(doc.uri));
		const redHat = () => vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'YAML');
		assert.ok(await waitFor(() => redHat().length > 0, 30_000), 'Red Hat reported no syntax error');
		const line = redHat()[0].range.start.line + 1;
		// Like go-yaml, lint names the line where the enclosing block starts, not Red Hat's line.
		assert.notStrictEqual(line, 1);
		fs.writeFileSync(path.join(dir, 'syntax-line'), '1');
		const lints = () => readCounter(counter).filter((l) => l === 'lint').length;
		const before = lints();
		await editAndSave(doc);
		assert.ok(await waitFor(() => lints() === before + 1, 15_000), 'syntax.yaml was not linted');
		// Give the controller the result (and Red Hat its re-validation); it must not show on Red Hat's line.
		await new Promise((r) => setTimeout(r, 1_000));
		assert.ok(redHat().some((d) => d.range.start.line + 1 === line), 'Red Hat still flags the line');
		assert.deepStrictEqual(lintOf(doc), []);
		const ours = api().lintDiagnostics.diagnosticsFor(doc.uri).filter((d) => d.source === 'Redpanda Connect');
		assert.deepStrictEqual(ours, []);
	});

	test('BUILDER_FAIL: a relative resourceFiles entry with no workspace logs one line and publishes nothing', async () => {
		await config().update('resourceFiles', ['res.yaml'], vscode.ConfigurationTarget.Global);
		try {
			const doc = await openSaved('builder.yaml', 'input:\n  generate:\n    nope: 1\n');
			const expected = 'Lint builder.yaml: redpandaConnect.resourceFiles "res.yaml" is a relative path, but no workspace folder is open.';
			await editAndSave(doc);
			assert.ok(await waitFor(() => api().outputLines().includes(expected), 15_000), api().outputLines().slice(-5).join('\n'));
			await new Promise((r) => setTimeout(r, 500));
			assert.strictEqual(api().outputLines().filter((l) => l === expected).length, 1);
			assert.deepStrictEqual(lintOf(doc), []);
		} finally {
			await config().update('resourceFiles', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test('QUICK_FIX (2.5): a lint "not recognised" finding offers "Change to `topic`"; applying changes only the key', async () => {
		const text = '# keep me\ninput:\n  stdin: {}\noutput:\n  kafka_franz:\n    seed_brokers: [ "${B}" ]  # brokers\n    topci: t\n';
		const doc = await openSaved('fix.yaml', text);
		assert.ok(await waitFor(() => api().schemaStore.current !== undefined, 30_000));
		await editAndSave(doc); // appends '\n'
		assert.ok(await waitFor(() => lintOf(doc).length === 1, 15_000), JSON.stringify(lintOf(doc)));
		const diagnostic = vscode.languages.getDiagnostics(doc.uri).find((d) => d.source === 'Redpanda Connect')!;
		const list = await vscode.commands.executeCommand<vscode.CodeAction[]>(
			'vscode.executeCodeActionProvider', doc.uri, diagnostic.range, vscode.CodeActionKind.QuickFix.value);
		const ours = list.filter((a) => a.title.startsWith('Change to'));
		assert.strictEqual(ours[0]?.title, 'Change to `topic`', JSON.stringify(list.map((a) => a.title)));
		assert.ok(await vscode.workspace.applyEdit(ours[0].edit!));
		assert.strictEqual(doc.getText(), `${text.replace('topci:', 'topic:')}\n`);
		assert.deepStrictEqual(lintOf(doc), [], 'the fix is an edit, so lint findings clear');
	});

	test('OPTION_FIX (2.14): an invalid option offers "Change to `tcp`"; applying changes only the value', async () => {
		const text = 'input:\n  socket_server:\n    network: tpc  # keep\n    address: 0.0.0.0:6000\noutput:\n  stdout: {}\n';
		const doc = await openSaved('option.yaml', text);
		assert.ok(await waitFor(() => api().schemaStore.current !== undefined, 30_000));
		await editAndSave(doc);
		assert.ok(await waitFor(() => lintOf(doc).length === 1, 15_000), JSON.stringify(lintOf(doc)));
		const diagnostic = vscode.languages.getDiagnostics(doc.uri).find((d) => d.source === 'Redpanda Connect')!;
		const list = await vscode.commands.executeCommand<vscode.CodeAction[]>(
			'vscode.executeCodeActionProvider', doc.uri, diagnostic.range, vscode.CodeActionKind.QuickFix.value);
		const ours = list.filter((a) => a.title.startsWith('Change to'));
		assert.strictEqual(ours[0]?.title, 'Change to `tcp`', JSON.stringify(list.map((a) => a.title)));
		assert.ok(await vscode.workspace.applyEdit(ours[0].edit!));
		assert.strictEqual(doc.getText(), `${text.replace('network: tpc', 'network: tcp')}\n`);
		assert.deepStrictEqual(lintOf(doc), [], 'the fix is an edit, so lint findings clear');
	});
});

suite('Run and Stop (integration)', function () {
	this.timeout(90_000);
	let dir: string;
	let counter: string;
	let events: string;
	const originalPath = process.env.PATH;
	const api = () => vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID)!.exports;
	const config = () => vscode.workspace.getConfiguration('redpandaConnect');
	const runTerminals = (name: string) => vscode.window.terminals.filter((t) => t.name === `Redpanda Connect: ${name}`);
	const eventLines = () => (fs.existsSync(events) ? fs.readFileSync(events, 'utf8').split('\n').filter(Boolean) : []);

	async function open(name: string, text: string): Promise<vscode.TextDocument> {
		const file = path.join(dir, name);
		fs.writeFileSync(file, text);
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);
		return doc;
	}

	suiteSetup(async () => {
		const fixtures = fixtureBodies('4.112.0');
		process.env.PATH = (originalPath ?? '').split(path.delimiter)
			.filter((d) => d && !['rpk', 'redpanda-connect'].some((b) => fs.existsSync(path.join(d, b))))
			.join(path.delimiter);
		dir = makeTempDir('rpcn-run-');
		counter = path.join(dir, 'counter');
		events = path.join(dir, 'events');
		// Like run_generate.yaml: prints, then waits; SIGINT ends it with exit 0 (spike).
		const run = [
			`echo "started cwd=$(pwd) argv=$*" >> '${events}'`,
			`trap 'echo "interrupted" >> '"'${events}'"'; exit 0' INT`,
			'echo tick',
			'while :; do sleep 0.05; done',
		].join('\n');
		const bin = writeFakeBinary(dir, 'redpanda-connect', connectScript({ version: '4.112.0', ...fixtures, run, counterFile: counter }));
		await config().update('binaryPath', bin, vscode.ConfigurationTarget.Global);
		assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'ok'
			&& (api().redpandaConnect.state as { path: string }).path === bin, 30_000));
	});

	suiteTeardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		vscode.window.terminals.filter((t) => t.name.startsWith('Redpanda Connect: ')).forEach((t) => t.dispose());
		process.env.PATH = originalPath;
		await config().update('binaryPath', undefined, vscode.ConfigurationTarget.Global);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('RUN / STOP / RERUN: run in the file\'s terminal, Stop interrupts, Run again reuses the terminal', async () => {
		const doc = await open('pipe.yaml', 'input:\n  generate:\n    mapping: root = "tick"\noutput:\n  stdout: {}\n');
		assert.ok(api().detection.isDetected(doc.uri));
		await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
		assert.ok(await waitFor(() => eventLines().length === 1, 15_000), 'the binary was not started');
		// The builder's argv exactly: no other flags (no --chilled / --verbose).
		assert.strictEqual(eventLines()[0], `started cwd=${fs.realpathSync(dir)} argv=run --set http.enabled=false ${doc.uri.fsPath}`);
		assert.strictEqual(runTerminals('pipe.yaml').length, 1);
		assert.strictEqual(api().run.phaseOf(doc.uri), 'running');

		await vscode.commands.executeCommand('redpandaConnect.stop', doc.uri);
		assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'exited', 15_000));
		assert.deepStrictEqual(eventLines().slice(1), ['interrupted']);

		await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
		assert.ok(await waitFor(() => eventLines().length === 3, 15_000));
		assert.strictEqual(runTerminals('pipe.yaml').length, 1, 'the terminal is reused');
		await vscode.commands.executeCommand('redpandaConnect.stop', doc.uri);
		assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'exited', 15_000));
	});

	test('DIRTY: Run saves unsaved changes first', async () => {
		const doc = await open('dirty.yaml', 'input:\n  generate:\n    mapping: root = "a"\noutput:\n  stdout: {}\n');
		const edit = new vscode.WorkspaceEdit();
		edit.insert(doc.uri, new vscode.Position(0, 0), '# edited\n');
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.ok(doc.isDirty);
		await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
		assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'running', 15_000));
		assert.strictEqual(doc.isDirty, false);
		assert.ok(fs.readFileSync(doc.uri.fsPath, 'utf8').startsWith('# edited'));
		await vscode.commands.executeCommand('redpandaConnect.stop', doc.uri);
		assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'exited', 15_000));
	});

	test('UNTITLED: an untitled config does not run', async () => {
		const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: 'input:\n  stdin: {}\n' });
		await vscode.window.showTextDocument(doc);
		assert.ok(await waitFor(() => api().detection.isDetected(doc.uri), 5_000));
		const runs = () => readCounter(counter).filter((l) => l === 'run').length;
		const before = runs();
		await vscode.commands.executeCommand('redpandaConnect.run');
		await vscode.commands.executeCommand('redpandaConnect.runUntitled');
		assert.strictEqual(api().run.phaseOf(doc.uri), undefined);
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
		// Positive control: the same content saved to a file runs.
		const saved = await open('was-untitled.yaml', 'input:\n  stdin: {}\n');
		await vscode.commands.executeCommand('redpandaConnect.run');
		assert.ok(await waitFor(() => runs() === before + 1, 15_000), 'the saved file did not run');
		assert.strictEqual(api().run.phaseOf(saved.uri), 'running');
		await vscode.commands.executeCommand('redpandaConnect.stop');
		assert.ok(await waitFor(() => api().run.phaseOf(saved.uri) === 'exited', 15_000));
	});

	test('NO_BINARY: Run logs one line and opens no terminal', async () => {
		const doc = await open('nobin.yaml', 'input:\n  stdin: {}\n');
		await config().update('binaryPath', path.join(dir, 'gone'), vscode.ConfigurationTarget.Global);
		try {
			assert.ok(await waitFor(() => api().redpandaConnect.state.kind === 'missing', 15_000));
			await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
			assert.ok(api().outputLines().includes('Run nobin.yaml: no usable Redpanda Connect binary.'));
			assert.strictEqual(runTerminals('nobin.yaml').length, 0);
		} finally {
			await config().update('binaryPath', path.join(dir, 'redpanda-connect'), vscode.ConfigurationTarget.Global);
			await waitFor(() => api().redpandaConnect.state.kind === 'ok', 15_000);
		}
	});

	test('contributions: icons, palette and editor-title clauses, the untitled entry', () => {
		const contributes = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes;
		const command = (id: string) => contributes.commands.find((c: { command: string }) => c.command === id);
		assert.deepStrictEqual(command('redpandaConnect.run'), { command: 'redpandaConnect.run', title: 'Run', category: 'Redpanda Connect', icon: '$(play)' });
		assert.deepStrictEqual(command('redpandaConnect.stop'), { command: 'redpandaConnect.stop', title: 'Stop', category: 'Redpanda Connect', icon: '$(debug-stop)' });
		assert.deepStrictEqual(command('redpandaConnect.runUntitled'), {
			command: 'redpandaConnect.runUntitled', title: 'Save the file to run it.', category: 'Redpanda Connect', icon: '$(play)', enablement: 'false',
		});
		const palette = Object.fromEntries(contributes.menus.commandPalette.map((m: { command: string; when: string }) => [m.command, m.when]));
		assert.strictEqual(palette['redpandaConnect.run'], 'redpandaConnect.activeEditorDetected');
		assert.strictEqual(palette['redpandaConnect.stop'], 'redpandaConnect.activeEditorRunning');
		assert.strictEqual(palette['redpandaConnect.runUntitled'], 'false');
		assert.deepStrictEqual(contributes.menus['editor/title'], [
			{ command: 'redpandaConnect.run', when: 'resourceScheme != untitled && resourcePath in redpandaConnect.detectedPaths', group: 'navigation' },
			{ command: 'redpandaConnect.runUntitled', when: 'resourceScheme == untitled && resourcePath in redpandaConnect.detectedPaths', group: 'navigation' },
		]);
	});
});
