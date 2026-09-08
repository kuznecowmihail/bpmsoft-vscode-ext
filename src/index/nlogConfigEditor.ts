/**
 * Read/write API for `nlog.config`/`nlog.targets.config`-shaped files, built
 * on `nlogXml.ts`'s positional tokenizer. Every write is a single span splice
 * (or a small number of them for a swap) against the original file text —
 * never a full parse+reserialize — so an edit's diff is exactly the size of
 * the actual change, matching `dotnetConfigEditor.ts`'s convention.
 *
 * `<targets>` is the one section edited as raw XML per item rather than
 * structured fields (see `nlogCatalog.ts`'s doc and the plan behind this
 * feature) — NLog has 115+ target types with unrelated attribute sets and
 * arbitrarily nested children (a wrapper's own wrapped `<target>`, a
 * `<layout xsi:type="JsonLayout">`'s `<attribute>` children, `ColoredConsole`'s
 * `<highlight-row>`, ...); a typed form per type isn't tractable, so the
 * wizard offers a described type picker (`nlogCatalog.ts`) to get the right
 * `xsi:type` spelling and a starter skeleton, then the user edits the whole
 * element as text with full fidelity.
 *
 * One deliberate, narrow exception to "targets are raw XML": File targets'
 * own archive/retention properties (`getFileTargetRetention`/
 * `setFileTargetRetention` near the bottom of this file) get a real typed
 * form — this is specifically the setting BPMSoft's own default config never
 * turns on anywhere (confirmed: no target sets `maxArchiveFiles`/
 * `maxArchiveDays` in either real install), so it's worth surfacing by name
 * rather than leaving it undiscoverable inside raw XML.
 */

import * as fs from "fs";
import { readFileSafe } from "../fsUtils";
import {
	XmlAttr,
	XmlItem,
	attrValue,
	escapeXmlAttr,
	findContainerSpan,
	findTagEnd,
	listTopLevelItems,
	removeRootAttr,
	setRootAttr,
	spliceSpan,
	tryParseSingleElement
} from "./nlogXml";

export interface EditResult {
	ok: boolean;
	error?: string;
}

export const TARGET_TAGS = ["target", "wrapper-target", "default-wrapper", "default-target-parameters"];

interface LoadedFile {
	text: string;
	hadBom: boolean;
}

function readWhole(filePath: string): LoadedFile | undefined {
	const raw = readFileSafe(filePath);
	if (raw === undefined) {
		return undefined;
	}
	const hadBom = raw.charCodeAt(0) === 0xfeff;
	return { text: hadBom ? raw.slice(1) : raw, hadBom };
}

function writeWhole(filePath: string, text: string, hadBom: boolean): void {
	fs.writeFileSync(filePath, (hadBom ? "﻿" : "") + text, "utf8");
}

/** Indentation immediately preceding `pos` on its own line, or "" if `pos`
 * isn't at the start of an otherwise-blank line prefix (i.e. it shares its
 * line with other content, so there's nothing safe to reuse/remove). */
function indentBefore(text: string, pos: number): string {
	const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
	const prefix = text.slice(lineStart, pos);
	return /^[ \t]*$/.test(prefix) ? prefix : "";
}

function detectIndent(text: string): string {
	const m = /\n([ \t]+)\S/.exec(text);
	return m ? m[1] : "\t";
}

/** Inserts `newItemXml` right after the last item in `items` (matching its
 * indentation), or right after the container's own opening tag if `items` is
 * empty (using the file's detected indent as a best-effort default). */
function insertAfterLast(text: string, containerSpan: [number, number], items: XmlItem[], newItemXml: string): string {
	if (items.length) {
		const last = items[items.length - 1];
		const indent = indentBefore(text, last.span[0]) || detectIndent(text);
		return spliceSpan(text, [last.span[1], last.span[1]], `\n${indent}${newItemXml}`);
	}
	const indent = detectIndent(text);
	return spliceSpan(text, [containerSpan[0], containerSpan[0]], `\n${indent}${newItemXml}`);
}

/** Removes an item's whole line (indentation + trailing newline) when it's
 * alone on its line, otherwise just its own span. */
function deleteItem(text: string, item: XmlItem): string {
	const lineStart = text.lastIndexOf("\n", item.span[0] - 1) + 1;
	const prefix = text.slice(lineStart, item.span[0]);
	const removeFrom = /^[ \t]*$/.test(prefix) ? lineStart : item.span[0];
	let removeTo = item.span[1];
	if (text[removeTo] === "\r") {
		removeTo++;
	}
	if (text[removeTo] === "\n") {
		removeTo++;
	}
	return spliceSpan(text, [removeFrom, removeTo], "");
}

