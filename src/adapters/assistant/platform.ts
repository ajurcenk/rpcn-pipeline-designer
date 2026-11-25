// Story 8.2 (AD-26): this platform as the Claude Agent SDK's binary packages name it
// (`@anthropic-ai/claude-agent-sdk-<os>-<arch>[-musl]`, each holding a `claude`, `claude.exe` on win32),
// musl included, decided once per process. The runtime itself (which package, where it is installed,
// whether it is there) is `runtime.ts`'s. No `vscode` import.

export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/**
 * Whether the C library is musl, as the SDK decides it: on Linux, a process report without a glibc
 * runtime version. Never on another platform.
 */
export function isMusl(platform: NodeJS.Platform = process.platform, report: () => unknown = () => process.report?.getReport()): boolean {
	if (platform !== 'linux') {
		return false;
	}
	let r: unknown;
	try {
		r = report();
	} catch {
		return false;
	}
	const header = (r as { header?: { glibcVersionRuntime?: unknown } } | null | undefined)?.header;
	return r !== null && r !== undefined && header?.glibcVersionRuntime === undefined;
}

let muslOnce: boolean | undefined;

/** Review 4: `isMusl` for this process, decided once (a diagnostic report is costly). */
export function hostIsMusl(report?: () => unknown): boolean {
	if (muslOnce === undefined) {
		muslOnce = isMusl(process.platform, report);
	}
	return muslOnce;
}

/** Test seam: forget `hostIsMusl`'s answer. */
export function resetHostMuslForTest(): void {
	muslOnce = undefined;
}

/** The platform as the binary packages name it: `linux-x64`, `darwin-arm64`, `linux-arm64-musl`. */
export function platformLabel(platform: string, arch: string, musl: boolean): string {
	return `${platform}-${arch}${platform === 'linux' && musl ? '-musl' : ''}`;
}

/** This process's platform label (musl decided once). */
export function hostPlatform(): string {
	return platformLabel(process.platform, process.arch, hostIsMusl());
}

/** The binary's file name in its package, for an OS (`process.platform`, or a label's first part). */
export function binaryName(os: string): string {
	return os === 'win32' ? 'claude.exe' : 'claude';
}
