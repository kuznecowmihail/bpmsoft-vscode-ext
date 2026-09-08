/**
 * Generic leaf-level editor for `appsettings.json` at the app root — the
 * ASP.NET Kestrel/logging/DataProtection config BPMSoft's own `BPMSoft.WebHost`
 * reads at startup. Unlike `dotnetConfigEditor.ts`'s line-surgery approach
 * (needed there to leave huge unrelated XML sections untouched), a full
 * `JSON.parse` -> mutate -> `JSON.stringify` round-trip is safe here: JSON has
 * no comments/mixed content to lose, and matching the file's own detected
 * indent width reproduces its formatting almost exactly.
 *
 * A "leaf" is any path whose value isn't a plain object — string / number /
 * boolean / null, or an array (edited whole, as raw JSON text, rather than
 * per-element — covers list-shaped settings like
 * `ConfigurationServices.AnonymousRoutes.*` without a bespoke array UI).
 * Renaming a leaf's key isn't supported (delete + add covers it) — the extra
 * UI for it wasn't worth it next to editing/adding/removing values.
 */

import * as fs from "fs";
import { readFileSafe } from "../fsUtils";
import { parseJsonNoBom } from "../textUtils";

export interface EditResult {
	ok: boolean;
	error?: string;
}

export type JsonLeafKind = "string" | "number" | "boolean" | "null" | "array";

export interface JsonLeafRow {
	path: string;
	kind: JsonLeafKind;
	/** What the wizard shows/edits as text — the value itself for primitives,
	 * `JSON.stringify`d for arrays/null. */
	display: string;
}

function kindOf(value: unknown): JsonLeafKind | undefined {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "array";
	}
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return typeof value as JsonLeafKind;
	}
	return undefined;
}

function displayOf(value: unknown, kind: JsonLeafKind): string {
	return kind === "array" || kind === "null" ? JSON.stringify(value) : String(value);
}

function walk(value: unknown, prefix: string, out: JsonLeafRow[]): void {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			walk(child, prefix ? `${prefix}.${key}` : key, out);
		}
		return;
	}
	const kind = kindOf(value);
	if (!kind || !prefix) {
		return;
	}
	out.push({ path: prefix, kind, display: displayOf(value, kind) });
}

export function listJsonLeaves(filePath: string): JsonLeafRow[] | undefined {
	const raw = readFileSafe(filePath);
	if (raw === undefined) {
		return undefined;
	}
	const json = parseJsonNoBom<unknown>(raw);
	if (json === undefined || typeof json !== "object" || json === null || Array.isArray(json)) {
		return undefined;
	}
	const out: JsonLeafRow[] = [];
	walk(json, "", out);
	return out;
}

function splitPath(path: string): string[] {
	return path.split(".").filter(Boolean);
}

function detectIndent(text: string): string {
	const m = /\n([ \t]+)\S/.exec(text);
	return m ? m[1] : "  ";
}

interface LoadedJson {
	obj: Record<string, unknown>;
	hadBom: boolean;
	indent: string;
	trailingNewline: boolean;
}

function loadForEdit(filePath: string): LoadedJson | undefined {
	const raw = readFileSafe(filePath);
	if (raw === undefined) {
		return undefined;
	}
	const hadBom = raw.charCodeAt(0) === 0xfeff;
	const text = hadBom ? raw.slice(1) : raw;
	const obj = parseJsonNoBom<Record<string, unknown>>(text);
	if (obj === undefined || typeof obj !== "object" || obj === null || Array.isArray(obj)) {
		return undefined;
	}
	return { obj, hadBom, indent: detectIndent(text), trailingNewline: text.endsWith("\n") };
}

function writeBack(filePath: string, loaded: LoadedJson): void {
	let text = JSON.stringify(loaded.obj, null, loaded.indent);
	if (loaded.trailingNewline) {
		text += "\n";
	}
	fs.writeFileSync(filePath, (loaded.hadBom ? "﻿" : "") + text, "utf8");
}

