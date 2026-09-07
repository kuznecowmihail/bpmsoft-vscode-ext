import * as fs from "fs";
import * as path from "path";
import { findResourceDirs } from "./schemaResourceLookup";
import { stripBom, parseJsonNoBom } from "../textUtils";
import { isBoxedPackage } from "./packageOwnershipCheck";

/** RU/EN shown first regardless of file order — the team's own language
 * plus the platform default; any other culture found still shows, just
 * after these two. */
export const PREFERRED_CULTURE_ORDER = ["ru-RU", "en-US"];

export interface LocalizedCultureValue {
	culture: string;
	value: string;
}

export interface LocalizedString {
	key: string;
	values: LocalizedCultureValue[];
}

export interface LocalizedImage {
	culture: string;
	mimeType: string;
	base64: string;
}

export interface ResourceItem {
	value: string;
	type?: string;
	contentType?: string;
	fileExtension?: string;
}

interface ResourceFileCache {
	mtimeMs: number;
	items: Map<string, ResourceItem>;
}

const fileCache = new Map<string, ResourceFileCache>();

/** A base64 image blob this large (before decoding) is almost certainly not
 * a UI icon someone wants inline in a hover tooltip — a defensive cap, not
 * a real limit seen in practice (every real icon sampled was a few KB). */
const MAX_IMAGE_BASE64_LENGTH = 500_000;

export const MIME_BY_EXTENSION: Record<string, string> = {
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".ico": "image/x-icon"
};

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

/** Inverse of `unescapeXmlAttr` — `&` first, same as every real XML
 * serializer, so a value that already contains `&amp;` doesn't get
 * double-escaped into `&amp;amp;`. Exported for `localizationEditor.ts`,
 * which writes `<Item .../>` attribute values back into these same files. */
export function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** BPMSoft's own resource XML is flat enough (`<Item Name="..." Value="..." />`,
 * optionally with `Type`/`ContentType`/`FileExtension` on an image item) that
 * a real XML parser is unnecessary — a per-tag attribute scan, same
 * lightweight-parsing spirit as this codebase's other analyzers. Attribute
 * order isn't assumed. */
export function parseResourceItems(xml: string): Map<string, ResourceItem> {
	const items = new Map<string, ResourceItem>();
	const itemRe = /<Item\b([^>]*)\/?>/g;
	let m: RegExpExecArray | null;
	while ((m = itemRe.exec(xml))) {
		const attrs = m[1];
		const name = /\bName="([^"]*)"/.exec(attrs)?.[1];
		const value = /\bValue="([^"]*)"/.exec(attrs)?.[1];
		if (name === undefined || value === undefined) {
			continue;
		}
		items.set(unescapeXmlAttr(name), {
			value: unescapeXmlAttr(value),
			type: /\bType="([^"]*)"/.exec(attrs)?.[1],
			contentType: /\bContentType="([^"]*)"/.exec(attrs)?.[1],
			fileExtension: /\bFileExtension="([^"]*)"/.exec(attrs)?.[1]
		});
	}
	return items;
}

/** Re-parses only when the file's own mtime changes — hover fires often
 * enough (every cursor move) that re-reading+re-parsing every resource file
 * on each call would be wasteful, but this is a cache, not a watcher: an
 * edit made outside this process within the same mtime tick (rare) would be
 * missed until the next real change. */
