// Binary-missing onboarding notification (AD-9, EXPERIENCE Flow 2). The RedpandaConnect
// adapter owns the once-per-transition rule; every VS Code call sits behind `BinaryNotifier`
// so the rule is unit-tested without VS Code. No `vscode` import here.

import { formatVersion, MIN_VERSION } from '../../core/version';
import type { BinaryState, LogLine } from './binary';
import { errorText } from './text';

export const INSTALL_GUIDE_URL = 'https://docs.redpanda.com/connect/install/';

export const INSTALL_GUIDE_ACTION = 'Install guide';
export const SET_PATH_ACTION = 'Set path';
export const RETRY_ACTION = 'Retry';
export const NOTIFICATION_ACTIONS: readonly string[] = [INSTALL_GUIDE_ACTION, SET_PATH_ACTION, RETRY_ACTION];

/** EXPERIENCE Voice and Tone, verbatim. */
export const MISSING_MESSAGE = 'Redpanda Connect binary not found. Schema, validation, graph and Run need '
	+ '`rpk connect` or `redpanda-connect`.';

/** The thin VS Code surface the notification needs; the real one is wired in `src/extension.ts`. */
export interface BinaryNotifier {
	/** A non-modal warning; resolves with the clicked action, or `undefined` when dismissed. */
	showWarning(message: string, actions: readonly string[]): PromiseLike<string | undefined>;
	/** Opens `url` outside VS Code. */
	openExternal(url: string): PromiseLike<unknown>;
	/** A file picker; resolves with the chosen file's absolute path, or `undefined` on cancel. */
	pickBinary(): PromiseLike<string | undefined>;
	/** Writes `redpandaConnect.binaryPath` at user (Global) scope. */
	setBinaryPath(binaryPath: string): PromiseLike<void>;
}

/** The subscription `attachBinaryNotifications` returns. */
export interface BinaryNotifications {
	/** The warning's actions, for the graph panel's empty state (one implementation, AD-9). */
	readonly actions: BinaryActions;
	dispose(): void;
	/**
	 * Shows the warning for `state` again, with the same copy and actions, outside a transition:
	 * for user-triggered commands that need a binary (Run, Refresh Schema). Returns whether a
	 * warning was shown (`false` for `ok` / `unresolved`).
	 */
	showAgain(state: BinaryState): boolean;
}

/** What the notification needs from the state owner. */
export interface BinaryStateSource {
	onDidChange(listener: (state: BinaryState) => void): { dispose(): void };
	refresh(): PromiseLike<BinaryState>;
}

type InvalidState = Extract<BinaryState, { kind: 'invalid' }>;

/** The plain-words reason an `invalid` binary can't be used. */
export function invalidReasonText(state: InvalidState): string {
	switch (state.reason) {
		case 'belowMinimum':
			return `version ${state.version} is older than the required v${formatVersion(MIN_VERSION)}`;
		case 'noVersionLine':
			return 'it did not report a version';
		case 'unparseableVersion':
			return 'it reported a version that can\'t be read';
		case 'nonZeroExit':
			return 'its version check exited with an error';
		case 'timeout':
			return 'it timed out';
		case 'spawnError':
			return 'it could not be started';
		case 'relativePathWithoutWorkspace':
			return 'a relative path needs an open workspace folder';
	}
}

/** The notification text for `state`, or `undefined` when no notification is due (`ok`, `unresolved`). */
export function notificationMessage(state: BinaryState): string | undefined {
	switch (state.kind) {
		case 'missing':
			return MISSING_MESSAGE;
		case 'invalid':
			return `Redpanda Connect at \`${state.path}\` can't be used: ${invalidReasonText(state)}.`;
		default:
			return undefined;
	}
}

/** What the state says about the picked path, for the Set path log line. */
function pickedOutcome(state: BinaryState, picked: string): string {
	if (state.kind === 'invalid') {
		return state.path === picked
			? `it can't be used: ${invalidReasonText(state)}`
			: `\`${state.path}\` (tried before the setting) can't be used: ${invalidReasonText(state)}, and the picked file is not a usable binary either`;
	}
	return 'it is not a usable Redpanda Connect binary (missing, or rpk without "rpk connect install")';
}

