/**
 * Write-side counterpart to `localizationLookup.ts` — discovers and edits a
 * schema's own localizable strings (C# and JS schemas) and localizable
 * images (JS schemas only), for the two wizard webviews
 * (`LocalizationWizardPanel.ts`).
 *
 * **Deliberately never writes `metadata.json`, in either of its two real
 * on-disk shapes** (full JSON for a root schema, the line-oriented diff-DSL
 * for one with a parent — see `parseMetadataNameRegistrations` in
 * `localizationLookup.ts`). Two independent, confirmed-real facts justify
 * this:
 *   1. A `B2` (string) or `HD8` (image) metadata record is never required
 *      for a key to resolve at runtime — `resolveLocalizedString` doesn't
 *      consult metadata.json at all, and real shipped code
 *      (`GoActivityEmailMessagePublisher.cs`) calls
 *      `GetLocalizableStringValue(..., "NoRecepientError")` for a key with
 *      zero `B2` entries anywhere in its own (full-JSON) metadata.json.
 *   2. `resolveLocalizedImage` already has a documented, working fallback
 *      for an image with no metadata registration at all: an
 *      `Images.<guid>.Caption` item whose value equals the key. Writing that
 *      Caption item (done here for every new image) is enough to make a new
 *      key resolve, with none of the risk of hand-constructing a diff-DSL
 *      `+`/`~` block pair whose full semantics (the aggregate `~` tracking
 *      array in particular) aren't fully reverse-engineered.
 *
 * The trade-off (documented to the user, not hidden): a key added here won't
 * show up if this schema is later opened in the real BPMSoft Designer's own
 * translation-management UI, only at runtime and in this extension's own
 * wizard. Renaming an image whose *current* name came from an `HD8`
 * metadata record has the same limitation - see `canRenameImage` below.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { readFileSafe, escapeRegExp } from "../fsUtils";
import { parseJsonNoBom } from "../textUtils";
import {
	ResourceCultureFile,
	listSchemaCultures,
	parseResourceItems,
	parseMetadataNameRegistrations,
	escapeXmlAttr,
	resetLocalizationCaches,
	MIME_BY_EXTENSION
} from "./localizationLookup";

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface EditResult {
	ok: boolean;
	error?: string;
}

export interface LocalizedStringRow {
	key: string;
	/** culture -> value; a culture with no resource item for this key simply
	 * has no entry (shown blank in the wizard, not written until edited). */
	values: Record<string, string>;
}

export interface LocalizedImageValue {
	mimeType: string;
	base64: string;
	fileExtension: string;
}

export interface LocalizedImageRow {
	guid: string;
	name: string;
	/** `false` when `name` came from an `HD8` metadata.json registration —
	 * renaming would only be able to *add* a Caption item under the new
	 * name (metadata.json is never rewritten), leaving the old name still
	 * resolving via metadata and, worse, still winning the *display* name in
	 * this very list — so the rename control is disabled for these instead
	 * of silently doing something that looks like it failed. */
	canRename: boolean;
	values: Record<string, LocalizedImageValue>;
}

function keyValidationError(key: string): string | undefined {
	if (!key.trim()) {
		return "Ключ не может быть пустым";
	}
	if (!KEY_RE.test(key)) {
		return "Ключ должен начинаться с буквы и содержать только латинские буквы, цифры и подчёркивание";
	}
	return undefined;
}

function readDescriptorManagerName(schemaDir: string): string | undefined {
	const text = readFileSafe(path.join(schemaDir, "descriptor.json"));
	if (!text) {
		return undefined;
	}
	const json = parseJsonNoBom<{ ManagerName?: string }>(text);
	return json?.ManagerName;
}

/** `{ManagerName}` minus its trailing `SchemaManager` — confirmed exhaustive
 * across every schema type sampled in two real installs (`ClientUnit`,
 * `Entity`, `SourceCode`, `Process`, `ProcessUserTask`, `Service`, `Dcm`).
 * Falls back to `"ClientUnit"` (the common case for a hand-authored page) if
 * `descriptor.json` can't be read at all — bootstrap only ever runs for a
 * schema with zero existing localization, which is rare enough that a
 * best-effort fallback is fine here. */
function resourceFolderSuffix(schemaDir: string): string {
	const managerName = readDescriptorManagerName(schemaDir);
	if (managerName?.endsWith("SchemaManager")) {
		return managerName.slice(0, -"SchemaManager".length);
	}
	return "ClientUnit";
}

