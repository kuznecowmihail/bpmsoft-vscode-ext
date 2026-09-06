import * as fs from "fs";
import { parseJsonNoBom } from "../textUtils";
import { pMap } from "./concurrency";

/**
 * Cross-activation cache for `NamingIssuesIndex.refresh()` — unlike
 * `ModuleIndexer` (which already caches its platform/owned-schema files, see
 * `platformIndexCache.ts`/`ownedSchemaCache.ts`), the naming scan previously
 * had no cache at all: every activation re-read and re-checked every
 * descriptor.json/.cs/SqlScripts/Data file under `Pkg` from scratch, even
 * when nothing had changed since the last run. This mirrors
 * `ownedSchemaCache.ts`'s per-item granularity (editing one schema must not
 * invalidate the cached result of every other one) but keys freshness on
 * each dependency file's own `(size, mtimeMs)` — via `fs.stat`, not a
 * `ModifiedOnUtc` JSON field — because two of the four categories cached
 * here (`SqlScripts/`, `Data/`) have no equivalent of `extension.ts`'s
 * `touchSchemaModifiedOnUtc` keeping such a field current, and a plain file
 * stamp works uniformly across all four without needing one.
 */

export interface FileStamp {
	size: number;
	mtimeMs: number;
}

/** One entry per file a cached result actually depends on. `null` records
 * "confirmed absent at write time" — so a file *appearing* later (e.g. a
 * `resource.en-US.xml` added where there was none) is a recorded change,
 * not something silently missed because it was never in the map to begin
 * with. */
export type StampMap = Record<string, FileStamp | null>;

export interface CachedPosition {
	line: number;
	character: number;
}

export interface CachedFinding {
	packageName: string;
	label: string;
	message: string;
	filePath: string;
	position: CachedPosition;
}

export interface CachedEntityOccurrence {
	name: string;
	filePath: string;
	isSubstitution: boolean;
}

export interface CachedSysSettingsOccurrence {
	code: string;
	filePath: string;
	rowId: string | undefined;
}

export interface CachedSysSettingsValueOccurrence {
	code: string;
	filePath: string;
	referencedSysSettingsId: string | undefined;
}

export interface SchemaDescriptorEntry {
	stamps: StampMap;
	findings: CachedFinding[];
	entityOccurrence?: CachedEntityOccurrence;
}

export interface CsharpFileEntry {
	stamps: StampMap;
	findings: CachedFinding[];
}

export interface SqlScriptEntry {
	stamps: StampMap;
	/** Naming-pattern findings only — the `_Temp` age-based finding is
	 * time-dependent (can newly cross `sqlTempScriptMaxAgeDays` with no file
	 * changing at all) and is always recomputed fresh in `scanWorkspace`,
	 * never stored here. */
	findings: CachedFinding[];
}

export interface DataDescriptorEntry {
	stamps: StampMap;
	findings: CachedFinding[];
	sysSettingsOccurrence?: CachedSysSettingsOccurrence;
	sysSettingsValueOccurrence?: CachedSysSettingsValueOccurrence;
}

export interface NamingIssuesCacheData {
	schemaDescriptors: Record<string, SchemaDescriptorEntry>;
	csharpFiles: Record<string, CsharpFileEntry>;
	sqlScripts: Record<string, SqlScriptEntry>;
	dataDescriptors: Record<string, DataDescriptorEntry>;
}

interface NamingIssuesCacheFile extends NamingIssuesCacheData {
	extensionVersion: string;
	/** A finding's verdict depends on more than the file it's read from — it
	 * also depends on whatever `bpmsoft.*Naming*` settings were in effect
	 * (prefixes, singular/boolean/date-suffix vocab, role-suffix checks,
	 * …). File stamps alone can't detect a *setting* changing (the file
	 * itself never touched), so the caller folds every such setting into one
	 * fingerprint string and passes it here too — a mismatch invalidates the
	 * whole cache the same way an extension-version mismatch does, forcing
	 * one full re-scan (which then writes a fresh cache under the new
	 * fingerprint, valid again until settings change again). */
	settingsFingerprint: string;
}

