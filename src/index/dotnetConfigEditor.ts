/**
 * Line-surgery editor for the `<add name="..." value="..." />`-style blocks
 * found in BPMSoft's own .NET config files at the app root (not `Pkg` —
 * `ConnectionStrings.config`, `BPMSoft.WebHost.dll.config`'s `<appSettings>`,
 * `WorkspaceConsole\*.dll.config`'s own inline `<connectionStrings>`, ...).
 *
 * Same convention as `localizationEditor.ts`'s `upsertResourceItem`: never a
 * full XML parse+reserialize, only the specific `<add>` line touched — so an
 * edit's git diff stays exactly the size of the actual change and every
 * unrelated section (auth providers, schema managers, ...) in these large
 * files is left untouched byte-for-byte.
 *
 * One block shape serves two real sections found in these files:
 *   - `<connectionStrings><add name="db" connectionString="..." /></connectionStrings>`
 *   - `<appSettings><add key="X" value="Y" /></appSettings>`
 * `XmlAddBlockSpec` picks which attribute names apply; `ConnectionStrings.config`
 * itself is just a file whose root element already *is* `<connectionStrings>`,
 * so the same block-locator handles it with no special case.
 */

import * as fs from "fs";
import { readFileSafe, escapeRegExp } from "../fsUtils";
import { escapeXmlAttr } from "./localizationLookup";

export interface EditResult {
	ok: boolean;
	error?: string;
}

export interface XmlAddBlockSpec {
	blockTag: string;
	nameAttr: string;
	valueAttr: string;
}

export const CONNECTION_STRINGS_SPEC: XmlAddBlockSpec = {
	blockTag: "connectionStrings",
	nameAttr: "name",
	valueAttr: "connectionString"
};

export const APP_SETTINGS_SPEC: XmlAddBlockSpec = {
	blockTag: "appSettings",
	nameAttr: "key",
	valueAttr: "value"
};

export interface XmlAddEntry {
	name: string;
	value: string;
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

function unescapeXmlAttr(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&");
}

function attrValue(line: string, attr: string): string | undefined {
	const re = new RegExp(`\\b${escapeRegExp(attr)}\\s*=\\s*"([^"]*)"`);
	const m = re.exec(line);
	return m ? unescapeXmlAttr(m[1]) : undefined;
}

interface BlockRange {
	/** Index of the `<blockTag ...>` opening line. */
	openIdx: number;
	/** Index of the `</blockTag>` closing line. */
	closeIdx: number;
}

/**
 * Finds `<blockTag>...</blockTag>` by line. Returns `undefined` when the tag
 * is self-closing (e.g. `<connectionStrings configSource="ConnectionStrings.config" />`,
 * a redirect to another file with nothing to edit inline here) or absent.
 */
function locateBlock(lines: string[], blockTag: string): BlockRange | undefined {
	const openRe = new RegExp(`<${escapeRegExp(blockTag)}\\b[^>]*>`);
	const closeRe = new RegExp(`</${escapeRegExp(blockTag)}\\s*>`);
	let openIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		const m = openRe.exec(lines[i]);
		if (!m) {
			continue;
		}
		if (m[0].endsWith("/>")) {
			return undefined;
		}
		openIdx = i;
		break;
	}
	if (openIdx < 0) {
		return undefined;
	}
	for (let i = openIdx; i < lines.length; i++) {
		if (closeRe.test(lines[i])) {
			return { openIdx, closeIdx: i };
		}
	}
	return undefined;
}

const ADD_LINE_RE = /^(\s*)<add\b[^>]*\/>\s*$/;

function buildAddLine(indent: string, spec: XmlAddBlockSpec, name: string, value: string): string {
	return `${indent}<add ${spec.nameAttr}="${escapeXmlAttr(name)}" ${spec.valueAttr}="${escapeXmlAttr(value)}" />`;
}

function readForEdit(filePath: string): { text: string; hadBom: boolean } | undefined {
	const raw = readFileSafe(filePath);
	if (raw === undefined) {
		return undefined;
	}
	const hadBom = raw.charCodeAt(0) === 0xfeff;
	return { text: hadBom ? raw.slice(1) : raw, hadBom };
}

