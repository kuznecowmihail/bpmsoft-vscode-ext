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

export interface LocalizedImage {
	culture: string;
	mimeType: string;
	base64: string;
}

interface ResourceItem {
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

const MIME_BY_EXTENSION: Record<string, string> = {
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

/** BPMSoft's own resource XML is flat enough (`<Item Name="..." Value="..." />`,
 * optionally with `Type`/`ContentType`/`FileExtension` on an image item) that
 * a real XML parser is unnecessary — a per-tag attribute scan, same
 * lightweight-parsing spirit as this codebase's other analyzers. Attribute
 * order isn't assumed. */
function parseResourceItems(xml: string): Map<string, ResourceItem> {
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

/**
 * Resolves a `Resources.Images.<key>` (JS) reference to the actual image
 * bytes, across every culture the schema's own resource files carry.
 *
 * Unlike strings, an image's *name* and its actual data live under two
 * different, GUID-linked XML items - `Images.<guid>.Caption` (the
 * human-typed name shown in the Designer's image picker, which is what
 * `key` actually is) and `Images.<guid>.Image` (the real
 * `Type="Image" ContentType="Data" FileExtension=".svg" Value="<base64>"`
 * payload) - confirmed against real schemas. There is no static mapping
 * from an arbitrary JS binding key straight to a GUID (that link only
 * exists in the platform's own image registry at runtime), so this only
 * resolves when the Caption happens to equal `key` exactly - which real
 * code does hit (`AnRefreshDataButtonIcon`, `MenuItemSelectedIcon`, ...),
 * but far from always: plenty of images are captioned differently than
 * however their key was later named in code, or aren't captioned at all,
 * or come from a base/stock schema whose resources aren't reachable this
 * way at all. No match here means exactly that - not "this image doesn't
 * exist," just "can't be found from static files alone." */
export function resolveLocalizedImage(
	schemaDir: string,
	schemaName: string,
	key: string
): LocalizedImage[] | undefined {
	const images: LocalizedImage[] = [];
	for (const { culture, items } of eachCultureFile(schemaDir, schemaName)) {
		let guid: string | undefined;
		for (const [name, item] of items) {
			if (item.value !== key) {
				continue;
			}
			const m = /^Images\.([0-9a-fA-F-]+)\.Caption$/.exec(name);
			if (m) {
				guid = m[1];
				break;
			}
		}
		if (!guid) {
			continue;
		}
		const imageItem = items.get(`Images.${guid}.Image`);
		if (
			!imageItem ||
			imageItem.contentType !== "Data" ||
			!imageItem.fileExtension ||
			imageItem.value.length > MAX_IMAGE_BASE64_LENGTH
		) {
			continue;
		}
		const mimeType = MIME_BY_EXTENSION[imageItem.fileExtension.toLowerCase()];
		if (!mimeType) {
			continue;
		}
		images.push({ culture, mimeType, base64: imageItem.value });
	}
	return images.length ? images : undefined;
}
