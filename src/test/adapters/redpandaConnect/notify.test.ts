import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { BinaryState, RedpandaConnect } from '../../../adapters/redpandaConnect/binary';
import {
	BinaryNotifier, INSTALL_GUIDE_URL, invalidReasonText, MISSING_MESSAGE, NOTIFICATION_ACTIONS, notificationMessage,
} from '../../../adapters/redpandaConnect/notify';
import { makeTempDir, RPK_NO_PLUGIN_SCRIPT, versionScript, writeFakeBinary } from '../../helpers/fakeBinary';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error('condition not met in time');
		}
		await new Promise((r) => setTimeout(r, 10));
	}
}

/** Lets pending promise chains run (no spawn is involved). */
const ticks = () => new Promise((r) => setTimeout(r, 20));

interface Warning {
	readonly message: string;
	readonly actions: readonly string[];
	/** Simulates clicking an action (or dismissing with `undefined`). */
	readonly click: (action: string | undefined) => void;
}

/** A fake notifier: records every call; `setBinaryPath` writes the fake setting. */
class FakeNotifier implements BinaryNotifier {
	readonly warnings: Warning[] = [];
	readonly opened: string[] = [];
	readonly written: string[] = [];
	pickCalls = 0;
	nextPick: string | undefined;

	constructor(private readonly writeSetting: (value: string) => void) {}

	showWarning(message: string, actions: readonly string[]): Promise<string | undefined> {
		return new Promise((resolve) => this.warnings.push({ message, actions: [...actions], click: resolve }));
	}

	async openExternal(url: string): Promise<boolean> {
		this.opened.push(url);
		return true;
	}

	async pickBinary(): Promise<string | undefined> {
		this.pickCalls++;
		return this.nextPick;
	}

	async setBinaryPath(binaryPath: string): Promise<void> {
		this.written.push(binaryPath);
		this.writeSetting(binaryPath);
	}
}