/** Whether `filePath` has an inline (not `configSource`-redirected) `<blockTag>`
 * with at least a well-formed open/close pair — used by `appConfigDiscovery.ts`
 * to decide whether a given `.dll.config` is worth listing at all. */
export function hasXmlAddBlock(filePath: string, spec: XmlAddBlockSpec): boolean {
	const loaded = readForEdit(filePath);
	if (!loaded) {
		return false;
	}
	const { lines } = splitLines(loaded.text);
	return locateBlock(lines, spec.blockTag) !== undefined;
}

export function listXmlAddEntries(filePath: string, spec: XmlAddBlockSpec): XmlAddEntry[] | undefined {
	const loaded = readForEdit(filePath);
	if (!loaded) {
		return undefined;
	}
	const { lines } = splitLines(loaded.text);
	const block = locateBlock(lines, spec.blockTag);
	if (!block) {
		return undefined;
	}
	const entries: XmlAddEntry[] = [];
	for (let i = block.openIdx + 1; i < block.closeIdx; i++) {
		if (!ADD_LINE_RE.test(lines[i])) {
			continue;
		}
		const name = attrValue(lines[i], spec.nameAttr);
		if (name === undefined) {
			continue;
		}
		entries.push({ name, value: attrValue(lines[i], spec.valueAttr) ?? "" });
	}
	return entries;
}

/** Loads the file, locates the block, lets `mutate` edit `lines` in place (or
 * return an error), and writes back only if something actually changed —
 * shared by set/add/rename/delete below so each stays a small line-scan. */
function mutateBlock(
	filePath: string,
	spec: XmlAddBlockSpec,
	mutate: (lines: string[], block: BlockRange) => EditResult
): EditResult {
	const loaded = readForEdit(filePath);
	if (!loaded) {
		return { ok: false, error: "Не удалось прочитать файл" };
	}
	const { lines, eol, trailingNewline } = splitLines(loaded.text);
	const block = locateBlock(lines, spec.blockTag);
	if (!block) {
		return { ok: false, error: `Блок <${spec.blockTag}> не найден в файле` };
	}
	const before = lines.join("\n");
	const result = mutate(lines, block);
	if (!result.ok) {
		return result;
	}
	if (lines.join("\n") === before) {
		return { ok: true };
	}
	const newText = (loaded.hadBom ? "﻿" : "") + joinLines(lines, eol, trailingNewline);
	fs.writeFileSync(filePath, newText, "utf8");
	return { ok: true };
}

function findEntryLine(lines: string[], block: BlockRange, spec: XmlAddBlockSpec, name: string): number {
	for (let i = block.openIdx + 1; i < block.closeIdx; i++) {
		if (ADD_LINE_RE.test(lines[i]) && attrValue(lines[i], spec.nameAttr) === name) {
			return i;
		}
	}
	return -1;
}

export function setXmlAddEntryValue(
	filePath: string,
	spec: XmlAddBlockSpec,
	name: string,
	newValue: string
): EditResult {
	return mutateBlock(filePath, spec, (lines, block) => {
		const idx = findEntryLine(lines, block, spec, name);
		if (idx < 0) {
			return { ok: false, error: `Запись "${name}" не найдена` };
		}
		const indent = ADD_LINE_RE.exec(lines[idx])?.[1] ?? "";
		lines[idx] = buildAddLine(indent, spec, name, newValue);
		return { ok: true };
	});
}

export function addXmlAddEntry(
	filePath: string,
	spec: XmlAddBlockSpec,
	name: string,
	value: string
): EditResult {
	if (!name.trim()) {
		return { ok: false, error: "Имя не может быть пустым" };
	}
	return mutateBlock(filePath, spec, (lines, block) => {
		if (findEntryLine(lines, block, spec, name) >= 0) {
			return { ok: false, error: `Запись "${name}" уже существует` };
		}
		let lastIndent: string | undefined;
		for (let i = block.openIdx + 1; i < block.closeIdx; i++) {
			const m = ADD_LINE_RE.exec(lines[i]);
			if (m) {
				lastIndent = m[1];
			}
		}
		const openIndent = /^(\s*)</.exec(lines[block.openIdx])?.[1] ?? "";
		const indent = lastIndent ?? `${openIndent}\t`;
		lines.splice(block.closeIdx, 0, buildAddLine(indent, spec, name, value));
		return { ok: true };
	});
}