function readResourceItemsCached(filePath: string): Map<string, ResourceItem> {
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

export interface ResourceCultureFile {
	culture: string;
	filePath: string;
}

/** Every `resource.{culture}.xml` file directly under one of `schemaName`'s
 * own resource dirs — just the culture/path pairs, no parsing. Exported for
 * `localizationEditor.ts`, which needs a real file path to write into (unlike
 * `eachCultureFile` below, built for read-only lookups that only ever need
 * the already-parsed items). Only the *first* matching resource dir is used
 * when `findResourceDirs` returns more than one (a real schema has exactly
 * one in practice) — picking one consistently matters for writes, unlike
 * reads, which can safely merge across all of them. */
export function listSchemaCultures(schemaDir: string, schemaName: string): ResourceCultureFile[] {
	const dirs = findResourceDirs(schemaDir, schemaName);
	const dir = dirs[0];
	if (!dir) {
		return [];
	}
	const out: ResourceCultureFile[] = [];
	for (const entry of readDirSafe(dir)) {
		if (!entry.isFile()) {
			continue;
		}
		const m = /^resource\.([a-zA-Z]+(?:-[a-zA-Z]+)?)\.xml$/i.exec(entry.name);
		if (m) {
			out.push({ culture: m[1], filePath: path.join(dir, entry.name) });
		}
	}
	return out;
}

/** Every `resource.{culture}.xml` file directly under one of `schemaName`'s
 * own resource dirs, paired with its already-cached parsed items. */
function eachCultureFile(
	schemaDir: string,
	schemaName: string
): { culture: string; items: Map<string, ResourceItem> }[] {
	const out: { culture: string; items: Map<string, ResourceItem> }[] = [];
	for (const dir of findResourceDirs(schemaDir, schemaName)) {
		for (const entry of readDirSafe(dir)) {
			if (!entry.isFile()) {
				continue;
			}
			const m = /^resource\.([a-zA-Z]+(?:-[a-zA-Z]+)?)\.xml$/i.exec(entry.name);
			if (!m) {
				continue;
			}
			out.push({ culture: m[1], items: readResourceItemsCached(path.join(dir, entry.name)) });
		}
	}
	return out;
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
	const wantedName = `LocalizableStrings.${key}.Value`;
	const values: LocalizedCultureValue[] = [];
	for (const { culture, items } of eachCultureFile(schemaDir, schemaName)) {
		const item = items.get(wantedName);
		if (item !== undefined) {
			values.push({ culture, value: item.value });
		}
	}
	if (!values.length) {
		return undefined;
	}
	values.sort((a, b) => cultureRank(a.culture) - cultureRank(b.culture));
	return { key, values };
}

export interface MetadataNameRegistration {
	uid: string;
	name: string;
}

/** Balanced-brace slice starting at `source[braceStart]` (which must be
 * `{`), string/escape-aware so a `}` inside a quoted value (or an escaped
 * quote) doesn't end the match early. Same approach as `entityMetadata.ts`'s
 * own private `sliceJsonObject` (not exported there, so this is a from-first-
 * principles rewrite rather than a cross-file reach for a ~15-line helper).
 * `undefined` if the braces never balance before the string ends. */
function sliceBalancedBraces(source: string, braceStart: number): string | undefined {
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = braceStart; i < source.length; i++) {
		const ch = source[i];
		if (inString) {
			if (escape) {
				escape = false;
			} else if (ch === "\\") {
				escape = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
		} else if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) {
				return source.slice(braceStart, i + 1);
			}
		}
	}
	return undefined;
}

/** Every `{UId, A2, ...}` record under `MetaData.Schema.{recordKey}` in a
 * schema's own `metadata.json` — the shared shape behind both the string
 * name→key registry (`recordKey: "B2"`) and the image name→key registry
 * (`recordKey: "HD8"`), across *both* real on-disk formats:
 *
 * - Full JSON (a root schema with no parent — confirmed real, e.g.
 *   `GoTicketRowItem`'s own `metadata.json`): `MetaData.Schema.{recordKey}`
 *   is a plain JSON array, so a straight `JSON.parse` + array walk suffices
 *   (same shape `processElementsMetadata.ts` already walks for a Process
 *   schema's own array-valued `MetaData.Schema` keys).
 * - Diff-DSL (a schema with a parent — confirmed real, e.g. `AccountPageV2`):
 *   each record is its own `+ MetaData.Schema.{recordKey} { ... }` line
 *   block; a `~ MetaData.Schema.{recordKey} [...]` aggregate-tracking line
 *   (a plain array of UIds, not object records) also exists but is skipped
 *   automatically here by requiring an actual `{` right after the marker,
 *   not `[`.
 *
 * Read-only by design — see `localizationEditor.ts`'s module doc for why
 * this feature deliberately never *writes* to either metadata.json shape. */