type MutateResult = { text: string } | { error: string };

function withContainer(
	filePath: string,
	containerTag: string,
	itemTags: string[],
	fn: (text: string, items: XmlItem[], containerSpan: [number, number]) => MutateResult
): EditResult {
	const loaded = readWhole(filePath);
	if (!loaded) {
		return { ok: false, error: "Не удалось прочитать файл" };
	}
	const span = findContainerSpan(loaded.text, containerTag);
	if (!span) {
		return { ok: false, error: `Блок <${containerTag}> не найден в файле` };
	}
	const items = listTopLevelItems(loaded.text, span, itemTags);
	const result = fn(loaded.text, items, span);
	if ("error" in result) {
		return { ok: false, error: result.error };
	}
	if (result.text === loaded.text) {
		return { ok: true };
	}
	writeWhole(filePath, result.text, loaded.hadBom);
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Variables — <variable name="..." value="..." /> as a direct child of <nlog>.
// ---------------------------------------------------------------------------

export interface NlogVariableRow {
	name: string;
	value: string;
}

function buildVariableXml(name: string, value: string): string {
	return `<variable name="${escapeXmlAttr(name)}" value="${escapeXmlAttr(value)}" />`;
}

export function listVariables(filePath: string): NlogVariableRow[] | undefined {
	const loaded = readWhole(filePath);
	if (!loaded) {
		return undefined;
	}
	const span = findContainerSpan(loaded.text, "nlog");
	if (!span) {
		return undefined;
	}
	return listTopLevelItems(loaded.text, span, ["variable"])
		.filter((i) => i.enabled)
		.map((i) => ({ name: attrValue(i.attrs, "name") ?? "", value: attrValue(i.attrs, "value") ?? "" }));
}

export function setVariable(filePath: string, name: string, newValue: string): EditResult {
	return withContainer(filePath, "nlog", ["variable"], (text, items) => {
		const item = items.find((i) => i.enabled && attrValue(i.attrs, "name") === name);
		if (!item) {
			return { error: `Переменная "${name}" не найдена` };
		}
		return { text: spliceSpan(text, item.span, buildVariableXml(name, newValue)) };
	});
}

export function addVariable(filePath: string, name: string, value: string): EditResult {
	if (!name.trim()) {
		return { ok: false, error: "Имя не может быть пустым" };
	}
	return withContainer(filePath, "nlog", ["variable"], (text, items, span) => {
		if (items.some((i) => i.enabled && attrValue(i.attrs, "name") === name)) {
			return { error: `Переменная "${name}" уже существует` };
		}
		return { text: insertAfterLast(text, span, items, buildVariableXml(name, value)) };
	});
}

export function renameVariable(filePath: string, oldName: string, newName: string): EditResult {
	if (!newName.trim()) {
		return { ok: false, error: "Имя не может быть пустым" };
	}
	return withContainer(filePath, "nlog", ["variable"], (text, items) => {
		if (oldName !== newName && items.some((i) => i.enabled && attrValue(i.attrs, "name") === newName)) {
			return { error: `Переменная "${newName}" уже существует` };
		}
		const item = items.find((i) => i.enabled && attrValue(i.attrs, "name") === oldName);
		if (!item) {
			return { error: `Переменная "${oldName}" не найдена` };
		}
		const value = attrValue(item.attrs, "value") ?? "";
		return { text: spliceSpan(text, item.span, buildVariableXml(newName, value)) };
	});
}

export function deleteVariable(filePath: string, name: string): EditResult {
	return withContainer(filePath, "nlog", ["variable"], (text, items) => {
		const item = items.find((i) => i.enabled && attrValue(i.attrs, "name") === name);
		if (!item) {
			return { error: `Переменная "${name}" не найдена` };
		}
		return { text: deleteItem(text, item) };
	});
}

// ---------------------------------------------------------------------------
// Extensions — <add assembly="..." [type="..."] /> inside <extensions>.
// ---------------------------------------------------------------------------

export interface NlogExtensionRow {
	assembly: string;
	type?: string;
}

function buildExtensionXml(row: NlogExtensionRow): string {
	const attrs = [`assembly="${escapeXmlAttr(row.assembly)}"`];
	if (row.type) {
		attrs.push(`type="${escapeXmlAttr(row.type)}"`);
	}
	return `<add ${attrs.join(" ")} />`;
}

export function listExtensions(filePath: string): NlogExtensionRow[] | undefined {
	const loaded = readWhole(filePath);
	if (!loaded) {
		return undefined;
	}
	const span = findContainerSpan(loaded.text, "extensions");
	if (!span) {
		return undefined;
	}
	return listTopLevelItems(loaded.text, span, ["add"])
		.filter((i) => i.enabled)
		.map((i) => ({ assembly: attrValue(i.attrs, "assembly") ?? "", type: attrValue(i.attrs, "type") }));
}

export function addExtension(filePath: string, assembly: string, type?: string): EditResult {
	if (!assembly.trim()) {
		return { ok: false, error: "Assembly не может быть пустым" };
	}
	return withContainer(filePath, "extensions", ["add"], (text, items, span) => {
		if (items.some((i) => i.enabled && attrValue(i.attrs, "assembly") === assembly)) {
			return { error: `Расширение "${assembly}" уже добавлено` };
		}
		return { text: insertAfterLast(text, span, items, buildExtensionXml({ assembly, type })) };
	});
}

export function deleteExtension(filePath: string, assembly: string): EditResult {
	return withContainer(filePath, "extensions", ["add"], (text, items) => {
		const item = items.find((i) => i.enabled && attrValue(i.attrs, "assembly") === assembly);
		if (!item) {
			return { error: `Расширение "${assembly}" не найдено` };
		}
		return { text: deleteItem(text, item) };
	});
}

/** Sets (or clears, given "") the optional `type=` attribute of an existing
 * extension — `assembly` itself isn't renameable in place (delete + add
 * covers a corrected assembly name, same as any other identity field here). */
export function setExtensionType(filePath: string, assembly: string, newType: string): EditResult {
	return withContainer(filePath, "extensions", ["add"], (text, items) => {
		const item = items.find((i) => i.enabled && attrValue(i.attrs, "assembly") === assembly);
		if (!item) {
			return { error: `Расширение "${assembly}" не найдено` };
		}
		return { text: spliceSpan(text, item.span, buildExtensionXml({ assembly, type: newType || undefined })) };
	});
}

// ---------------------------------------------------------------------------
// Rules — <logger name="..." minlevel=... maxlevel=... level=... levels=...
// writeTo=... final=... enabled=... ruleName=... finalMinLevel=... /> inside
// <rules>. Order is semantic (top-to-bottom precedence, final/finalMinLevel
// short-circuit), hence moveRule.
// ---------------------------------------------------------------------------

export interface NlogRule {
	name: string;
	level?: string;
	levels?: string;
	minlevel?: string;
	maxlevel?: string;
	writeTo?: string;
	final?: boolean;
	enabled?: boolean;
	ruleName?: string;
	/** NLog 5.0+. */
	finalMinLevel?: string;
}

const RULE_ATTR_ORDER: (keyof NlogRule)[] = [
	"name",
	"level",
	"levels",
	"minlevel",
	"maxlevel",
	"writeTo",
	"final",
	"enabled",
	"ruleName",
	"finalMinLevel"
];

function buildRuleXml(rule: NlogRule): string {
	const parts: string[] = [];
	for (const key of RULE_ATTR_ORDER) {
		const v = rule[key];
		if (v === undefined || v === "") {
			continue;
		}
		parts.push(`${key}="${escapeXmlAttr(String(v))}"`);
	}
	return `<logger ${parts.join(" ")} />`;
}

function parseRule(attrs: XmlAttr[]): NlogRule {
	const rule: NlogRule = { name: attrValue(attrs, "name") ?? "" };
	for (const key of ["level", "levels", "minlevel", "maxlevel", "writeTo", "ruleName", "finalMinLevel"] as const) {
		const v = attrValue(attrs, key);
		if (v !== undefined) {
			rule[key] = v;
		}
	}
	const finalV = attrValue(attrs, "final");
	if (finalV !== undefined) {
		rule.final = finalV === "true";
	}
	const enabledV = attrValue(attrs, "enabled");
	if (enabledV !== undefined) {
		rule.enabled = enabledV === "true";
	}
	return rule;
}

export function listRules(filePath: string): NlogRule[] | undefined {
	const loaded = readWhole(filePath);
	if (!loaded) {
		return undefined;
	}
	const span = findContainerSpan(loaded.text, "rules");
	if (!span) {
		return undefined;
	}
	return listTopLevelItems(loaded.text, span, ["logger"])
		.filter((i) => i.enabled)
		.map((i) => parseRule(i.attrs));
}

export function addRule(filePath: string, rule: NlogRule): EditResult {
	if (!rule.name.trim()) {
		return { ok: false, error: "Имя логгера не может быть пустым" };
	}
	return withContainer(filePath, "rules", ["logger"], (text, items, span) => {
		return { text: insertAfterLast(text, span, items, buildRuleXml(rule)) };
	});
}

export function updateRule(filePath: string, index: number, rule: NlogRule): EditResult {
	if (!rule.name.trim()) {
		return { ok: false, error: "Имя логгера не может быть пустым" };
	}
	return withContainer(filePath, "rules", ["logger"], (text, items) => {
		const enabledItems = items.filter((i) => i.enabled);
		const item = enabledItems[index];
		if (!item) {
			return { error: "Правило не найдено" };
		}
		return { text: spliceSpan(text, item.span, buildRuleXml(rule)) };
	});
}

export function deleteRule(filePath: string, index: number): EditResult {
	return withContainer(filePath, "rules", ["logger"], (text, items) => {
		const item = items.filter((i) => i.enabled)[index];
		if (!item) {
			return { error: "Правило не найдено" };
		}
		return { text: deleteItem(text, item) };
	});
}

export function moveRule(filePath: string, index: number, direction: "up" | "down"): EditResult {
	return withContainer(filePath, "rules", ["logger"], (text, items) => {
		const enabledItems = items.filter((i) => i.enabled);
		const otherIndex = direction === "up" ? index - 1 : index + 1;
		const a = enabledItems[index];
		const b = enabledItems[otherIndex];
		if (!a || !b) {
			return { error: "Нельзя переместить" };
		}
		const [first, second] = a.span[0] < b.span[0] ? [a, b] : [b, a];
		const gap = text.slice(first.span[1], second.span[0]);
		const swapped = text.slice(second.span[0], second.span[1]) + gap + text.slice(first.span[0], first.span[1]);
		return { text: spliceSpan(text, [first.span[0], second.span[1]], swapped) };
	});
}

// ---------------------------------------------------------------------------
// Targets — edited whole, as raw XML (see file-level doc for why).
// ---------------------------------------------------------------------------

export interface NlogTargetRow {
	index: number;
	tag: string;
	name?: string;
	xsiType?: string;
	enabled: boolean;
	raw: string;
}

export function listTargets(filePath: string): NlogTargetRow[] | undefined {
	const loaded = readWhole(filePath);
	if (!loaded) {
		return undefined;
	}
	const span = findContainerSpan(loaded.text, "targets");
	if (!span) {
		return undefined;
	}
	return listTopLevelItems(loaded.text, span, TARGET_TAGS).map((item, index) => ({
		index,
		tag: item.tag,
		name: attrValue(item.attrs, "name"),
		xsiType: attrValue(item.attrs, "xsi:type") ?? attrValue(item.attrs, "type"),
		enabled: item.enabled,
		raw: item.raw
	}));
}

function validateTargetFragment(rawXml: string): { ok: true } | { ok: false; error: string } {
	const parsed = tryParseSingleElement(rawXml);
	if (!parsed) {
		return { ok: false, error: "Не удалось разобрать XML — ожидается ровно один корректный элемент" };
	}
	if (!TARGET_TAGS.includes(parsed.tag)) {
		return { ok: false, error: `Неожиданный тег "<${parsed.tag}>" — ожидался <target>, <wrapper-target>, <default-wrapper> или <default-target-parameters>` };
	}
	return { ok: true };
}

export function addTarget(filePath: string, rawXml: string): EditResult {
	const validated = validateTargetFragment(rawXml);
	if (!validated.ok) {
		return { ok: false, error: validated.error };
	}
	const parsed = tryParseSingleElement(rawXml)!;
	const name = attrValue(parsed.attrs, "name");
	return withContainer(filePath, "targets", TARGET_TAGS, (text, items, span) => {
		if (name && items.some((i) => i.enabled && attrValue(i.attrs, "name") === name)) {
			return { error: `Таргет с именем "${name}" уже существует` };
		}
		return { text: insertAfterLast(text, span, items, rawXml.trim()) };
	});
}

export function replaceTarget(filePath: string, index: number, rawXml: string): EditResult {
	const validated = validateTargetFragment(rawXml);
	if (!validated.ok) {
		return { ok: false, error: validated.error };
	}
	return withContainer(filePath, "targets", TARGET_TAGS, (text, items) => {
		const item = items[index];
		if (!item) {
			return { error: "Таргет не найден" };
		}
		return { text: spliceSpan(text, item.span, rawXml.trim()) };
	});
}

export function deleteTarget(filePath: string, index: number): EditResult {
	return withContainer(filePath, "targets", TARGET_TAGS, (text, items) => {
		const item = items[index];
		if (!item) {
			return { error: "Таргет не найден" };
		}
		return { text: deleteItem(text, item) };
	});
}

/** Comments a live target out (disable), or strips the `<!-- -->` wrapper off
 * a disabled one (enable). Refuses to comment out content that already
 * contains `--` — illegal inside an XML comment, and cheap to hit if a
 * target's own connection string or layout happens to contain it.
 *
 * Always writes the comment wrapper as `<!-- X -->` (one space each side),
 * regardless of the original's own spacing (some of BPMSoft's own vendor
 * examples use `<!--X-->` with none) — a disable-then-re-enable-then-disable
 * round trip on the same target therefore isn't necessarily byte-identical
 * to where it started, only semantically identical (still a valid, inert
 * comment) and still scoped to just that target's own line(s). Same
 * canonicalize-on-write trade-off `dotnetConfigEditor.ts` already makes for
 * attribute order. */
export function toggleTargetEnabled(filePath: string, index: number): EditResult {
	return withContainer(filePath, "targets", TARGET_TAGS, (text, items) => {
		const item = items[index];
		if (!item) {
			return { error: "Таргет не найден" };
		}
		if (item.enabled) {
			if (item.raw.includes("--")) {
				return { error: "Нельзя закомментировать: содержимое таргета содержит '--', что недопустимо внутри XML-комментария" };
			}
			return { text: spliceSpan(text, item.span, `<!-- ${item.raw} -->`) };
		}
		const inner = item.raw.replace(/^<!--\s*/, "").replace(/\s*-->$/, "");
		return { text: spliceSpan(text, item.span, inner) };
	});
}

export function duplicateTarget(filePath: string, index: number, newName: string): EditResult {
	const targets = listTargets(filePath);
	const item = targets?.[index];
	if (!item) {
		return { ok: false, error: "Таргет не найден" };
	}
	if (!item.enabled) {
		return { ok: false, error: "Нельзя дублировать закомментированный таргет — сначала включите его" };
	}
	const parsed = tryParseSingleElement(item.raw);
	if (!parsed) {
		return { ok: false, error: "Не удалось разобрать таргет" };
	}
	const newRaw = setRootAttr(item.raw, "name", newName);
	return addTarget(filePath, newRaw);
}

// ---------------------------------------------------------------------------
// File target retention (archiving/auto-delete of old logs) — a typed form
// for one specific, high-value slice of one target type, not a general
// escape from "targets are raw XML" (see file-level doc for why). Grounded
// in NLog's own File-target property docs/source (FileArchivePeriod,
// ArchiveNumberingMode): https://github.com/NLog/NLog/wiki/File-target,
// https://github.com/NLog/NLog/blob/master/src/NLog/Targets/FileArchivePeriod.cs
// ---------------------------------------------------------------------------

/** `FileArchivePeriod` enum members, in declaration order, straight from
 * NLog's own source — the real valid values for `archiveEvery`. */
export const NLOG_ARCHIVE_EVERY_VALUES = [
	"",
	"Year",
	"Month",
	"Day",
	"Hour",
	"Minute",
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday"
];

/** `ArchiveNumberingMode` enum members, straight from NLog's own source —
 * the real valid values for `archiveNumbering`. Note `maxArchiveDays` has no
 * effect when this is `"Rolling"` (NLog's own documented limitation). */
export const NLOG_ARCHIVE_NUMBERING_VALUES = ["", "Sequence", "Rolling", "Date", "DateAndSequence"];

export interface FileTargetRetention {
	/** FileArchivePeriod — "" means unset (no time-based archiving trigger). */
	archiveEvery: string;
	/** Byte threshold — "" means unset (no size-based archiving trigger). */
	archiveAboveSize: string;
	/** "" means unset (no count-based cleanup). */
	maxArchiveFiles: string;
	/** "" means unset (no age-based cleanup); has no effect if archiveNumbering is Rolling. */
	maxArchiveDays: string;
	archiveOldFileOnStartup: boolean;
	/** ArchiveNumberingMode — "" means NLog's own default (Sequence). */
	archiveNumbering: string;
}

/** A File target's own properties can be written either as an attribute on
 * the `<target>` tag (`archiveEvery="Day"`) or, for the few that support it
 * in real BPMSoft configs, as a child element (`<archiveEvery>Day</archiveEvery>`
 * — seen in `sqlLogAppender`/`loggingDataReaderAppender`). Both are
 * genuine NLog syntax; this reads whichever form is actually present. */
function readTargetProp(raw: string, key: string): string | undefined {
	const tagEnd = findTagEnd(raw, 0);
	const openTag = raw.slice(0, tagEnd < 0 ? raw.length : tagEnd);
	const attrMatch = new RegExp(`\\s${key}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(openTag);
	if (attrMatch) {
		return attrMatch[2] !== undefined ? attrMatch[2] : attrMatch[3];
	}
	const elMatch = new RegExp(`<${key}>([^<]*)</${key}>`).exec(raw);
	return elMatch ? elMatch[1].trim() : undefined;
}

/** Sets, updates, or (given `""`) removes a File target property, preserving
 * whichever representation (attribute vs. child element) it already used;
 * a brand-new property not present in either form is always added as an
 * attribute (simplest, and NLog freely mixes both forms on one target). */
function applyTargetProp(raw: string, key: string, value: string): string {
	const tagEnd = findTagEnd(raw, 0);
	const openTag = raw.slice(0, tagEnd < 0 ? raw.length : tagEnd);
	const hasAttr = new RegExp(`\\s${key}\\s*=\\s*("[^"]*"|'[^']*')`).test(openTag);
	const elRe = new RegExp(`\\s*<${key}>[^<]*</${key}>`);
	const hasElement = elRe.test(raw);

	if (!value) {
		if (hasAttr) {
			return removeRootAttr(raw, key);
		}
		if (hasElement) {
			return raw.replace(elRe, "");
		}
		return raw;
	}
	if (hasElement && !hasAttr) {
		return raw.replace(new RegExp(`(<${key}>)[^<]*(</${key}>)`), `$1${escapeXmlAttr(value)}$2`);
	}
	return setRootAttr(raw, key, value);
}

export function getFileTargetRetention(
	filePath: string,
	index: number
): { ok: true; settings: FileTargetRetention } | { ok: false; error: string } {
	const targets = listTargets(filePath);
	const item = targets?.[index];
	if (!item) {
		return { ok: false, error: "Таргет не найден" };
	}
	if (item.xsiType !== "File") {
		return { ok: false, error: "Настройки хранения логов доступны только для таргетов типа File" };
	}
	return {
		ok: true,
		settings: {
			archiveEvery: readTargetProp(item.raw, "archiveEvery") ?? "",
			archiveAboveSize: readTargetProp(item.raw, "archiveAboveSize") ?? "",
			maxArchiveFiles: readTargetProp(item.raw, "maxArchiveFiles") ?? "",
			maxArchiveDays: readTargetProp(item.raw, "maxArchiveDays") ?? "",
			archiveOldFileOnStartup: readTargetProp(item.raw, "archiveOldFileOnStartup") === "true",
			archiveNumbering: readTargetProp(item.raw, "archiveNumbering") ?? ""
		}
	};
}

export function setFileTargetRetention(filePath: string, index: number, settings: FileTargetRetention): EditResult {
	return withContainer(filePath, "targets", TARGET_TAGS, (text, items) => {
		const item = items[index];
		if (!item) {
			return { error: "Таргет не найден" };
		}
		if ((attrValue(item.attrs, "xsi:type") ?? attrValue(item.attrs, "type")) !== "File") {
			return { error: "Настройки хранения логов доступны только для таргетов типа File" };
		}
		let raw = item.raw;
		raw = applyTargetProp(raw, "archiveEvery", settings.archiveEvery);
		raw = applyTargetProp(raw, "archiveAboveSize", settings.archiveAboveSize);
		raw = applyTargetProp(raw, "maxArchiveFiles", settings.maxArchiveFiles);
		raw = applyTargetProp(raw, "maxArchiveDays", settings.maxArchiveDays);
		raw = applyTargetProp(raw, "archiveOldFileOnStartup", settings.archiveOldFileOnStartup ? "true" : "");
		raw = applyTargetProp(raw, "archiveNumbering", settings.archiveNumbering);
		return { text: spliceSpan(text, item.span, raw) };
	});
}

// ---------------------------------------------------------------------------
// ColoredConsole row highlighting — the second narrow typed exception (see
// file-level doc). Real, concrete usage exists in BPMSoft's own
// WorkspaceConsole\BPMSoft.Tools.WorkspaceConsole.nlog.config (a
// FilteringWrapper wrapping a ColoredConsole with three <highlight-row>
// children) — bounded and well-documented enough (NLog's own
// ConsoleOutputColor enum + ColoredConsole-target wiki page) to be worth a
// form instead of raw XML.
// ---------------------------------------------------------------------------

/** `ConsoleOutputColor` enum members, straight from NLog's own source. */
export const NLOG_CONSOLE_COLORS = [
	"",
	"Black",
	"DarkBlue",
	"DarkGreen",
	"DarkCyan",
	"DarkRed",
	"DarkMagenta",
	"DarkYellow",
	"Gray",
	"DarkGray",
	"Blue",
	"Green",
	"Cyan",
	"Red",
	"Magenta",
	"Yellow",
	"White",
	"NoChange"
];

/** The 6 real NLog log levels a highlight condition compares against
 * (`LogLevel.Off` isn't a level an event can actually have, so it's not a
 * meaningful comparison target here). */
export const NLOG_CONDITION_LEVELS = ["Trace", "Debug", "Info", "Warn", "Error", "Fatal"];

export interface HighlightRow {
	/** Free-text NLog condition — almost always `level <op> LogLevel.<X>` in
	 * practice (100% of real samples found), but the grammar allows more; an
	 * unrecognized shape is preserved and shown as-is rather than corrupted. */
	condition: string;
	foregroundColor: string;
	backgroundColor: string;
}

export interface ColoredConsoleHighlighting {
	/** NLog's own default: true. The built-in rules (Fatal/Error=Red,
	 * Warn=Yellow, Info=White, Debug/Trace=Gray) apply on top of — before —
	 * any custom rows below when this is on. */
	useDefaultRowHighlightingRules: boolean;
	rows: HighlightRow[];
}

/** Uses the same quote-aware tokenizer as everything else in this file —
 * NOT a hand-rolled `[^>]*`-style regex, which silently mis-parses a real
 * row like `condition="level >= LogLevel.Error"`: the literal `>` inside
 * the (perfectly legal) quoted attribute value ends the "tag" early for a
 * naive character-class scan, dropping that row outright. Confirmed against
 * WorkspaceConsole's own real `consoleAll` target, which has exactly this. */
function parseHighlightRows(raw: string): HighlightRow[] {
	const parsed = tryParseSingleElement(raw);
	if (!parsed) {
		return [];
	}
	const innerSpan = findContainerSpan(raw, parsed.tag);
	if (!innerSpan) {
		return [];
	}
	return listTopLevelItems(raw, innerSpan, ["highlight-row"]).map((item) => ({
		condition: attrValue(item.attrs, "condition") ?? "",
		foregroundColor: attrValue(item.attrs, "foregroundColor") ?? "",
		backgroundColor: attrValue(item.attrs, "backgroundColor") ?? ""
	}));
}

/** Removes every existing `<highlight-row/>` child (located the same
 * quote-aware way as `parseHighlightRows` — see its own doc for why a plain
 * regex isn't safe here) and inserts `rows` fresh; simpler and safer than
 * diffing/patching the old set in place, since rows carry no identity of
 * their own beyond position. Converts a self-closing target to an
 * open/close pair if `rows` is non-empty (a self-closing `<target .../>`
 * can't have children). */
function replaceHighlightRows(raw: string, rows: HighlightRow[]): string {
	const parsed = tryParseSingleElement(raw);
	if (!parsed) {
		return raw;
	}
	let withoutRows = raw;
	const innerSpan = findContainerSpan(raw, parsed.tag);
	if (innerSpan) {
		const existingRows = listTopLevelItems(raw, innerSpan, ["highlight-row"]);
		for (let i = existingRows.length - 1; i >= 0; i--) {
			withoutRows = deleteItem(withoutRows, existingRows[i]);
		}
	}
	if (!rows.length) {
		return withoutRows;
	}
	const rowsXml = rows
		.map((r) => {
			const attrs = [`condition="${escapeXmlAttr(r.condition)}"`];
			if (r.foregroundColor) {
				attrs.push(`foregroundColor="${escapeXmlAttr(r.foregroundColor)}"`);
			}
			if (r.backgroundColor) {
				attrs.push(`backgroundColor="${escapeXmlAttr(r.backgroundColor)}"`);
			}
			return `\n\t\t\t\t<highlight-row ${attrs.join(" ")} />`;
		})
		.join("");
	const tagEnd = findTagEnd(withoutRows, 0);
	const openTag = withoutRows.slice(0, tagEnd < 0 ? withoutRows.length : tagEnd);
	if (openTag.endsWith("/")) {
		return `${openTag.slice(0, -1).trimEnd()}>${rowsXml}\n\t\t\t</target>`;
	}
	const closeIdx = withoutRows.lastIndexOf("</target>");
	if (closeIdx < 0) {
		return withoutRows;
	}
	// Strip the whitespace-only indentation that was sitting right before
	// `</target>` (now that every row before it is gone) — otherwise it
	// survives as a blank line between the opening tag and the first
	// freshly-inserted row, since `rowsXml` supplies its own leading newline.
	const before = withoutRows.slice(0, closeIdx).replace(/[ \t]*$/, "").replace(/\n$/, "");
	return `${before}${rowsXml}\n\t\t\t${withoutRows.slice(closeIdx)}`;
}

/**
 * Finds the first `xsi:type="ColoredConsole"` element within `raw` — either
 * `raw` itself, or nested one or more levels deep inside a wrapper (BPMSoft's
 * own real example: `FilteringWrapper` → `ColoredConsole`). Returns the
 * element's own `[start, end)` span *relative to `raw`*, or `undefined` if
 * none exists anywhere in the fragment. Recursion terminates naturally —
 * each step descends into a strictly smaller substring found within the
 * current one, bottoming out when `tryParseSingleElement`/`findContainerSpan`
 * find nothing further to descend into. */
function findColoredConsoleSpan(raw: string, offset = 0): [number, number] | undefined {
	const parsed = tryParseSingleElement(raw);
	if (!parsed) {
		return undefined;
	}
	if ((attrValue(parsed.attrs, "xsi:type") ?? attrValue(parsed.attrs, "type")) === "ColoredConsole") {
		return [offset, offset + raw.length];
	}
	const innerSpan = findContainerSpan(raw, parsed.tag);
	if (!innerSpan) {
		return undefined;
	}
	for (const child of listTopLevelItems(raw, innerSpan, TARGET_TAGS)) {
		const found = findColoredConsoleSpan(child.raw, offset + child.span[0]);
		if (found) {
			return found;
		}
	}
	return undefined;
}

export function getColoredConsoleHighlighting(
	filePath: string,
	index: number
): { ok: true; settings: ColoredConsoleHighlighting } | { ok: false; error: string } {
	const targets = listTargets(filePath);
	const item = targets?.[index];
	if (!item) {
		return { ok: false, error: "Таргет не найден" };
	}
	const span = findColoredConsoleSpan(item.raw);
	if (!span) {
		return { ok: false, error: "В этом таргете не найден элемент ColoredConsole" };
	}
	const coloredConsoleRaw = item.raw.slice(span[0], span[1]);
	const useDefault = readTargetProp(coloredConsoleRaw, "useDefaultRowHighlightingRules");
	return {
		ok: true,
		settings: {
			useDefaultRowHighlightingRules: useDefault === undefined ? true : useDefault === "true",
			rows: parseHighlightRows(coloredConsoleRaw)
		}
	};
}

export function setColoredConsoleHighlighting(filePath: string, index: number, settings: ColoredConsoleHighlighting): EditResult {
	return withContainer(filePath, "targets", TARGET_TAGS, (text, items) => {
		const item = items[index];
		if (!item) {
			return { error: "Таргет не найден" };
		}
		const span = findColoredConsoleSpan(item.raw);
		if (!span) {
			return { error: "В этом таргете не найден элемент ColoredConsole" };
		}
		let coloredConsoleRaw = item.raw.slice(span[0], span[1]);
		// true is NLog's own default, so only write the attribute when
		// explicitly turning it off — matches how every real sample leaves it
		// unset rather than spelling out "true".
		coloredConsoleRaw = applyTargetProp(coloredConsoleRaw, "useDefaultRowHighlightingRules", settings.useDefaultRowHighlightingRules ? "" : "false");
		coloredConsoleRaw = replaceHighlightRows(coloredConsoleRaw, settings.rows);
		const newItemRaw = spliceSpan(item.raw, span, coloredConsoleRaw);
		return { text: spliceSpan(text, item.span, newItemRaw) };
	});
}
