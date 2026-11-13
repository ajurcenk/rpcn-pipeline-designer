// The text of a thrown value, shared by every layer that logs or shows one (story 55). Pure; this
// layer imports nothing from `src/core`, `src/adapters` or `vscode` (AD-15).

/** The message of an `Error`, or `String(err)` for anything else thrown. */
export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