export function renameXmlAddEntry(
	filePath: string,
	spec: XmlAddBlockSpec,
	oldName: string,
	newName: string
): EditResult {
	if (!newName.trim()) {
		return { ok: false, error: "Имя не может быть пустым" };
	}
	return mutateBlock(filePath, spec, (lines, block) => {
		if (findEntryLine(lines, block, spec, newName) >= 0 && oldName !== newName) {
			return { ok: false, error: `Запись "${newName}" уже существует` };
		}
		const idx = findEntryLine(lines, block, spec, oldName);
		if (idx < 0) {
			return { ok: false, error: `Запись "${oldName}" не найдена` };
		}
		const indent = ADD_LINE_RE.exec(lines[idx])?.[1] ?? "";
		const value = attrValue(lines[idx], spec.valueAttr) ?? "";
		lines[idx] = buildAddLine(indent, spec, newName, value);
		return { ok: true };
	});
}

export function deleteXmlAddEntry(filePath: string, spec: XmlAddBlockSpec, name: string): EditResult {
	return mutateBlock(filePath, spec, (lines, block) => {
		const idx = findEntryLine(lines, block, spec, name);
		if (idx < 0) {
			return { ok: false, error: `Запись "${name}" не найдена` };
		}
		lines.splice(idx, 1);
		return { ok: true };
	});
}

/**
 * Reads/writes one attribute on a standalone self-closing element like
 * `<fileDesignMode enabled="true" />` — a different shape from the
 * `<blockTag><add .../></blockTag>` this module otherwise handles (no
 * container, no `name`/`value` attribute pair). Used for the couple of
 * top-level toggle-style settings BPMSoft's own root web-host config carries
 * this way (see `devModeSettings.ts`). Errors (doesn't upsert) when the
 * element or attribute is missing — unlike the `<add>` helpers above, these
 * elements always ship in the base file, so absence means the file isn't
 * what's expected rather than "not configured yet".
 */
export function getSelfClosingElementAttr(filePath: string, tagName: string, attrName: string): string | undefined {
	const loaded = readForEdit(filePath);
	if (!loaded) {
		return undefined;
	}
	const { lines } = splitLines(loaded.text);
	const tagRe = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*/>`);
	const line = lines.find((l) => tagRe.test(l));
	return line ? attrValue(line, attrName) : undefined;
}

export function setSelfClosingElementAttr(
	filePath: string,
	tagName: string,
	attrName: string,
	newValue: string
): EditResult {
	const loaded = readForEdit(filePath);
	if (!loaded) {
		return { ok: false, error: "Не удалось прочитать файл" };
	}
	const { lines, eol, trailingNewline } = splitLines(loaded.text);
	const tagRe = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*/>`);
	const idx = lines.findIndex((l) => tagRe.test(l));
	if (idx < 0) {
		return { ok: false, error: `Элемент <${tagName}> не найден` };
	}
	const attrRe = new RegExp(`(\\b${escapeRegExp(attrName)}\\s*=\\s*")([^"]*)(")`);
	if (!attrRe.test(lines[idx])) {
		return { ok: false, error: `Атрибут "${attrName}" не найден на <${tagName}>` };
	}
	const before = lines[idx];
	lines[idx] = lines[idx].replace(attrRe, (_m, p1: string, _p2: string, p3: string) => `${p1}${escapeXmlAttr(newValue)}${p3}`);
	if (lines[idx] === before) {
		return { ok: true };
	}
	fs.writeFileSync(filePath, (loaded.hadBom ? "﻿" : "") + joinLines(lines, eol, trailingNewline), "utf8");
	return { ok: true };
}