export function parseMetadataNameRegistrations(
	schemaDir: string,
	recordKey: "B2" | "HD8"
): MetadataNameRegistration[] {
	let text: string;
	try {
		text = stripBom(fs.readFileSync(path.join(schemaDir, "metadata.json"), "utf8"));
	} catch {
		return [];
	}

	const asJson = parseJsonNoBom<{ MetaData?: { Schema?: Record<string, unknown> } }>(text);
	if (asJson) {
		const arr = asJson.MetaData?.Schema?.[recordKey];
		if (!Array.isArray(arr)) {
			return [];
		}
		const out: MetadataNameRegistration[] = [];
		for (const item of arr) {
			if (item && typeof item === "object" && typeof item.UId === "string" && typeof item.A2 === "string") {
				out.push({ uid: item.UId, name: item.A2 });
			}
		}
		return out;
	}

	// Diff-DSL fallback.
	const out: MetadataNameRegistration[] = [];
	const marker = `MetaData.Schema.${recordKey}`;
	let searchFrom = 0;
	while (true) {
		const markerIdx = text.indexOf(marker, searchFrom);
		if (markerIdx < 0) {
			break;
		}
		let i = markerIdx + marker.length;
		while (text[i] === " " || text[i] === "\t") {
			i++;
		}
		if (text[i] !== "{") {
			searchFrom = markerIdx + marker.length;
			continue;
		}
		const block = sliceBalancedBraces(text, i);
		searchFrom = block ? i + block.length : markerIdx + marker.length;
		if (!block) {
			continue;
		}
		try {
			const obj = JSON.parse(block);
			if (obj && typeof obj.UId === "string" && typeof obj.A2 === "string") {
				out.push({ uid: obj.UId, name: obj.A2 });
			}
		} catch {
			// Malformed/unexpected block shape - skip, keep scanning.
		}
	}
	return out;
}

/** Finds `key` as an `A2` field among the schema's own `HD8` registrations
 * (see `parseMetadataNameRegistrations`) and returns that entry's own `UId`
 * — the real image GUID. This is the Designer's actual name→image
 * registration record (confirmed directly against a real example: BasePageV2's
 * own HD8 entry for "AnRefreshDataButtonIcon" carries `UId: "d320e098-..."`,
 * the exact same GUID its `Images.<guid>.Image` item uses) — a more reliable
 * source than the resource XML's own optional `Images.<guid>.Caption` (plenty
 * of real images have no Caption at all, `metadata.json`'s HD8 still names
 * them). */
function findImageGuidInMetadata(schemaDir: string, key: string): string | undefined {
	return parseMetadataNameRegistrations(schemaDir, "HD8").find((r) => r.name === key)?.uid;
}

/** Fallback for when `metadata.json` has no HD8 record for `key` (real
 * gap - some schemas reference an image purely by string key with nothing
 * registered locally at all): the resource XML's own optional
 * `Images.<guid>.Caption` item, when its value happens to equal `key`
 * exactly. See `resolveLocalizedImage`'s own doc for why this is
 * intentionally exact, not fuzzy. */
function findImageGuidByCaption(schemaDir: string, schemaName: string, key: string): string | undefined {
	for (const { items } of eachCultureFile(schemaDir, schemaName)) {
		for (const [name, item] of items) {
			if (item.value !== key) {
				continue;
			}
			const m = /^Images\.([0-9a-fA-F-]+)\.Caption$/.exec(name);
			if (m) {
				return m[1];
			}
		}
	}
	return undefined;
}

function imagesFromItems(
	items: Map<string, ResourceItem>,
	culture: string,
	guid: string
): LocalizedImage | undefined {
	const imageItem = items.get(`Images.${guid}.Image`);
	if (
		!imageItem ||
		imageItem.contentType !== "Data" ||
		!imageItem.fileExtension ||
		imageItem.value.length > MAX_IMAGE_BASE64_LENGTH
	) {
		return undefined;
	}
	const mimeType = MIME_BY_EXTENSION[imageItem.fileExtension.toLowerCase()];
	return mimeType ? { culture, mimeType, base64: imageItem.value } : undefined;
}

interface GuidIndexCache {
	pkgRoot: string;
	byGuid: Map<string, { culture: string; items: Map<string, ResourceItem> }[]>;
}

let guidIndexCache: GuidIndexCache | undefined;

/** Every `Images.<guid>.Image` this GUID resolves to, across *every owned
 * package's* resource files — not just the current schema's own. Real,
 * confirmed necessity: a schema's own `metadata.json` can carry an HD8
 * record for an image whose actual bytes were never copied into that
 * schema's own resource XML at all (only into some unrelated schema's,
 * likely from how the Designer/base-page-template duplicates a "common"
 * icon set across many independently-authored pages) — e.g. `CasePage`
 * references the exact same "AnRefreshDataButtonIcon" GUID as `BasePageV2`,
 * but only `BasePageV2`'s own resource file actually has that GUID's image
 * data; that same GUID turns out to be duplicated across ~40 different
 * schemas platform-wide in one real install. A GUID match is unambiguous
 * (it's a real UUID) regardless of which package physically stores the
 * bytes, so searching every owned package for it is safe, just not free —
 * built lazily on first need and cached for the process's lifetime (nothing
 * here is expected to change without a full extension reload / manual
 * "Rebuild Index", which calls `resetLocalizationCaches`). Boxed packages
 * are skipped, same as everywhere else this session's indexing work
 * scoped to owned content — their resources aren't meant to be edited and,
 * more to the point here, a boxed package rarely even has file-level
 * Resources at all. */