// Rows of the plan's I/O & edge-case matrix. The real RedpandaConnect state owner runs against
// fake binaries with an isolated PATH and setting; only the VS Code surface is faked.
suite('adapters/redpandaConnect binary notification (matrix)', () => {
	let root: string;
	let pathDir: string;
	let setting: string;
	let resolutions: number;
	let lines: string[];
	let notifier: FakeNotifier;
	let rc: RedpandaConnect;
	let okBin: string;
	let oldBin: string;

	setup(() => {
		root = makeTempDir('rpcn-notify-');
		pathDir = path.join(root, 'path');
		fs.mkdirSync(pathDir);
		okBin = writeFakeBinary(root, 'rc-ok', versionScript('4.112.0'));
		oldBin = writeFakeBinary(root, 'rc-old', versionScript('4.63.0'));
		setting = '';
		resolutions = 0;
		lines = [];
		notifier = new FakeNotifier((value) => { setting = value; });
		rc = new RedpandaConnect({
			log: (line) => lines.push(line),
			notifier,
			environment: () => {
				resolutions++;
				return { binaryPathSetting: setting, envPath: pathDir, homeDir: root, workspaceFolder: undefined };
			},
		});
	});
	teardown(() => {
		rc.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	});

	/** Clicks `action` on the latest warning and waits for the refresh it starts to finish. */
	const clickAndRefresh = async (action: string) => {
		const before = resolutions;
		notifier.warnings[notifier.warnings.length - 1].click(action);
		await waitFor(() => resolutions > before);
		await rc.refresh(); // shares the in-flight run started by the action
	};

	test('MISSING_AT_ACTIVATION: one warning with the missing copy and all three actions', async () => {
		assert.strictEqual((await rc.refresh()).kind, 'missing');
		assert.strictEqual(notifier.warnings.length, 1);
		assert.strictEqual(notifier.warnings[0].message,
			'Redpanda Connect binary not found. Schema, validation, graph and Run need `rpk connect` or `redpanda-connect`.');
		assert.deepStrictEqual(notifier.warnings[0].actions, ['Install guide', 'Set path', 'Retry']);
	});

	test('INVALID_OLD: a 4.63.0 binary gives one invalid warning with all three actions', async () => {
		const bin = writeFakeBinary(pathDir, 'redpanda-connect', versionScript('4.63.0'));
		assert.deepStrictEqual(await rc.refresh(), { kind: 'invalid', path: bin, reason: 'belowMinimum', version: '4.63.0' });
		assert.strictEqual(notifier.warnings.length, 1);
		assert.strictEqual(notifier.warnings[0].message,
			`Redpanda Connect at \`${bin}\` can't be used: version 4.63.0 is older than the required v4.100.0.`);
		assert.deepStrictEqual(notifier.warnings[0].actions, ['Install guide', 'Set path', 'Retry']);
	});

	test('NO_REPEAT: a refresh that leaves the state missing does not notify again', async () => {
		await rc.refresh();
		await rc.refresh();
		await rc.refresh();
		assert.strictEqual(notifier.warnings.length, 1);
	});

	test('NO_REPEAT: a refresh that leaves the same invalid does not notify again', async () => {
		setting = oldBin;
		await rc.refresh();
		await rc.refresh();
		assert.strictEqual(rc.state.kind, 'invalid');
		assert.strictEqual(notifier.warnings.length, 1);
	});

	test('OK_SILENT: becoming or staying ok shows nothing', async () => {
		setting = okBin;
		assert.strictEqual((await rc.refresh()).kind, 'ok');
		await rc.refresh();
		assert.strictEqual(notifier.warnings.length, 0);
	});

	test('RE_TRANSITION: ok → missing later notifies again', async () => {
		const bin = writeFakeBinary(pathDir, 'redpanda-connect', versionScript('4.112.0'));
		assert.strictEqual((await rc.refresh()).kind, 'ok');
		fs.rmSync(bin);
		assert.strictEqual((await rc.refresh()).kind, 'missing');
		assert.strictEqual(notifier.warnings.length, 1);
		assert.strictEqual(notifier.warnings[0].message, MISSING_MESSAGE);
	});

	test('INSTALL_GUIDE: opens the install docs externally; state unchanged', async () => {
		await rc.refresh();
		const before = resolutions;
		notifier.warnings[0].click('Install guide');
		await waitFor(() => notifier.opened.length > 0);
		await ticks();
		assert.deepStrictEqual(notifier.opened, ['https://docs.redpanda.com/connect/install/']);
		assert.strictEqual(INSTALL_GUIDE_URL, 'https://docs.redpanda.com/connect/install/');
		assert.strictEqual(resolutions, before, 'Install guide must not refresh');
		assert.strictEqual(rc.state.kind, 'missing');
		assert.strictEqual(notifier.warnings.length, 1);
	});

	test('SET_PATH_VALID: writes the setting, refreshes to ok, no further warning', async () => {
		await rc.refresh();
		notifier.nextPick = okBin;
		await clickAndRefresh('Set path');
		assert.deepStrictEqual(notifier.written, [okBin]);
		assert.deepStrictEqual(rc.state, { kind: 'ok', path: okBin, version: '4.112.0', invocation: [okBin] });
		assert.strictEqual(notifier.warnings.length, 1);
	});

	test('SET_PATH_INVALID: writes the setting, refreshes to invalid, and notifies again', async () => {
		await rc.refresh();
		notifier.nextPick = oldBin;
		await clickAndRefresh('Set path');
		assert.deepStrictEqual(notifier.written, [oldBin]);
		assert.strictEqual(rc.state.kind, 'invalid');
		assert.strictEqual(notifier.warnings.length, 2);
		assert.strictEqual(notifier.warnings[1].message,
			`Redpanda Connect at \`${oldBin}\` can't be used: version 4.63.0 is older than the required v4.100.0.`);
		assert.deepStrictEqual(notifier.warnings[1].actions, NOTIFICATION_ACTIONS);
	});

	test('SET_PATH_CANCEL: cancelling the picker writes nothing and does not refresh', async () => {
		await rc.refresh();
		const before = resolutions;
		notifier.nextPick = undefined;
		notifier.warnings[0].click('Set path');
		await waitFor(() => notifier.pickCalls === 1);
		await ticks();
		assert.deepStrictEqual(notifier.written, []);
		assert.strictEqual(resolutions, before);
		assert.strictEqual(notifier.warnings.length, 1);
	});

	test('RETRY_FIXED: a binary installed on PATH, then Retry → ok, no further warning', async () => {
		await rc.refresh();
		const bin = writeFakeBinary(pathDir, 'redpanda-connect', versionScript('4.112.0'));
		await clickAndRefresh('Retry');
		assert.deepStrictEqual(rc.state, { kind: 'ok', path: bin, version: '4.112.0', invocation: [bin] });
		assert.strictEqual(notifier.warnings.length, 1);
		assert.deepStrictEqual(notifier.written, []);
	});

	test('RETRY_STILL_MISSING: Retry re-resolves; state unchanged → no new warning', async () => {
		await rc.refresh();
		await clickAndRefresh('Retry');
		assert.strictEqual(rc.state.kind, 'missing');
		assert.strictEqual(notifier.warnings.length, 1);
	});

	test('DISMISSED: nothing happens; the next transition notifies again', async () => {
		await rc.refresh();
		const before = resolutions;
		notifier.warnings[0].click(undefined);
		await ticks();
		assert.strictEqual(resolutions, before);
		assert.deepStrictEqual(notifier.opened, []);
		assert.strictEqual(notifier.pickCalls, 0);

		const bin = writeFakeBinary(pathDir, 'redpanda-connect', versionScript('4.112.0'));
		assert.strictEqual((await rc.refresh()).kind, 'ok');
		fs.rmSync(bin);
		assert.strictEqual((await rc.refresh()).kind, 'missing');
		assert.strictEqual(notifier.warnings.length, 2);
	});

	test('a failing action is logged, not thrown', async () => {
		await rc.refresh();
		notifier.openExternal = async () => { throw new Error('no browser'); };
		notifier.warnings[0].click('Install guide');
		await waitFor(() => lines.some((l) => l.includes('no browser')));
		assert.ok(lines.includes('Redpanda Connect notification action failed: no browser'), lines.join('\n'));
	});

	for (const action of ['Set path', 'Retry']) {
		test(`disposed while a warning is open: ${action} writes and refreshes nothing`, async () => {
			await rc.refresh();
			const before = resolutions;
			notifier.nextPick = okBin;
			rc.dispose();
			notifier.warnings[0].click(action);
			await ticks();
			assert.strictEqual(notifier.pickCalls, 0);
			assert.deepStrictEqual(notifier.written, []);
			assert.strictEqual(resolutions, before);
			assert.strictEqual(notifier.warnings.length, 1);
		});
	}

	/** Clicks Set path on warning 0 with `pick`, then waits for the re-shown warning. */
	const setPathAndWaitForRepeat = async (pick: string) => {
		notifier.nextPick = pick;
		notifier.warnings[0].click('Set path');
		await waitFor(() => notifier.warnings.length === 2);
		assert.deepStrictEqual(notifier.written, [pick]);
		assert.deepStrictEqual(notifier.warnings[1].actions, NOTIFICATION_ACTIONS);
		assert.ok(lines.some((l) => l.startsWith(`Set path: redpandaConnect.binaryPath is now "${pick}", but no usable binary resulted:`)),
			lines.join('\n'));
	};

	test('SET_PATH_INVALID: an invalid binary on PATH still wins → the same invalid warning is shown again', async () => {
		const onPath = writeFakeBinary(pathDir, 'redpanda-connect', versionScript('4.63.0'));
		const bad = writeFakeBinary(root, 'rc-bad', 'exit 1');
		await rc.refresh();
		await setPathAndWaitForRepeat(bad);
		assert.deepStrictEqual(rc.state, { kind: 'invalid', path: onPath, reason: 'belowMinimum', version: '4.63.0' });
		assert.strictEqual(notifier.warnings[1].message, notifier.warnings[0].message);
	});

	test('SET_PATH_INVALID: re-picking the current invalid path shows the warning again', async () => {
		setting = oldBin;
		await rc.refresh();
		await setPathAndWaitForRepeat(oldBin);
		assert.strictEqual(rc.state.kind, 'invalid');
		assert.strictEqual(notifier.warnings[1].message, notifier.warnings[0].message);
	});

	test('SET_PATH_INVALID: rpk without its plugin stays missing → the missing warning is shown again', async () => {
		fs.mkdirSync(path.join(root, 'tools'));
		const rpk = writeFakeBinary(path.join(root, 'tools'), 'rpk', RPK_NO_PLUGIN_SCRIPT);
		await rc.refresh();
		await setPathAndWaitForRepeat(rpk);
		assert.strictEqual(rc.state.kind, 'missing');
		assert.strictEqual(notifier.warnings[1].message, MISSING_MESSAGE);
	});

	test('SET_PATH_INVALID: a picked path that vanished stays missing → the missing warning is shown again', async () => {
		await rc.refresh();
		await setPathAndWaitForRepeat(path.join(root, 'gone', 'redpanda-connect'));
		assert.strictEqual(rc.state.kind, 'missing');
		assert.strictEqual(notifier.warnings[1].message, MISSING_MESSAGE);
	});

	test('SET_PATH_INVALID: missing → invalid notifies once (the transition), not twice', async () => {
		await rc.refresh();
		notifier.nextPick = oldBin;
		await clickAndRefresh('Set path');
		await ticks();
		assert.strictEqual(notifier.warnings.length, 2);
		assert.ok(!lines.some((l) => l.startsWith('Set path:')), lines.join('\n'));
	});
});