const SKELETON_RESOURCE_XML = (culture: string): string =>
	`<?xml version="1.0" encoding="utf-8"?>\n<Resources Culture="${culture}">\n\t<Group Type="String">\n\t\t<Items>\n\t\t</Items>\n\t</Group>\n</Resources>`;

/** Creates `Resources/{schemaName}.{suffix}/resource.{culture}.xml` for
 * every culture in `cultures` from a minimal empty-items skeleton — only
 * used when a schema has *no* resource dir yet at all (a brand new
 * hand-authored schema that has never had a caption/icon set through the
 * Designer). Returns the freshly created culture files, same shape
 * `listSchemaCultures` returns. */
function bootstrapResourceDir(
	schemaDir: string,
	schemaName: string,
	cultures: string[]
): ResourceCultureFile[] {
	const packageRoot = path.dirname(path.dirname(schemaDir));
	const dir = path.join(packageRoot, "Resources", `${schemaName}.${resourceFolderSuffix(schemaDir)}`);
	fs.mkdirSync(dir, { recursive: true });
	const out: ResourceCultureFile[] = [];
	for (const culture of cultures) {
		const filePath = path.join(dir, `resource.${culture}.xml`);
		if (!fs.existsSync(filePath)) {
			fs.writeFileSync(filePath, SKELETON_RESOURCE_XML(culture), "utf8");
		}
		out.push({ culture, filePath });
	}
	return out;
}

function culturesOrBootstrap(schemaDir: string, schemaName: string): ResourceCultureFile[] {
	const existing = listSchemaCultures(schemaDir, schemaName);
	return existing.length ? existing : bootstrapResourceDir(schemaDir, schemaName, ["ru-RU", "en-US"]);
}

// ---------------------------------------------------------------------------
// Resource-XML item surgery — targeted line insert/update/delete, never a
// full XML re-parse+reserialize (matches this codebase's established
// convention, e.g. `extension.ts`'s `touchSchemaModifiedOnUtc`, for keeping
// an edit's real diff to just the lines that actually changed).
// ---------------------------------------------------------------------------

interface ItemAttrs {
	Type?: string;
	ContentType?: string;
	FileExtension?: string;
	Value: string;
}

function buildItemLine(indent: string, itemName: string, attrs: ItemAttrs): string {
	const parts = [`Name="${escapeXmlAttr(itemName)}"`];
	if (attrs.Type !== undefined) {
		parts.push(`Type="${escapeXmlAttr(attrs.Type)}"`);
	}
	if (attrs.ContentType !== undefined) {
		parts.push(`ContentType="${escapeXmlAttr(attrs.ContentType)}"`);
	}
	if (attrs.FileExtension !== undefined) {
		parts.push(`FileExtension="${escapeXmlAttr(attrs.FileExtension)}"`);
	}
	parts.push(`Value="${escapeXmlAttr(attrs.Value)}"`);
	return `${indent}<Item ${parts.join(" ")} />`;
}

/** Inserts a brand-new `<Item Name="itemName" .../>` line at the ordinal-
 * alphabetical position among its siblings (matching the real files' own
 * sort convention), or right before `</Items>` if it sorts last / the block
 * is empty. Always indented to match a real neighboring `<Item>` line where
 * one exists (the line it's inserted *before* when sorting mid-list, or the
 * last one seen when appended at the end) — a hardcoded guess would only be
 * right by coincidence. `undefined` if the file has no `<Items>...</Items>`
 * block at all (shouldn't happen for a real/bootstrapped file). */
function insertItemLine(
	lines: string[],
	itemNameEscaped: string,
	buildLine: (indent: string) => string
): string[] | undefined {
	let itemsCloseIdx = -1;
	let lastItemIndent = "\t\t\t";
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*<\/Items>\s*$/.test(lines[i])) {
			itemsCloseIdx = i;
			break;
		}
		const m = /^(\s*)<Item\s+Name="([^"]*)"/.exec(lines[i]);
		if (m) {
			lastItemIndent = m[1];
			if (m[2] > itemNameEscaped) {
				return [...lines.slice(0, i), buildLine(m[1]), ...lines.slice(i)];
			}
		}
	}
	if (itemsCloseIdx < 0) {
		return undefined;
	}
	return [...lines.slice(0, itemsCloseIdx), buildLine(lastItemIndent), ...lines.slice(itemsCloseIdx)];
}

function splitLines(text: string): { lines: string[]; eol: string; trailingNewline: boolean } {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const trailingNewline = text.endsWith(eol);
	const body = trailingNewline ? text.slice(0, -eol.length) : text;
	return { lines: body.split(eol), eol, trailingNewline };
}

