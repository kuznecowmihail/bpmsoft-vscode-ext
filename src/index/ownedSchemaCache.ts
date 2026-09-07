import * as fs from "fs";
import { IndexedModule } from "../parse/types";
import { parseJsonNoBom } from "../textUtils";

/**
 * Cross-activation cache for `Pkg/{OwnedPackage}/Schemas/**\/*.js` — unlike
 * `platformIndexCache.ts`'s single fingerprint over a whole block of files
 * (right for `Resources/ui/BPMSoft`/`conf/content`, which only ever change
 * together, on a platform upgrade), an owned schema changes on its own —
 * editing one shouldn't invalidate the cached parse of every other one. Each
 * schema gets its own entry, keyed by its own file path, valid as long as
 * its descriptor.json's own `ModifiedOnUtc` (see
 * `parseDescriptorModifiedOnUtc`) hasn't changed since the entry was
 * written.
 */
export interface OwnedSchemaCacheEntry {
	modifiedOnUtc: string;
	module: IndexedModule;
}

interface OwnedSchemaCacheFile {
	extensionVersion: string;
	entries: Record<string, OwnedSchemaCacheEntry>;
}

/** `undefined` on any read/parse failure, or an extension-version mismatch
 * (see `platformIndexCache.ts`'s own doc for why that's checked) — the
 * caller then just treats every schema as a fresh parse, same as no cache
 * file existing at all. */
export function loadOwnedSchemaCache(
	cacheFilePath: string,
	extensionVersion: string
): Record<string, OwnedSchemaCacheEntry> | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(cacheFilePath, "utf8");
	} catch {
		return undefined;
	}
	const cache = parseJsonNoBom<OwnedSchemaCacheFile>(raw);
	if (!cache || cache.extensionVersion !== extensionVersion || !cache.entries || typeof cache.entries !== "object") {
		return undefined;
	}
	return cache.entries;
}

/** Best-effort write — see `platformIndexCache.ts`'s own doc, same
 * reasoning (a cache is a pure optimization, never allowed to fail the
 * indexing it's speeding up). */
export function saveOwnedSchemaCache(
	cacheFilePath: string,
	extensionVersion: string,
	entries: Record<string, OwnedSchemaCacheEntry>
): void {
	try {
		const cache: OwnedSchemaCacheFile = { extensionVersion, entries };
		fs.writeFileSync(cacheFilePath, JSON.stringify(cache));
	} catch {
		// best-effort — see doc comment
	}
}