export function emptyNamingIssuesCache(): NamingIssuesCacheData {
	return { schemaDescriptors: {}, csharpFiles: {}, sqlScripts: {}, dataDescriptors: {} };
}

/** `undefined` on any read/parse failure, extension-version mismatch, or
 * `settingsFingerprint` mismatch — the caller then treats every item as a
 * fresh check, same as no cache file existing at all (a cache is a pure
 * optimization, never allowed to fail the scan it's speeding up). */
export function loadNamingIssuesCache(
	cacheFilePath: string,
	extensionVersion: string,
	settingsFingerprint: string
): NamingIssuesCacheData | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(cacheFilePath, "utf8");
	} catch {
		return undefined;
	}
	const cache = parseJsonNoBom<NamingIssuesCacheFile>(raw);
	if (!cache || cache.extensionVersion !== extensionVersion || cache.settingsFingerprint !== settingsFingerprint) {
		return undefined;
	}
	return {
		schemaDescriptors: cache.schemaDescriptors || {},
		csharpFiles: cache.csharpFiles || {},
		sqlScripts: cache.sqlScripts || {},
		dataDescriptors: cache.dataDescriptors || {}
	};
}

export function saveNamingIssuesCache(
	cacheFilePath: string,
	extensionVersion: string,
	settingsFingerprint: string,
	data: NamingIssuesCacheData
): void {
	try {
		const cache: NamingIssuesCacheFile = { extensionVersion, settingsFingerprint, ...data };
		fs.writeFileSync(cacheFilePath, JSON.stringify(cache));
	} catch {
		// best-effort — see platformIndexCache.ts's own doc for the same trade-off
	}
}

async function statOne(filePath: string): Promise<FileStamp | null> {
	try {
		const stat = await fs.promises.stat(filePath);
		return { size: stat.size, mtimeMs: stat.mtimeMs };
	} catch {
		return null;
	}
}

/** Stamps every path in `paths` (pooled — see `concurrency.ts`'s own doc).
 * `fs.stat` reads metadata only, so unlike `fs.readFile` it isn't subject to
 * the antivirus-scan-on-open latency that motivated pooling content reads in
 * the first place — pooling here is mainly about not serializing dozens of
 * small syscalls per item one at a time. */
export async function buildStamps(paths: string[]): Promise<StampMap> {
	const stamps: StampMap = {};
	const results = await pMap(paths, async (p) => ({ path: p, stamp: await statOne(p) }));
	for (const { path: p, stamp } of results) {
		stamps[p] = stamp;
	}
	return stamps;
}

function stampEqual(a: FileStamp | null, b: FileStamp | null): boolean {
	if (a === null || b === null) {
		return a === b;
	}
	return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Whether `fresh` (just stat'd off disk) matches `cached` (recorded on a
 * previous run) exactly — same set of paths, same size/mtime for each. A
 * path present in one but not the other counts as a mismatch, same as a
 * changed size/mtime — this is what lets a newly created/deleted dependency
 * file (e.g. a `resource.en-US.xml` added where none existed) invalidate a
 * cache entry even though the entry's own primary file (e.g.
 * descriptor.json) never changed: `fresh`'s dependency list is always
 * rebuilt from a live directory listing (see call sites in
 * `NamingIssuesIndex.ts`), not copied from what the cache expects. */
export function stampsMatch(cached: StampMap, fresh: StampMap): boolean {
	const cachedKeys = Object.keys(cached);
	const freshKeys = Object.keys(fresh);
	if (cachedKeys.length !== freshKeys.length) {
		return false;
	}
	for (const key of cachedKeys) {
		if (!(key in fresh) || !stampEqual(cached[key], fresh[key])) {
			return false;
		}
	}
	return true;
}
