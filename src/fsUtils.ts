import * as fs from "fs";

/** Reads a file as utf8 text, or `undefined` if it doesn't exist / can't be
 * read — the "best-effort read" used throughout the indexing/diagnostics
 * layer, which treats a missing/unreadable file as "nothing to report" bar
 * an error. */
export function readFileSafe(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

/** Escapes a literal string for safe embedding inside a `new RegExp(...)`
 * pattern. */
export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