function joinLines(lines: string[], eol: string, trailingNewline: boolean): string {
	return lines.join(eol) + (trailingNewline ? eol : "");
}

/** Updates an existing `<Item Name="itemName" .../>` line in place (attribute
 * order canonicalized to `Type, ContentType, FileExtension, Value`, matching
 * every real sample), or inserts a new one in alphabetical order if absent.
 * Writes the file only if the content actually changed. Returns `false` if
 * the file can't be read or has no recognizable `<Items>` block. */
export function upsertResourceItem(filePath: string, itemName: string, attrs: ItemAttrs): boolean {
	const raw = readFileSafe(filePath);
	if (raw === undefined) {
		return false;
	}
	const hadBom = raw.charCodeAt(0) === 0xfeff;
	const text = hadBom ? raw.slice(1) : raw;
	const { lines, eol, trailingNewline } = splitLines(text);
	const escapedName = escapeXmlAttr(itemName);
	const nameRe = new RegExp(`^(\\s*)<Item\\s+Name="${escapeRegExp(escapedName)}"[^>]*/>\\s*$`);

	let nextLines: string[] | undefined;
	const existingIdx = lines.findIndex((l) => nameRe.test(l));
	if (existingIdx >= 0) {
		const indent = nameRe.exec(lines[existingIdx])?.[1] ?? "";
		const newLine = buildItemLine(indent, itemName, attrs);
		if (lines[existingIdx] === newLine) {
			return true;
		}
		nextLines = [...lines];
		nextLines[existingIdx] = newLine;
	} else {
		nextLines = insertItemLine(lines, escapedName, (indent) => buildItemLine(indent, itemName, attrs));
		if (!nextLines) {
			return false;
		}
	}

	const newText = (hadBom ? "﻿" : "") + joinLines(nextLines, eol, trailingNewline);
	fs.writeFileSync(filePath, newText, "utf8");
	return true;
}

/** Removes an `<Item Name="itemName" .../>` line if present. No-op (returns
 * `true`, nothing to do) if it's already absent. */
