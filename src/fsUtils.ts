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

/** Same contract as `readFileSafe`, but via `fs.promises` — required (not
 * just nicer) for any bulk scan that wants to read many files through
 * `concurrency.ts`'s `pMap`: a synchronous `readFileSync` blocks the single
 * JS thread for its own duration no matter how its caller is scheduled, so
 * there is no way to get overlapping I/O out of it. Use this (not
 * `readFileSafe`) for any workspace-wide scan; keep `readFileSafe` for
 * single-file, event-driven reads (a save/watch handler for one file) where
 * there's nothing to overlap and `await` would only add overhead. */
export async function readFileSafeAsync(filePath: string): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
}

/** Escapes a literal string for safe embedding inside a `new RegExp(...)`
 * pattern. */
export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
