// Whether this VS Code can read pipeline logs (ticket 6.2, the user's decision of 2026-11-05):
// `@platformatic/kafka` needs Node 22.22 or later (it uses `Promise.withResolvers`), while
// `engines.vscode` stays `^1.100.0`, whose Node is older. On an older Node, Set up log access and
// Show logs say so and send nothing. No `vscode` import.

/** The oldest Node the client runs on: `@platformatic/kafka`'s `engines.node` (>= 22.22.0). */
export const MIN_NODE: readonly [number, number] = [22, 22];

/** Whether Node `version` ("22.23.1") can run the client. */
export function nodeSupported(version: string = process.versions.node): boolean {
	const [major, minor] = version.split('.').map((n) => Number.parseInt(n, 10));
	if (!Number.isFinite(major) || !Number.isFinite(minor)) {
		return false;
	}
	return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/** "Pipeline logs need a newer VS Code (Node 22.22 or later; this one has 20.18.3)". */
export function newerVsCodeMessage(version: string = process.versions.node): string {
	return `Pipeline logs need a newer VS Code (Node ${MIN_NODE[0]}.${MIN_NODE[1]} or later; this one has ${version})`;
}
