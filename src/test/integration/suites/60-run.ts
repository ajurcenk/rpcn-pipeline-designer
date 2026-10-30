import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { type ExtensionApi } from '../../../extension';
import { type RemoveItem, SecretVariables } from '../../../adapters/vscode/secrets';
import { connectScript, fixtureBodies, makeTempDir, readCounter, writeFakeBinary } from '../../helpers/fakeBinary';
import { EXTENSION_ID, runOnEditor, userFilesHolding, waitFor } from '../helpers';

suite('Run and Stop (integration)', function () {
	this.timeout(90_000);
	let dir: string;
	let counter: string;
	let events: string;
	/** Ticket 30: what the fake binary saw of `SECRET_30` and `CLASH_30` in its environment, one line per start. */
	let seen: string;
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
		seen = path.join(dir, 'seen');
		// Like run_generate.yaml: prints, then waits; SIGINT ends it with exit 0 (spike).
		const run = [
			`echo "started cwd=$(pwd) argv=$*" >> '${events}'`,
			`echo "SECRET_30=\${SECRET_30-<unset>} CLASH_30=\${CLASH_30-<unset>}" >> '${seen}'`,
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
		await api().secrets!.clear(async () => true);
		await config().update('secretEnv', undefined, vscode.ConfigurationTarget.Global);
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

	test('ticket 29 EVERY_COMMAND / CHANGED / WRITE_FAILS: redpandaConnect.env reaches Run as the last --env-file; an edit makes a new file; an unwritable folder stops the run', async () => {
		const envFile = path.join(dir, 'run.env');
		fs.writeFileSync(envFile, 'API_TOKEN=from-file\n');
		await config().update('envFile', envFile, vscode.ConfigurationTarget.Global);
		await config().update('env', { API_TOKEN: 'tok-29-secret-a' }, vscode.ConfigurationTarget.Global);
		let folder: string | undefined;
		try {
			const doc = await open('env-setting.yaml', 'input:\n  generate:\n    mapping: root = "${API_TOKEN}"\noutput:\n  stdout: {}\n');
			const runOnce = async (): Promise<string> => {
				const before = eventLines().length;
				await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
				assert.ok(await waitFor(() => eventLines().length > before, 15_000), 'the binary was not started');
				const started = eventLines()[before];
				await vscode.commands.executeCommand('redpandaConnect.stop', doc.uri);
				assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'exited', 15_000));
				return started;
			};
			const first = await runOnce();
			const generated = /--env-file (\S+) --env-file (\S+) /.exec(first);
			assert.ok(generated, first);
			assert.strictEqual(generated[1], envFile, 'envFile\'s file first');
			assert.ok(first.endsWith(`argv=run --set http.enabled=false --env-file ${envFile} --env-file ${generated[2]} ${doc.uri.fsPath}`), first);
			assert.strictEqual(fs.readFileSync(generated[2], 'utf8'), 'API_TOKEN="tok-29-secret-a"\n');
			folder = path.dirname(generated[2]);
			assert.strictEqual(path.basename(folder), 'env-setting');

			// CHANGED: the next run gets a new file with the new value, without a restart.
			await config().update('env', { API_TOKEN: 'tok-29-secret-b' }, vscode.ConfigurationTarget.Global);
			const second = await runOnce();
			const next = /--env-file \S+ --env-file (\S+) /.exec(second)?.[1];
			assert.ok(next && next !== generated[2], second);
			assert.strictEqual(fs.readFileSync(next, 'utf8'), 'API_TOKEN="tok-29-secret-b"\n');

			// WRITE_FAILS: the folder is a file now; a new value cannot be written, so Run does not start.
			fs.rmSync(folder, { recursive: true, force: true });
			fs.writeFileSync(folder, '');
			await config().update('env', { API_TOKEN: 'tok-29-secret-c' }, vscode.ConfigurationTarget.Global);
			const before = eventLines().length;
			await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
			const line = () => api().outputLines().find((l) => l.startsWith('Run env-setting.yaml: redpandaConnect.env: the variables could not be written to '));
			assert.ok(await waitFor(() => line() !== undefined, 5_000), api().outputLines().slice(-5).join('\n'));
			await new Promise((r) => setTimeout(r, 300));
			assert.strictEqual(eventLines().length, before, 'the binary was not started');
			const leaked = api().outputLines().filter((l) => l.includes('tok-29-secret') || l.includes('from-file'));
			assert.deepStrictEqual(leaked, [], 'no value is logged');
		} finally {
			await config().update('env', undefined, vscode.ConfigurationTarget.Global);
			await config().update('envFile', undefined, vscode.ConfigurationTarget.Global);
			if (folder && fs.existsSync(folder) && fs.statSync(folder).isFile()) {
				fs.rmSync(folder);
			}
		}
	});

	test('ticket 29 EMPTY: with redpandaConnect.env set to {} the argv is as without it', async () => {
		await config().update('env', {}, vscode.ConfigurationTarget.Global);
		try {
			const doc = await open('env-empty.yaml', 'input:\n  generate:\n    mapping: root = "tick"\noutput:\n  stdout: {}\n');
			const before = eventLines().length;
			await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
			assert.ok(await waitFor(() => eventLines().length > before, 15_000));
			assert.ok(eventLines()[before].endsWith(`argv=run --set http.enabled=false ${doc.uri.fsPath}`), eventLines()[before]);
			await vscode.commands.executeCommand('redpandaConnect.stop', doc.uri);
			assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'exited', 15_000));
		} finally {
			await config().update('env', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test('ticket 30 SET / EVERY_COMMAND / CHANGE / REMOVE / NO_VALUE / CLASH / CLEAR / NO_LEAK: a stored secret reaches Run\'s environment, never a file, an argv or a log line', async () => {
		const seenLines = () => (fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').split('\n').filter(Boolean) : []);
		const envFile = path.join(dir, 'secret.env');
		fs.writeFileSync(envFile, 'CLASH_30=from-file\n');
		assert.ok(api().secrets, 'the test seam is there in test mode');
		const secrets = api().secrets!;
		try {
			const doc = await open('secret.yaml', 'input:\n  generate:\n    mapping: root = "${SECRET_30}"\noutput:\n  stdout: {}\n');
			/** Runs once and returns what the binary saw. */
			const runOnce = async (): Promise<string> => {
				const before = seenLines().length;
				await vscode.commands.executeCommand('redpandaConnect.run', doc.uri);
				assert.ok(await waitFor(() => seenLines().length > before, 15_000), 'the binary was not started');
				await vscode.commands.executeCommand('redpandaConnect.stop', doc.uri);
				assert.ok(await waitFor(() => api().run.phaseOf(doc.uri) === 'exited', 15_000));
				return seenLines()[before];
			};

			// EMPTY: no declared secret, the argv as before.
			const plainStarts = eventLines().length;
			assert.strictEqual(await runOnce(), 'SECRET_30=<unset> CLASH_30=<unset>');
			assert.ok(eventLines()[plainStarts].endsWith(`argv=run --set http.enabled=false ${doc.uri.fsPath}`), eventLines()[plainStarts]);

			// SET: no folder is open, so the value is the window's and the name goes to the user settings.
			assert.strictEqual(await secrets.set(undefined, 'SECRET_30', 'tok-30-secret-a'), true);
			assert.deepStrictEqual(config().inspect('secretEnv')?.globalValue, ['SECRET_30']);
			assert.ok(secrets.recordedKeys().includes('redpandaConnect.secret:window:SECRET_30'), JSON.stringify(secrets.recordedKeys()));
			const starts = eventLines().length;
			assert.strictEqual(await runOnce(), 'SECRET_30=tok-30-secret-a CLASH_30=<unset>');
			assert.ok(eventLines()[starts].endsWith(`argv=run --set http.enabled=false ${doc.uri.fsPath}`), 'the argv is unchanged');

			// CHANGE: the next run gets the new value, no restart.
			await secrets.set(undefined, 'SECRET_30', 'tok-30-secret-b');
			assert.deepStrictEqual(config().inspect('secretEnv')?.globalValue, ['SECRET_30'], 'the name is added once');
			assert.strictEqual(await runOnce(), 'SECRET_30=tok-30-secret-b CLASH_30=<unset>');

			// CLASH: told once by name; the secret is still passed (the real binary lets the env file win, suite 61).
			await config().update('envFile', envFile, vscode.ConfigurationTarget.Global);
			await secrets.set(undefined, 'CLASH_30', 'tok-30-secret-clash');
			assert.strictEqual(await runOnce(), 'SECRET_30=tok-30-secret-b CLASH_30=tok-30-secret-clash');
			await runOnce();
			const clash = api().outputLines().filter((l) => l.startsWith('redpandaConnect.secretEnv: CLASH_30 is also set by the redpandaConnect.envFile file'));
			assert.strictEqual(clash.length, 1, JSON.stringify(clash));
			await config().update('envFile', undefined, vscode.ConfigurationTarget.Global);
			assert.strictEqual(await runOnce(), 'SECRET_30=tok-30-secret-b CLASH_30=tok-30-secret-clash');

			// REMOVE: the value goes, the name stays declared, so it is told once that it has none.
			assert.strictEqual(await secrets.remove(undefined, 'SECRET_30'), true);
			assert.strictEqual(await runOnce(), 'SECRET_30=<unset> CLASH_30=tok-30-secret-clash');
			await runOnce();
			const none = api().outputLines().filter((l) => l.startsWith('redpandaConnect.secretEnv: SECRET_30 has no value on this machine for this window'));
			assert.strictEqual(none.length, 1, JSON.stringify(none));
			assert.deepStrictEqual(config().inspect('secretEnv')?.globalValue, ['SECRET_30', 'CLASH_30']);

			// CLEAR: cancelled removes nothing; confirmed removes every recorded key.
			assert.strictEqual(await secrets.clear(async () => false), 0);
			assert.strictEqual(await runOnce(), 'SECRET_30=<unset> CLASH_30=tok-30-secret-clash');
			assert.ok(await secrets.clear(async () => true) >= 1);
			assert.deepStrictEqual(secrets.recordedKeys(), []);
			assert.strictEqual(await runOnce(), 'SECRET_30=<unset> CLASH_30=<unset>');
			await secrets.reload();
			assert.deepStrictEqual(secrets.values.keys(), [], 'nothing is left in the secret storage');

			// NO_LEAK: no value in the output channel, Run's terminal or a file.
			const leaked = api().outputLines().filter((l) => l.includes('tok-30-secret'));
			assert.deepStrictEqual(leaked, [], 'no value is logged');
			assert.ok(!(api().run.outputOf(doc.uri) ?? '').includes('tok-30-secret'), 'no value in the terminal');
			assert.deepStrictEqual(userFilesHolding('tok-30-secret'), [], 'no settings or storage file holds a value');
		} finally {
			await secrets.clear(async () => true);
			await config().update('secretEnv', undefined, vscode.ConfigurationTarget.Global);
			await config().update('envFile', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test('ticket 30 STORE_FAILS / bad name: a refused name or a failing store stores nothing and declares nothing; the error has no value', async () => {
		assert.strictEqual(await api().secrets!.set(undefined, '1BAD', 'tok-30-secret-bad'), false);
		assert.strictEqual(config().inspect('secretEnv')?.globalValue, undefined);
		assert.ok(!api().secrets!.recordedKeys().some((k) => k.endsWith(':1BAD')));

		const lines: string[] = [];
		const state = new Map<string, unknown>();
		const memento: vscode.Memento = {
			keys: () => [...state.keys()],
			get: <T>(key: string, fallback?: T) => (state.has(key) ? state.get(key) as T : fallback) as T,
			update: async (key: string, value: unknown) => {
				state.set(key, value);
			},
		};
		const failing = new SecretVariables({
			store: {
				get: async () => {
					throw new Error('keyring locked');
				},
				store: async (_key: string, value: string) => {
					throw new Error(`keyring refused ${value}`);
				},
				delete: async () => undefined,
				onDidChange: new vscode.EventEmitter<{ key: string }>().event,
			},
			memento,
			log: (l) => lines.push(l),
		});
		try {
			assert.strictEqual(await failing.set(undefined, 'FAIL_30', 'tok-30-secret-fail'), false);
			assert.strictEqual(config().inspect('secretEnv')?.globalValue, undefined, 'nothing declared');
			assert.deepStrictEqual(failing.recordedKeys(), [], 'nothing recorded');
			assert.deepStrictEqual(failing.values.keys(), []);
			assert.ok(lines.some((l) => l.startsWith('redpandaConnect.secretEnv: could not store FAIL_30 for this window: keyring refused')), JSON.stringify(lines));
			assert.ok(!lines.some((l) => l.includes('tok-30-secret')), JSON.stringify(lines));
		} finally {
			failing.dispose();
		}
	});

	test('ticket 30: overlapping set and remove keep the recorded keys right (their updates run one at a time)', async () => {
		const state = new Map<string, unknown>();
		const memento: vscode.Memento = {
			keys: () => [...state.keys()],
			get: <T>(key: string, fallback?: T) => (state.has(key) ? state.get(key) as T : fallback) as T,
			// Slow, so two unserialized read-filter-writes would overlap.
			update: async (key: string, value: unknown) => {
				await new Promise((r) => setTimeout(r, 30));
				state.set(key, value);
			},
		};
		const stored = new Map<string, string>();
		const changed = new vscode.EventEmitter<{ key: string }>();
		const secrets = new SecretVariables({
			store: {
				get: async (key: string) => stored.get(key),
				store: async (key: string, value: string) => {
					stored.set(key, value);
				},
				delete: async (key: string) => {
					stored.delete(key);
				},
				onDidChange: changed.event,
			},
			memento,
			log: () => undefined,
		});
		try {
			assert.ok(await secrets.set(undefined, 'REC_A_30', 'tok-30-secret-ra'));
			const [removed, set] = await Promise.all([secrets.remove(undefined, 'REC_A_30'), secrets.set(undefined, 'REC_B_30', 'tok-30-secret-rb')]);
			assert.ok(removed && set);
			assert.deepStrictEqual(secrets.recordedKeys(), ['redpandaConnect.secret:window:REC_B_30']);
		} finally {
			secrets.dispose();
			changed.dispose();
			await config().update('secretEnv', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	/** A `SecretVariables` on an in-memory store and memento; `stored` and `changed` play another window. */
	function fakeSecrets(extra: Partial<ConstructorParameters<typeof SecretVariables>[0]> = {}) {
		const state = new Map<string, unknown>();
		const stored = new Map<string, string>();
		const changed = new vscode.EventEmitter<{ key: string }>();
		const secrets = new SecretVariables({
			store: {
				get: async (key: string) => stored.get(key),
				store: async (key: string, value: string) => {
					stored.set(key, value);
				},
				delete: async (key: string) => {
					stored.delete(key);
				},
				onDidChange: changed.event,
			},
			memento: {
				keys: () => [...state.keys()],
				get: <T>(key: string, fallback?: T) => (state.has(key) ? state.get(key) as T : fallback) as T,
				update: async (key: string, value: unknown) => {
					state.set(key, value);
				},
			},
			log: () => undefined,
			...extra,
		});
		return { secrets, stored, changed, dispose: () => { secrets.dispose(); changed.dispose(); } };
	}

	test('ticket 30 settle: another window\'s change inside the settle window is applied once it ends, with no other trigger', async () => {
		const fake = fakeSecrets({ settleMs: 200 });
		const key = 'redpandaConnect.secret:window:SETTLE_30';
		try {
			assert.ok(await fake.secrets.set(undefined, 'SETTLE_30', 'mine'));
			// Another window writes the key inside this window's settle window: the load keeps this window's write.
			fake.stored.set(key, 'theirs');
			fake.changed.fire({ key });
			await fake.secrets.settled;
			assert.strictEqual(fake.secrets.values.get('window', 'SETTLE_30'), 'mine');
			// No further event or setting change: the reload at the window's end brings the other value.
			assert.ok(await waitFor(() => fake.secrets.values.get('window', 'SETTLE_30') === 'theirs', 2_000),
				String(fake.secrets.values.get('window', 'SETTLE_30')));
		} finally {
			fake.dispose();
			await config().update('secretEnv', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test('ticket 30 declare undo: when the name cannot be added to secretEnv, the stored value and its record go, and only the failure is shown', async () => {
		const messages: [string, string][] = [];
		const fake = fakeSecrets({
			updateSetting: async () => {
				throw new Error('settings locked');
			},
			notify: (kind, message) => messages.push([kind, message]),
		});
		try {
			assert.strictEqual(await fake.secrets.setAndTell(undefined, 'UNDO_30', 'tok-30-secret-undo'), false);
			assert.deepStrictEqual([...fake.stored.keys()], [], 'the stored value is removed again');
			assert.deepStrictEqual(fake.secrets.recordedKeys(), [], 'and its record');
			assert.strictEqual(fake.secrets.values.get('window', 'UNDO_30'), undefined);
			assert.strictEqual(config().inspect('secretEnv')?.globalValue, undefined, 'nothing declared');
			assert.deepStrictEqual(messages, [['error', 'Could not set the secret variable UNDO_30: it could not be added to redpandaConnect.secretEnv: settings locked']]);
		} finally {
			fake.dispose();
		}
	});

	test('ticket 39 COMMAND: Remove secret variable lists stored names and declared ones without a value; each removal asks, naming the settings file', async () => {
		const messages: [string, string][] = [];
		const choices: ('value' | 'both' | undefined)[] = [];
		const confirms: boolean[] = [];
		const asked: string[] = [];
		const fake = fakeSecrets({
			notify: (kind, message) => messages.push([kind, message]),
			pickRemoval: async (name, where) => {
				asked.push(`pick ${name} in ${where}`);
				return choices.shift();
			},
			confirmRemoveName: async (name, where) => {
				asked.push(`confirm ${name} in ${where}`);
				return confirms.shift() ?? false;
			},
		});
		let listed: RemoveItem[] = [];
		const picking = (name: string | undefined) => async (items: RemoveItem[]) => {
			listed = items;
			return items.find((i) => i.name === name);
		};
		try {
			assert.ok(await fake.secrets.set(undefined, 'CMD_A_39', 'tok-39-cmd-a'));
			await config().update('secretEnv', ['CMD_A_39', 'CMD_B_39'], vscode.ConfigurationTarget.Global);
			await fake.secrets.reload();

			// The list: the stored name, then the declared one without a value.
			await fake.secrets.removeCommand(picking(undefined));
			assert.deepStrictEqual(listed.map((i) => [i.name, i.hasValue]), [['CMD_A_39', true], ['CMD_B_39', false]]);
			assert.deepStrictEqual([...messages], [], 'cancelled: nothing');

			// CANCEL: the confirmation and the choice, cancelled, change nothing.
			await fake.secrets.removeCommand(picking('CMD_B_39'));
			choices.push(undefined);
			await fake.secrets.removeCommand(picking('CMD_A_39'));
			assert.deepStrictEqual(asked, ['confirm CMD_B_39 in the user settings', 'pick CMD_A_39 in the user settings']);
			assert.deepStrictEqual(config().inspect('secretEnv')?.globalValue, ['CMD_A_39', 'CMD_B_39']);
			assert.strictEqual(fake.secrets.values.get('window', 'CMD_A_39'), 'tok-39-cmd-a');

			// Without a value: the name, after the confirmation.
			confirms.push(true);
			await fake.secrets.removeCommand(picking('CMD_B_39'));
			assert.deepStrictEqual(config().inspect('secretEnv')?.globalValue, ['CMD_A_39']);
			assert.deepStrictEqual(messages.pop(), ['info', 'CMD_B_39 is removed from redpandaConnect.secretEnv in the user settings.']);

			// With a value, value only (the default): the name stays.
			choices.push('value');
			await fake.secrets.removeCommand(picking('CMD_A_39'));
			assert.strictEqual(fake.secrets.values.get('window', 'CMD_A_39'), undefined);
			assert.deepStrictEqual(config().inspect('secretEnv')?.globalValue, ['CMD_A_39']);
			assert.deepStrictEqual(messages.pop(), ['info', 'Secret variable CMD_A_39 is removed for this window; the name stays in redpandaConnect.secretEnv.']);

			// Value and name; the last name removes the setting.
			assert.ok(await fake.secrets.set(undefined, 'CMD_A_39', 'tok-39-cmd-a2'));
			choices.push('both');
			await fake.secrets.removeCommand(picking('CMD_A_39'));
			assert.deepStrictEqual([...fake.stored.keys()], []);
			assert.strictEqual(config().inspect('secretEnv')?.globalValue, undefined, 'removed, not []');
			assert.deepStrictEqual(messages.pop(), ['info', 'Secret variable CMD_A_39 is removed: its value, and its name from redpandaConnect.secretEnv in the user settings.']);

			// Nothing left.
			await fake.secrets.removeCommand(picking(undefined));
			assert.deepStrictEqual(messages.pop(), ['info', 'No secret variable is stored or declared for this window.']);
			assert.ok(!messages.some(([, m]) => m.includes('tok-39')), JSON.stringify(messages));
		} finally {
			fake.dispose();
			await config().update('secretEnv', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test('ticket 39 VALUE_FAILS / NAME_FAILS: a failing delete changes nothing; a failing settings write says the value is removed and the name is not', async () => {
		const messages: [string, string][] = [];
		const lines: string[] = [];
		const state = new Map<string, unknown>();
		const memento: vscode.Memento = {
			keys: () => [...state.keys()],
			get: <T>(key: string, fallback?: T) => (state.has(key) ? state.get(key) as T : fallback) as T,
			update: async (key: string, value: unknown) => {
				state.set(key, value);
			},
		};
		const stored = new Map<string, string>([['redpandaConnect.secret:window:FAIL_39', 'tok-39-fail']]);
		let deleteFails = true;
		let writeFails = false;
		const secrets = new SecretVariables({
			store: {
				get: async (key: string) => stored.get(key),
				store: async (key: string, value: string) => {
					stored.set(key, value);
				},
				delete: async (key: string) => {
					if (deleteFails) {
						throw new Error('keyring locked');
					}
					stored.delete(key);
				},
				onDidChange: new vscode.EventEmitter<{ key: string }>().event,
			},
			memento,
			log: (l) => lines.push(l),
			notify: (kind, message) => messages.push([kind, message]),
			updateSetting: async (c, value, target) => {
				if (writeFails) {
					throw new Error('settings locked');
				}
				await c.update('secretEnv', value, target);
			},
		});
		try {
			await config().update('secretEnv', ['FAIL_39'], vscode.ConfigurationTarget.Global);
			await secrets.reload();
			assert.strictEqual(secrets.values.get('window', 'FAIL_39'), 'tok-39-fail');

			// VALUE_FAILS: the error, and nothing else changes.
			assert.deepStrictEqual(await secrets.removeValueAndName(undefined, 'FAIL_39'), { ok: false });
			assert.deepStrictEqual([...messages], [['error', 'Could not remove the secret variable FAIL_39: keyring locked']]);
			assert.deepStrictEqual(config().inspect('secretEnv')?.globalValue, ['FAIL_39'], 'the name stays');
			assert.ok(stored.has('redpandaConnect.secret:window:FAIL_39'));

			// NAME_FAILS: the value goes, the name stays, and the error says so and why.
			messages.length = 0;
			deleteFails = false;
			writeFails = true;
			assert.strictEqual((await secrets.removeValueAndName(undefined, 'FAIL_39')).ok, false);
			assert.deepStrictEqual([...messages], [['error',
				'The value of the secret variable FAIL_39 is removed, but its name is not: it could not be removed from redpandaConnect.secretEnv in the user settings: settings locked']]);
			assert.deepStrictEqual([...stored.keys()], []);
			assert.strictEqual(secrets.values.get('window', 'FAIL_39'), undefined);
			assert.deepStrictEqual(config().inspect('secretEnv')?.globalValue, ['FAIL_39']);
			assert.ok(![...lines, ...messages.map(([, m]) => m)].some((l) => l.includes('tok-39')), 'no value in a message or a log line');
		} finally {
			secrets.dispose();
			await config().update('secretEnv', undefined, vscode.ConfigurationTarget.Global);
		}
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
		await runOnEditor(doc, 'workbench.action.revertAndCloseActiveEditor');
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
		// The run entries; the graph's Show / Hide toggle (3.10) is checked by the graph suite.
		const runEntries = contributes.menus['editor/title'].filter((m: { command: string }) => m.command.startsWith('redpandaConnect.run'));
		assert.deepStrictEqual(runEntries, [
			{ command: 'redpandaConnect.run', when: 'resourceScheme != untitled && resourcePath in redpandaConnect.detectedPaths', group: 'navigation' },
			{ command: 'redpandaConnect.runUntitled', when: 'resourceScheme == untitled && resourcePath in redpandaConnect.detectedPaths', group: 'navigation' },
		]);
	});
});