function parseRawValue(rawInput: string, kind: JsonLeafKind): { ok: true; value: unknown } | { ok: false; error: string } {
	switch (kind) {
		case "string":
			return { ok: true, value: rawInput };
		case "number": {
			const n = Number(rawInput);
			return Number.isNaN(n) ? { ok: false, error: "Некорректное число" } : { ok: true, value: n };
		}
		case "boolean":
			if (rawInput !== "true" && rawInput !== "false") {
				return { ok: false, error: "Ожидалось true или false" };
			}
			return { ok: true, value: rawInput === "true" };
		case "null":
		case "array":
			try {
				return { ok: true, value: JSON.parse(rawInput) };
			} catch {
				return { ok: false, error: "Некорректный JSON" };
			}
	}
}

/** Walks to the parent object of `path`'s last segment, failing if any
 * intermediate segment doesn't resolve to a plain object. */
function resolveParent(root: Record<string, unknown>, segments: string[]): Record<string, unknown> | undefined {
	let cur: unknown = root;
	for (const seg of segments) {
		if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
			return undefined;
		}
		cur = (cur as Record<string, unknown>)[seg];
	}
	return cur !== null && typeof cur === "object" && !Array.isArray(cur) ? (cur as Record<string, unknown>) : undefined;
}

export function setJsonLeafValue(filePath: string, path: string, rawInput: string, kind: JsonLeafKind): EditResult {
	const loaded = loadForEdit(filePath);
	if (!loaded) {
		return { ok: false, error: "Не удалось прочитать appsettings.json" };
	}
	const segments = splitPath(path);
	const key = segments.pop();
	if (!key) {
		return { ok: false, error: "Пустой путь" };
	}
	const parent = resolveParent(loaded.obj, segments);
	if (!parent || !Object.prototype.hasOwnProperty.call(parent, key)) {
		return { ok: false, error: `Путь "${path}" не найден` };
	}
	const parsed = parseRawValue(rawInput, kind);
	if (!parsed.ok) {
		return parsed;
	}
	parent[key] = parsed.value;
	writeBack(filePath, loaded);
	return { ok: true };
}

export function addJsonLeaf(filePath: string, path: string, rawInput: string, kind: JsonLeafKind): EditResult {
	const loaded = loadForEdit(filePath);
	if (!loaded) {
		return { ok: false, error: "Не удалось прочитать appsettings.json" };
	}
	const segments = splitPath(path);
	const key = segments.pop();
	if (!key) {
		return { ok: false, error: "Пустой путь" };
	}
	let cur: Record<string, unknown> = loaded.obj;
	for (const seg of segments) {
		const child = cur[seg];
		if (child === undefined) {
			const created: Record<string, unknown> = {};
			cur[seg] = created;
			cur = created;
		} else if (child !== null && typeof child === "object" && !Array.isArray(child)) {
			cur = child as Record<string, unknown>;
		} else {
			return { ok: false, error: `"${seg}" уже существует и не является объектом` };
		}
	}
	if (Object.prototype.hasOwnProperty.call(cur, key)) {
		return { ok: false, error: `Ключ "${path}" уже существует` };
	}
	const parsed = parseRawValue(rawInput, kind);
	if (!parsed.ok) {
		return parsed;
	}
	cur[key] = parsed.value;
	writeBack(filePath, loaded);
	return { ok: true };
}

export function deleteJsonLeaf(filePath: string, path: string): EditResult {
	const loaded = loadForEdit(filePath);
	if (!loaded) {
		return { ok: false, error: "Не удалось прочитать appsettings.json" };
	}
	const segments = splitPath(path);
	const key = segments.pop();
	if (!key) {
		return { ok: false, error: "Пустой путь" };
	}
	const parent = resolveParent(loaded.obj, segments);
	if (!parent || !Object.prototype.hasOwnProperty.call(parent, key)) {
		return { ok: false, error: `Путь "${path}" не найден` };
	}
	delete parent[key];
	writeBack(filePath, loaded);
	return { ok: true };
}
