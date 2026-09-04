import * as fs from "fs";
import * as path from "path";
import { findResourceDirs } from "./schemaResourceLookup";
import { stripBom } from "../textUtils";

/** RU/EN shown first regardless of file order — the team's own language
 * plus the platform default; any other culture found still shows, just
 * after these two. */
const PREFERRED_CULTURE_ORDER = ["ru-RU", "en-US"];

export interface LocalizedCultureValue {
	culture: string;
	value: string;
}

export interface LocalizedString {
	key: string;
	values: LocalizedCultureValue[];
}

interface ResourceFileCache {
	mtimeMs: number;
	items: Map<string, string>;
}

const fileCache = new Map<string, ResourceFileCache>();

function readDirSafe(dirPath: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dirPath, { withFileTypes: true });
	} catch {
		return [];
	}
}

function unescapeXmlAttr(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/** BPMSoft's own resource XML is flat enough (`<Item Name="..." Value="..." />`
 * per line, no nesting to speak of) that a real XML parser is unnecessary —
 * a per-tag attribute scan, same lightweight-parsing spirit as this
 * codebase's other analyzers. Attribute order isn't assumed. */
function parseResourceItems(xml: string): Map<string, string> {
	const items = new Map<string, string>();
	const itemRe = /<Item\b([^>]*)\/?>/g;
	let m: RegExpExecArray | null;
	while ((m = itemRe.exec(xml))) {
		const attrs = m[1];
		const name = /\bName="([^"]*)"/.exec(attrs)?.[1];
		const value = /\bValue="([^"]*)"/.exec(attrs)?.[1];
		if (name === undefined || value === undefined) {
			continue;
		}
		items.set(unescapeXmlAttr(name), unescapeXmlAttr(value));
	}
	return items;
}

/** Re-parses only when the file's own mtime changes — hover fires often
 * enough (every cursor move) that re-reading+re-parsing every resource file
 * on each call would be wasteful, but this is a cache, not a watcher: an
 * edit made outside this process within the same mtime tick (rare) would be
 * missed until the next real change. */
function readResourceItemsCached(filePath: string): Map<string, string> {
	let mtimeMs: number;
	try {
		mtimeMs = fs.statSync(filePath).mtimeMs;
	} catch {
		return new Map();
	}
	const cached = fileCache.get(filePath);
	if (cached && cached.mtimeMs === mtimeMs) {
		return cached.items;
	}
	let text: string;
	try {
		text = stripBom(fs.readFileSync(filePath, "utf8"));
	} catch {
		return new Map();
	}
	const items = parseResourceItems(text);
	fileCache.set(filePath, { mtimeMs, items });
	return items;
}

function cultureRank(culture: string): number {
	const idx = PREFERRED_CULTURE_ORDER.indexOf(culture);
	return idx < 0 ? PREFERRED_CULTURE_ORDER.length : idx;
}

/** Resolves a `Resources.Strings.<key>` (JS) / `"LocalizableStrings.<key>.Value"`
 * (C#) reference to its actual localized text, across every culture the
 * schema's own `Resources/{SchemaName}.{Suffix}/resource.{culture}.xml`
 * files carry — both access paths key the exact same XML `Item
 * Name="LocalizableStrings.{key}.Value"`, confirmed against real schemas
 * (BPMSoft's own client bindTo strings and the platform's `LocalizableString`
 * SDK class agree on this format). `undefined` when the schema has no
 * matching resource dir, or none of its culture files define this key. */
export function resolveLocalizedString(
	schemaDir: string,
	schemaName: string,
	key: string
): LocalizedString | undefined {
	const dirs = findResourceDirs(schemaDir, schemaName);
	if (!dirs.length) {
		return undefined;
	}
	const wantedName = `LocalizableStrings.${key}.Value`;
	const values: LocalizedCultureValue[] = [];
	for (const dir of dirs) {
		for (const entry of readDirSafe(dir)) {
			if (!entry.isFile()) {
				continue;
			}
			const m = /^resource\.([a-zA-Z]+(?:-[a-zA-Z]+)?)\.xml$/i.exec(entry.name);
			if (!m) {
				continue;
			}
			const value = readResourceItemsCached(path.join(dir, entry.name)).get(wantedName);
			if (value !== undefined) {
				values.push({ culture: m[1], value });
			}
		}
	}
	if (!values.length) {
		return undefined;
	}
	values.sort((a, b) => cultureRank(a.culture) - cultureRank(b.culture));
	return { key, values };
}
