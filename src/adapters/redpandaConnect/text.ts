// Text helpers shared by the RedpandaConnect adapter modules for log lines and state details.

/** The message of an `Error`, or `String(err)` for anything else thrown. */
export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The first line of `text` that is not blank, trimmed; `undefined` when every line is blank. */
export function firstNonEmptyLine(text: string): string | undefined {
	return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
}