export function removeResourceItem(filePath: string, itemName: string): boolean {
	const raw = readFileSafe(filePath);
	if (raw === undefined) {
		return false;
	}
	const hadBom = raw.charCodeAt(0) === 0xfeff;
	const text = hadBom ? raw.slice(1) : raw;
	const { lines, eol, trailingNewline } = splitLines(text);
	const escapedName = escapeXmlAttr(itemName);
	const nameRe = new RegExp(`^\\s*<Item\\s+Name="${escapeRegExp(escapedName)}"[^>]*/>\\s*$`);
	const idx = lines.findIndex((l) => nameRe.test(l));
	if (idx < 0) {
		return true;
	}
	const newText = (hadBom ? "﻿" : "") + joinLines([...lines.slice(0, idx), ...lines.slice(idx + 1)], eol, trailingNewline);
	fs.writeFileSync(filePath, newText, "utf8");
	return true;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const STRING_ITEM_RE = /^LocalizableStrings\.(.+)\.Value$/;
const IMAGE_ITEM_RE = /^Images\.([0-9a-fA-F-]+)\.Image$/;
const CAPTION_ITEM_RE = /^Images\.([0-9a-fA-F-]+)\.Caption$/;

export function listLocalizedStrings(schemaDir: string, schemaName: string): LocalizedStringRow[] {
	const byKey = new Map<string, Record<string, string>>();
	for (const { culture, filePath } of listSchemaCultures(schemaDir, schemaName)) {
		const text = readFileSafe(filePath);
		if (text === undefined) {
			continue;
		}
		for (const [name, item] of parseResourceItems(text)) {
			const m = STRING_ITEM_RE.exec(name);
			if (!m) {
				continue;
			}
			const values = byKey.get(m[1]) ?? {};
			values[culture] = item.value;
			byKey.set(m[1], values);
		}
	}
	// B2-registered keys with no resource value anywhere yet - shown as a
	// blank row so the wizard can fill them in, per this module's doc.
	for (const reg of parseMetadataNameRegistrations(schemaDir, "B2")) {
		if (!byKey.has(reg.name)) {
			byKey.set(reg.name, {});
		}
	}
	return Array.from(byKey.entries())
		.map(([key, values]) => ({ key, values }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function listLocalizedImages(schemaDir: string, schemaName: string): LocalizedImageRow[] {
	const valuesByGuid = new Map<string, Record<string, LocalizedImageValue>>();
	const captionByGuid = new Map<string, string>();
	for (const { culture, filePath } of listSchemaCultures(schemaDir, schemaName)) {
		const text = readFileSafe(filePath);
		if (text === undefined) {
			continue;
		}
		for (const [name, item] of parseResourceItems(text)) {
			const imgMatch = IMAGE_ITEM_RE.exec(name);
			if (imgMatch && item.contentType === "Data" && item.fileExtension) {
				const mimeType = MIME_BY_EXTENSION[item.fileExtension.toLowerCase()];
				if (mimeType) {
					const values = valuesByGuid.get(imgMatch[1]) ?? {};
					values[culture] = { mimeType, base64: item.value, fileExtension: item.fileExtension };
					valuesByGuid.set(imgMatch[1], values);
				}
				continue;
			}
			const capMatch = CAPTION_ITEM_RE.exec(name);
			if (capMatch && !captionByGuid.has(capMatch[1])) {
				captionByGuid.set(capMatch[1], item.value);
			}
		}
	}
	const metadataNameByGuid = new Map(
		parseMetadataNameRegistrations(schemaDir, "HD8").map((r) => [r.uid, r.name] as const)
	);
	const allGuids = new Set([...valuesByGuid.keys(), ...metadataNameByGuid.keys()]);
	const rows: LocalizedImageRow[] = [];
	for (const guid of allGuids) {
		const metadataName = metadataNameByGuid.get(guid);
		const name = metadataName ?? captionByGuid.get(guid) ?? `(без имени ${guid.slice(0, 8)})`;
		rows.push({
			guid,
			name,
			canRename: metadataName === undefined,
			values: valuesByGuid.get(guid) ?? {}
		});
	}
	return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

function stringItemName(key: string): string {
	return `LocalizableStrings.${key}.Value`;
}

export function setLocalizedStringValue(
	schemaDir: string,
	schemaName: string,
	key: string,
	culture: string,
	value: string
): EditResult {
	const file = listSchemaCultures(schemaDir, schemaName).find((c) => c.culture === culture);
	if (!file) {
		return { ok: false, error: `Культура ${culture} не найдена для этой схемы` };
	}
	const ok = upsertResourceItem(file.filePath, stringItemName(key), { Value: value });
	if (ok) {
		resetLocalizationCaches();
	}
	return ok ? { ok: true } : { ok: false, error: `Не удалось записать ${file.filePath}` };
}

export function addLocalizedStringKey(
	schemaDir: string,
	schemaName: string,
	key: string,
	valuesByCulture: Record<string, string>
): EditResult {
	const trimmed = key.trim();
	const validationError = keyValidationError(trimmed);
	if (validationError) {
		return { ok: false, error: validationError };
	}
	if (listLocalizedStrings(schemaDir, schemaName).some((r) => r.key === trimmed)) {
		return { ok: false, error: `Ключ "${trimmed}" уже существует` };
	}
	const cultures = culturesOrBootstrap(schemaDir, schemaName);
	for (const { culture, filePath } of cultures) {
		upsertResourceItem(filePath, stringItemName(trimmed), { Value: valuesByCulture[culture] ?? "" });
	}
	resetLocalizationCaches();
	return { ok: true };
}

export function renameLocalizedStringKey(
	schemaDir: string,
	schemaName: string,
	oldKey: string,
	newKey: string
): EditResult {
	const trimmed = newKey.trim();
	if (trimmed === oldKey) {
		return { ok: true };
	}
	const validationError = keyValidationError(trimmed);
	if (validationError) {
		return { ok: false, error: validationError };
	}
	if (listLocalizedStrings(schemaDir, schemaName).some((r) => r.key === trimmed)) {
		return { ok: false, error: `Ключ "${trimmed}" уже существует` };
	}
	for (const { filePath } of listSchemaCultures(schemaDir, schemaName)) {
		const text = readFileSafe(filePath);
		const oldItem = text && parseResourceItems(text).get(stringItemName(oldKey));
		if (!oldItem) {
			continue;
		}
		removeResourceItem(filePath, stringItemName(oldKey));
		upsertResourceItem(filePath, stringItemName(trimmed), { Value: oldItem.value });
	}
	resetLocalizationCaches();
	return { ok: true };
}

export function deleteLocalizedStringKey(schemaDir: string, schemaName: string, key: string): EditResult {
	for (const { filePath } of listSchemaCultures(schemaDir, schemaName)) {
		removeResourceItem(filePath, stringItemName(key));
	}
	resetLocalizationCaches();
	return { ok: true };
}

function imageItemName(guid: string): string {
	return `Images.${guid}.Image`;
}

function captionItemName(guid: string): string {
	return `Images.${guid}.Caption`;
}

/** Normalizes a picked file's extension to the `.ext` form these resource
 * items use, and confirms it's one of the extensions BPMSoft's own client
 * (`resolveLocalizedImage`) actually knows how to render. */
export function normalizeImageExtension(fileName: string): string | undefined {
	const ext = path.extname(fileName).toLowerCase();
	return MIME_BY_EXTENSION[ext] ? ext : undefined;
}

export function setLocalizedImageValue(
	schemaDir: string,
	schemaName: string,
	guid: string,
	culture: string,
	buffer: Buffer,
	fileExtension: string
): EditResult {
	const file = listSchemaCultures(schemaDir, schemaName).find((c) => c.culture === culture);
	if (!file) {
		return { ok: false, error: `Культура ${culture} не найдена для этой схемы` };
	}
	const ok = upsertResourceItem(file.filePath, imageItemName(guid), {
		Type: "Image",
		ContentType: "Data",
		FileExtension: fileExtension,
		Value: buffer.toString("base64")
	});
	if (ok) {
		resetLocalizationCaches();
	}
	return ok ? { ok: true } : { ok: false, error: `Не удалось записать ${file.filePath}` };
}

/** Adds a brand-new named image, applying the same file to every culture the
 * schema already has (the common real-world case - see the "same image
 * reused across every culture" note in `HoverProvider.ts`). A per-culture
 * override afterwards is just a normal `setLocalizedImageValue` call on that
 * one cell. Writes the `Caption` item (only to the first culture - resolving
 * it doesn't care which culture file carries it) so the key resolves via
 * `resolveLocalizedImage`'s existing fallback with no `metadata.json`
 * involvement at all. */
export function addLocalizedImage(
	schemaDir: string,
	schemaName: string,
	key: string,
	buffer: Buffer,
	fileExtension: string
): EditResult {
	const trimmed = key.trim();
	const validationError = keyValidationError(trimmed);
	if (validationError) {
		return { ok: false, error: validationError };
	}
	if (listLocalizedImages(schemaDir, schemaName).some((r) => r.name === trimmed)) {
		return { ok: false, error: `Ключ "${trimmed}" уже существует` };
	}
	const cultures = culturesOrBootstrap(schemaDir, schemaName);
	const guid = crypto.randomUUID();
	const base64 = buffer.toString("base64");
	cultures.forEach(({ filePath }, i) => {
		upsertResourceItem(filePath, imageItemName(guid), {
			Type: "Image",
			ContentType: "Data",
			FileExtension: fileExtension,
			Value: base64
		});
		if (i === 0) {
			upsertResourceItem(filePath, captionItemName(guid), { Value: trimmed });
		}
	});
	resetLocalizationCaches();
	return { ok: true };
}

/** Only meaningful when `canRenameImage`'s underlying row had `canRename:
 * true` (the caller/UI is expected to have hidden the control otherwise) -
 * see this module's doc for why an `HD8`-metadata-sourced name can't be
 * safely renamed here. */
export function renameLocalizedImage(schemaDir: string, schemaName: string, guid: string, newName: string): EditResult {
	const trimmed = newName.trim();
	const validationError = keyValidationError(trimmed);
	if (validationError) {
		return { ok: false, error: validationError };
	}
	if (listLocalizedImages(schemaDir, schemaName).some((r) => r.name === trimmed && r.guid !== guid)) {
		return { ok: false, error: `Ключ "${trimmed}" уже существует` };
	}
	const cultures = listSchemaCultures(schemaDir, schemaName);
	let wrote = false;
	for (const { filePath } of cultures) {
		const text = readFileSafe(filePath);
		if (text && parseResourceItems(text).has(captionItemName(guid))) {
			upsertResourceItem(filePath, captionItemName(guid), { Value: trimmed });
			wrote = true;
		}
	}
	if (!wrote && cultures[0]) {
		upsertResourceItem(cultures[0].filePath, captionItemName(guid), { Value: trimmed });
	}
	resetLocalizationCaches();
	return { ok: true };
}

export function deleteLocalizedImage(schemaDir: string, schemaName: string, guid: string): EditResult {
	for (const { filePath } of listSchemaCultures(schemaDir, schemaName)) {
		removeResourceItem(filePath, imageItemName(guid));
		removeResourceItem(filePath, captionItemName(guid));
	}
	resetLocalizationCaches();
	return { ok: true };
}