function guidIndexForPkgRoot(pkgRoot: string): Map<string, { culture: string; items: Map<string, ResourceItem> }[]> {
	if (guidIndexCache?.pkgRoot === pkgRoot) {
		return guidIndexCache.byGuid;
	}
	const byGuid = new Map<string, { culture: string; items: Map<string, ResourceItem> }[]>();
	let packageDirs: fs.Dirent[];
	try {
		packageDirs = fs.readdirSync(pkgRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
	} catch {
		packageDirs = [];
	}
	for (const pkgEntry of packageDirs) {
		const pkgDir = path.join(pkgRoot, pkgEntry.name);
		if (isBoxedPackage(pkgDir)) {
			continue;
		}
		const resourcesRoot = path.join(pkgDir, "Resources");
		for (const resDirEntry of readDirSafe(resourcesRoot)) {
			if (!resDirEntry.isDirectory()) {
				continue;
			}
			const resDir = path.join(resourcesRoot, resDirEntry.name);
			for (const fileEntry of readDirSafe(resDir)) {
				const m = /^resource\.([a-zA-Z]+(?:-[a-zA-Z]+)?)\.xml$/i.exec(fileEntry.name);
				if (!fileEntry.isFile() || !m) {
					continue;
				}
				const items = readResourceItemsCached(path.join(resDir, fileEntry.name));
				for (const [name, item] of items) {
					if (item.contentType !== "Data") {
						continue;
					}
					const imgMatch = /^Images\.([0-9a-fA-F-]+)\.Image$/.exec(name);
					if (!imgMatch) {
						continue;
					}
					const list = byGuid.get(imgMatch[1]) ?? [];
					list.push({ culture: m[1], items });
					byGuid.set(imgMatch[1], list);
				}
			}
		}
	}
	guidIndexCache = { pkgRoot, byGuid };
	return byGuid;
}

/** Clears both this module's per-file resource cache and the (expensive to
 * build) global GUID index — call whenever a full re-index is requested
 * (the "Rebuild Index" command), so stale entries from before a change
 * don't linger for the rest of the session. */
export function resetLocalizationCaches(): void {
	fileCache.clear();
	guidIndexCache = undefined;
}

/**
 * Resolves a `Resources.Images.<key>` (JS) reference to the actual image
 * bytes. The name→GUID link is found via the schema's own `metadata.json`
 * (`findImageGuidInMetadata`, the reliable source — see its doc) or, failing
 * that, the resource XML's own optional `Caption` item
 * (`findImageGuidByCaption`). Once the GUID is known, the actual
 * `Images.<guid>.Image` payload is looked up first in the current schema's
 * own resources, then across every other owned package's resources (see
 * `guidIndexForPkgRoot` for why that second step is real and necessary,
 * not paranoia). No match at any stage means exactly that — not "this
 * image doesn't exist," just "can't be found from static files alone"
 * (e.g. a genuinely boxed/stock-only image with no local registration
 * anywhere reachable). */
export function resolveLocalizedImage(
	schemaDir: string,
	schemaName: string,
	key: string
): LocalizedImage[] | undefined {
	const guid = findImageGuidInMetadata(schemaDir, key) ?? findImageGuidByCaption(schemaDir, schemaName, key);
	if (!guid) {
		return undefined;
	}
	const ownFiles = eachCultureFile(schemaDir, schemaName);
	const ownImages = ownFiles
		.map(({ culture, items }) => imagesFromItems(items, culture, guid))
		.filter((img): img is LocalizedImage => img !== undefined);
	if (ownImages.length) {
		return ownImages;
	}
	const pkgRoot = path.dirname(path.dirname(path.dirname(schemaDir)));
	const candidates = guidIndexForPkgRoot(pkgRoot).get(guid);
	if (!candidates?.length) {
		return undefined;
	}
	const images = candidates
		.map(({ culture, items }) => imagesFromItems(items, culture, guid))
		.filter((img): img is LocalizedImage => img !== undefined);
	return images.length ? images : undefined;
}
