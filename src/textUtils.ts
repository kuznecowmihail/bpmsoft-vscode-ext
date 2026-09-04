const BOM_RE = /^\uFEFF/;

/** Strips a leading UTF-8 BOM (`\uFEFF`), if present — real BPMSoft package
 * text files (`descriptor.json`, `metadata.json`, a client schema's own
 * Structure `.js`, ...) can have one just as easily as not, and neither
 * `JSON.parse` nor a plain regex anchored at the start of the string
 * tolerates it on its own. */
export function stripBom(text: string): string {
	return text.replace(BOM_RE, "");
}

/** `JSON.parse`, BOM-tolerant (see `stripBom`) and returning `undefined` on
 * any parse failure instead of throwing — matching how every call site
 * already handled a bad `JSON.parse` (try/catch discarding the error), just
 * without repeating the boilerplate. */
export function parseJsonNoBom<T = unknown>(text: string): T | undefined {
	try {
		return JSON.parse(stripBom(text)) as T;
	} catch {
		return undefined;
	}
}
