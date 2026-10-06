// Pure parsing and comparison for `redpanda-connect --version` / `rpk connect --version` output.
// Expected stdout (spike 1.1, Q7):
//   Version: 4.112.0
//   Date: 2026-10-02T08:48:17Z
// Some builds print a `v` prefix (`Version: v4.100.0`).

const VERSION_LINE = /^Version: (\S+)$/;
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(-\S+)?$/;
const RPK_CONNECT_NOT_INSTALLED = /rpk connect is not installed/;

/** A numeric `major.minor.patch[-prerelease]` version; `prerelease` excludes the leading `-`. */
export interface Version {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly prerelease?: string;
}

/** Minimum supported Redpanda Connect version (AD-9). */
export const MIN_VERSION: Version = { major: 4, minor: 100, patch: 0 };

/** Returns the version token from `--version` stdout, as printed, or `undefined` if no `Version:` line is present. */
export function parseVersionOutput(stdout: string): string | undefined {
	for (const line of stdout.split(/\r?\n/)) {
		const match = VERSION_LINE.exec(line);
		if (match) {
			return match[1];
		}
	}
	return undefined;
}

/** Parses `4.112.0`, `v4.100.0` or `4.113.0-rc1`; anything else is `undefined`. */
export function parseVersion(token: string): Version | undefined {
	const match = SEMVER.exec(token);
	if (!match) {
		return undefined;
	}
	const version: Version = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
	return match[4] ? { ...version, prerelease: match[4].slice(1) } : version;
}

/** Formats without the `v` prefix: `4.100.0`, `4.113.0-rc1`. */
export function formatVersion(version: Version): string {
	const core = `${version.major}.${version.minor}.${version.patch}`;
	return version.prerelease ? `${core}-${version.prerelease}` : core;
}

/**
 * Negative when `a < b`, zero when equal, positive when `a > b`.
 * A pre-release sorts below its release; pre-releases compare by SemVer identifier rules.
 */
export function compareVersions(a: Version, b: Version): number {
	const core = (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
	if (core !== 0) {
		return core;
	}
	if (a.prerelease === b.prerelease) {
		return 0;
	}
	if (a.prerelease === undefined) {
		return 1;
	}
	if (b.prerelease === undefined) {
		return -1;
	}
	return comparePrerelease(a.prerelease, b.prerelease);
}

/** True when `version` is at least `minimum` (default {@link MIN_VERSION}). */
export function meetsMinimum(version: Version, minimum: Version = MIN_VERSION): boolean {
	return compareVersions(version, minimum) >= 0;
}

/** True when `rpk connect --version` output says the managed Redpanda Connect plugin is not installed. */
export function isRpkConnectNotInstalled(output: string): boolean {
	return RPK_CONNECT_NOT_INSTALLED.test(output);
}

function comparePrerelease(a: string, b: string): number {
	const as = a.split('.');
	const bs = b.split('.');
	for (let i = 0; i < Math.min(as.length, bs.length); i++) {
		const x = as[i];
		const y = bs[i];
		const xNum = /^\d+$/.test(x);
		const yNum = /^\d+$/.test(y);
		if (xNum && yNum) {
			const diff = Number(x) - Number(y);
			if (diff !== 0) {
				return diff;
			}
		} else if (xNum !== yNum) {
			return xNum ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return as.length - bs.length;
}