/** The three recovery actions of the binary warning (AD-9), shared by the notification and the graph panel's empty state. */
export interface BinaryActions {
	/** Install guide: opens INSTALL_GUIDE_URL. */
	installGuide(): Promise<void>;
	/** Set path: picks a file, saves it as `redpandaConnect.binaryPath` and re-resolves. */
	setPath(): Promise<void>;
	/** Retry: re-resolves. */
	retry(): Promise<void>;
}

/** What Set path needs of the warnings: how many were shown, and showing one more. */
export interface BinaryWarnings {
	/** How many warnings have been shown so far. */
	readonly shown: number;
	/** Shows the warning `message`, with the three actions. */
	show(message: string): void;
}

/**
 * The binary warning's actions. Set path, Flow 2 failure: if the state is still `missing` /
 * `invalid` and no transition warning fired (the state value did not change, e.g. an invalid
 * binary on PATH still wins), the warning is shown again for the current state and the log says
 * what the picked path resolved to. Retry and background refreshes keep "no warning on an
 * unchanged state". After `isDisposed()` turns true, nothing more happens.
 */
export function binaryActions(
	source: Pick<BinaryStateSource, 'refresh'>,
	notifier: BinaryNotifier,
	log: LogLine,
	warnings: BinaryWarnings,
	isDisposed: () => boolean = () => false,
): BinaryActions {
	return {
		async installGuide() {
			if (isDisposed()) {
				return;
			}
			await notifier.openExternal(INSTALL_GUIDE_URL);
		},
		async setPath() {
			if (isDisposed()) {
				return;
			}
			const picked = await notifier.pickBinary();
			if (picked === undefined || isDisposed()) {
				return;
			}
			const before = warnings.shown;
			await notifier.setBinaryPath(picked);
			const state = await source.refresh();
			const message = notificationMessage(state);
			if (isDisposed() || message === undefined || warnings.shown !== before) {
				return;
			}
			log(`Set path: redpandaConnect.binaryPath is now "${picked}", but no usable binary resulted: ${pickedOutcome(state, picked)}.`);
			warnings.show(message);
		},
		async retry() {
			if (isDisposed()) {
				return;
			}
			await source.refresh();
		},
	};
}

/**
 * Shows one warning per transition of `binaryState` into `missing` or `invalid`.
 * `onDidChange` fires only when the state value changes (including the first resolution
 * at activation), so each such event is a transition; a refresh that leaves the state
 * unchanged fires nothing and shows nothing. Returns the subscription, whose `actions` are the
 * warning's actions (for the graph panel's empty state).
 */
export function attachBinaryNotifications(
	source: BinaryStateSource,
	notifier: BinaryNotifier,
	log: LogLine,
): BinaryNotifications {
	let disposed = false;
	/** Counts warnings shown, so Set path can tell whether its own refresh notified. */
	let shownCount = 0;

	const show = (message: string): void => {
		shownCount++;
		Promise.resolve(notifier.showWarning(message, NOTIFICATION_ACTIONS))
			.then(runAction)
			.catch((err: unknown) => {
				log(`Redpanda Connect notification action failed: ${errorText(err)}`);
			});
	};

	const actions = binaryActions(source, notifier, log, { get shown() { return shownCount; }, show }, () => disposed);

	async function runAction(action: string | undefined): Promise<void> {
		switch (action) {
			case INSTALL_GUIDE_ACTION:
				return actions.installGuide();
			case SET_PATH_ACTION:
				return actions.setPath();
			case RETRY_ACTION:
				return actions.retry();
			default:
				// Dismissed: nothing happens; the next transition notifies again.
				return;
		}
	}

	const subscription = source.onDidChange((state) => {
		const message = notificationMessage(state);
		if (disposed || message === undefined) {
			return;
		}
		show(message);
	});

	return {
		actions,
		dispose() {
			disposed = true;
			subscription.dispose();
		},
		showAgain(state) {
			const message = notificationMessage(state);
			if (disposed || message === undefined) {
				return false;
			}
			show(message);
			return true;
		},
	};
}
