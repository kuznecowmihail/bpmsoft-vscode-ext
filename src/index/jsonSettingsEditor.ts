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
 * per-element). Renaming a leaf's key isn't supported (delete + add covers
 * it) — the extra UI for it wasn't worth it next to editing/adding/removing
 * values.
 *
 * One subtree is deliberately excluded from the generic leaf walk and gets
 * its own dedicated editor below instead: `ConfigurationServices.AnonymousRoutes`
 * (the "which web services are reachable without authentication" list). Its
 * own keys are themselves full, namespace-qualified service class names
 * (`BPMSoft.Configuration.Foo.BarService`) — dotted, same as this module's own
 * nesting delimiter — so the generic dot-joined leaf path can't tell "one key
 * with dots in it" from "several levels of nested object" apart, and every
 * entry in this section would resolve to the wrong (nonexistent) path.
 */

import * as fs from "fs";
import { readFileSafe } from "../fsUtils";
import { parseJsonNoBom } from "../textUtils";

export interface EditResult {
	ok: boolean;
	error?: string;
}

export type JsonLeafKind = "string" | "number" | "boolean" | "null" | "array";

const ANON_ROUTES_SECTION = "ConfigurationServices";
const ANON_ROUTES_KEY = "AnonymousRoutes";
const ANON_ROUTES_PREFIX = `${ANON_ROUTES_SECTION}.${ANON_ROUTES_KEY}`;

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
	if (prefix === ANON_ROUTES_PREFIX) {
		return;
	}
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

/**
 * Dedicated editor for `ConfigurationServices.AnonymousRoutes` — "anonymous
 * web services", the routes reachable without authentication. See this
 * module's own file-level doc for why this can't go through the generic
 * path-based leaf editor above (its keys are themselves dotted namespaces).
 */
export interface AnonymousRouteRow {
	serviceClassName: string;
	routes: string[];
}

function anonymousRoutesContainer(root: Record<string, unknown>): Record<string, unknown> | undefined {
	const section = root[ANON_ROUTES_SECTION];
	if (!section || typeof section !== "object" || Array.isArray(section)) {
		return undefined;
	}
	const container = (section as Record<string, unknown>)[ANON_ROUTES_KEY];
	if (!container || typeof container !== "object" || Array.isArray(container)) {
		return undefined;
	}
	return container as Record<string, unknown>;
}

function asRouteList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
}

export function listAnonymousRoutes(filePath: string): AnonymousRouteRow[] | undefined {
	const raw = readFileSafe(filePath);
	if (raw === undefined) {
		return undefined;
	}
	const json = parseJsonNoBom<unknown>(raw);
	if (json === undefined || typeof json !== "object" || json === null || Array.isArray(json)) {
		return undefined;
	}
	const container = anonymousRoutesContainer(json as Record<string, unknown>);
	if (!container) {
		return [];
	}
	const out: AnonymousRouteRow[] = [];
	for (const [serviceClassName, value] of Object.entries(container)) {
		const routes = asRouteList(value);
		if (routes) {
			out.push({ serviceClassName, routes });
		}
	}
	return out;
}

export function setAnonymousRouteRoutes(filePath: string, serviceClassName: string, routes: string[]): EditResult {
	const loaded = loadForEdit(filePath);
	if (!loaded) {
		return { ok: false, error: "Не удалось прочитать appsettings.json" };
	}
	const container = anonymousRoutesContainer(loaded.obj);
	if (!container || !Object.prototype.hasOwnProperty.call(container, serviceClassName)) {
		return { ok: false, error: `Сервис "${serviceClassName}" не найден` };
	}
	container[serviceClassName] = routes;
	writeBack(filePath, loaded);
	return { ok: true };
}

/** Auto-vivifies `ConfigurationServices`/`AnonymousRoutes` if either is
 * missing entirely — a fresh appsettings.json with no anonymous services
 * configured yet legitimately lacks both. */
function ensureAnonymousRoutesContainer(root: Record<string, unknown>): { ok: true; container: Record<string, unknown> } | { ok: false; error: string } {
	let section = root[ANON_ROUTES_SECTION];
	if (section === undefined) {
		section = {};
		root[ANON_ROUTES_SECTION] = section;
	}
	if (typeof section !== "object" || section === null || Array.isArray(section)) {
		return { ok: false, error: `"${ANON_ROUTES_SECTION}" уже существует и не является объектом` };
	}
	const sectionObj = section as Record<string, unknown>;
	let container = sectionObj[ANON_ROUTES_KEY];
	if (container === undefined) {
		container = {};
		sectionObj[ANON_ROUTES_KEY] = container;
	}
	if (typeof container !== "object" || container === null || Array.isArray(container)) {
		return { ok: false, error: `"${ANON_ROUTES_KEY}" уже существует и не является объектом` };
	}
	return { ok: true, container: container as Record<string, unknown> };
}

export function addAnonymousRoute(filePath: string, serviceClassName: string, routes: string[]): EditResult {
	if (!serviceClassName.trim()) {
		return { ok: false, error: "Имя класса сервиса не может быть пустым" };
	}
	const loaded = loadForEdit(filePath);
	if (!loaded) {
		return { ok: false, error: "Не удалось прочитать appsettings.json" };
	}
	const ensured = ensureAnonymousRoutesContainer(loaded.obj);
	if (!ensured.ok) {
		return ensured;
	}
	if (Object.prototype.hasOwnProperty.call(ensured.container, serviceClassName)) {
		return { ok: false, error: `Сервис "${serviceClassName}" уже есть в списке` };
	}
	ensured.container[serviceClassName] = routes;
	writeBack(filePath, loaded);
	return { ok: true };
}

export function renameAnonymousRoute(filePath: string, oldName: string, newName: string): EditResult {
	if (!newName.trim()) {
		return { ok: false, error: "Имя класса сервиса не может быть пустым" };
	}
	const loaded = loadForEdit(filePath);
	if (!loaded) {
		return { ok: false, error: "Не удалось прочитать appsettings.json" };
	}
	const container = anonymousRoutesContainer(loaded.obj);
	if (!container || !Object.prototype.hasOwnProperty.call(container, oldName)) {
		return { ok: false, error: `Сервис "${oldName}" не найден` };
	}
	if (oldName !== newName && Object.prototype.hasOwnProperty.call(container, newName)) {
		return { ok: false, error: `Сервис "${newName}" уже есть в списке` };
	}
	const value = container[oldName];
	delete container[oldName];
	container[newName] = value;
	writeBack(filePath, loaded);
	return { ok: true };
}

export function deleteAnonymousRoute(filePath: string, serviceClassName: string): EditResult {
	const loaded = loadForEdit(filePath);
	if (!loaded) {
		return { ok: false, error: "Не удалось прочитать appsettings.json" };
	}
	const container = anonymousRoutesContainer(loaded.obj);
	if (!container || !Object.prototype.hasOwnProperty.call(container, serviceClassName)) {
		return { ok: false, error: `Сервис "${serviceClassName}" не найден` };
	}
	delete container[serviceClassName];
	writeBack(filePath, loaded);
	return { ok: true };
}