suite('adapters/redpandaConnect binary notification copy', () => {
	const invalid = (reason: Extract<BinaryState, { kind: 'invalid' }>['reason'], version?: string) => ({
		kind: 'invalid' as const, path: '/opt/rc', reason, ...(version ? { version } : {}),
	});

	test('missing copy matches EXPERIENCE Voice and Tone', () => {
		assert.strictEqual(notificationMessage({ kind: 'missing' }), MISSING_MESSAGE);
	});

	test('ok and unresolved have no notification', () => {
		assert.strictEqual(notificationMessage({ kind: 'unresolved' }), undefined);
		assert.strictEqual(notificationMessage({ kind: 'ok', path: '/rc', version: '4.112.0', invocation: ['/rc'] }), undefined);
	});

	test('plain-words reasons', () => {
		assert.strictEqual(invalidReasonText(invalid('belowMinimum', '4.63.0')), 'version 4.63.0 is older than the required v4.100.0');
		assert.strictEqual(invalidReasonText(invalid('noVersionLine')), 'it did not report a version');
		assert.strictEqual(invalidReasonText(invalid('timeout')), 'it timed out');
		assert.strictEqual(invalidReasonText(invalid('spawnError')), 'it could not be started');
		assert.strictEqual(invalidReasonText(invalid('relativePathWithoutWorkspace')), 'a relative path needs an open workspace folder');
		assert.strictEqual(invalidReasonText(invalid('nonZeroExit')), 'its version check exited with an error');
		assert.strictEqual(invalidReasonText(invalid('unparseableVersion')), 'it reported a version that can\'t be read');
	});

	test('invalid copy', () => {
		assert.strictEqual(notificationMessage(invalid('timeout')), 'Redpanda Connect at `/opt/rc` can\'t be used: it timed out.');
	});
});
