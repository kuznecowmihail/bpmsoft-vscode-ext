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
 */

import * as fs from "fs";
import { readFileSafe } from "../fsUtils";
import {
	XmlAttr,
	XmlItem,
	attrValue,
	escapeXmlAttr,
	findContainerSpan,
	listTopLevelItems,
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
