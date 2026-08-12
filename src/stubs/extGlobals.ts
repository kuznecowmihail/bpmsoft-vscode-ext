import * as fs from "fs";
import * as path from "path";
import { PlatformStubMember, MemberKind } from "../index/types";
import { resolveAppLayouts } from "../index/workspaceLayout";

/**
 * Ext.* completions for Creatio/BPMSoft (ExtJS utilities).
 * Static core API + optional extract from Resources/ui/ExtJs/extjs-base-*.js
 */
export function buildExtStubs(workspaceRoots: string[]): PlatformStubMember[] {
	const root = new Map<string, PlatformStubMember>();

	for (const stub of getStaticExtStubs()) {
		root.set(stub.name, cloneStub(stub));
	}

	for (const filePath of findExtBaseFiles(workspaceRoots)) {
		try {
			// Only scan the utility header — full debug build is multi-MB.
			const fd = fs.openSync(filePath, "r");
			const buf = Buffer.alloc(256 * 1024);
			const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
			fs.closeSync(fd);
			const head = buf.slice(0, bytes).toString("utf8");
			for (const member of extractExtApplyMembers(head)) {
				const prev = root.get(member.name);
				if (!prev) {
					root.set(member.name, member);
				} else if (member.children?.length) {
					prev.children = mergeChildren(prev.children || [], member.children);
				}
			}
		} catch {
			// ignore
		}
	}

	return Array.from(root.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function getStaticExtStubs(): PlatformStubMember[] {
	const method = (name: string, detail?: string): PlatformStubMember => ({
		name,
		kind: "method",
		detail: detail || "Ext"
	});
	const prop = (name: string, detail?: string): PlatformStubMember => ({
		name,
		kind: "property",
		detail: detail || "Ext"
	});
	const ns = (
		name: string,
		children: PlatformStubMember[]
	): PlatformStubMember => ({
		name,
		kind: "namespace",
		children
	});

	return [
		method("isEmpty", "(value, allowEmptyString?)"),
		method("isArray", "(value)"),
		method("isObject", "(value)"),
		method("isFunction", "(value)"),
		method("isString", "(value)"),
		method("isNumber", "(value)"),
		method("isNumeric", "(value)"),
		method("isBoolean", "(value)"),
		method("isDate", "(value)"),
		method("isDefined", "(value)"),
		method("isPrimitive", "(value)"),
		method("isElement", "(value)"),
		method("isIterable", "(value)"),
		method("isSimpleObject", "(value)"),
		method("typeOf", "(value)"),
		method("valueFrom", "(value, defaultValue, allowBlank?)"),
		method("coerce", "(from, to)"),
		method("apply", "(object, config, defaults?)"),
		method("applyIf", "(object, config)"),
		method("merge", "(…objects)"),
		method("clone", "(item)"),
		method("copyTo", "(dest, source, names, usePrototypeKeys?)"),
		method("iterate", "(object, fn, scope?)"),
		method("each", "(array, fn, scope?, reverse?)"),
		method("callback", "(callback, scope?, args?, delay?)"),
		method("defer", "(fn, millis, scope?, args?, appendArgs?)"),
		method("pass", "(fn, args, scope?)"),
		method("bind", "(fn, scope, args?, appendArgs?)"),
		method("create", "(name, …args)"),
		method("define", "(className, data, createdFn?)"),
		method("override", "(cls, overrides)"),
		method("widget", "(name, config)"),
		method("get", "(el)"),
		method("getCmp", "(id)"),
		method("getBody", "()"),
		method("getDoc", "()"),
		method("getHead", "()"),
		method("getDom", "(el)"),
		method("fly", "(el, named?)"),
		method("query", "(selector)"),
		method("select", "(selector)"),
		method("encode", "(o) → JSON"),
		method("decode", "(json) → Object"),
		method("id", "(el?, prefix?)"),
		method("ns", "(…namespaces)"),
		method("namespace", "(…namespaces)"),
		prop("emptyFn", "Function"),
		prop("emptyString", "String"),
		prop("identityFn", "Function"),
		ns("String", [
			method("format", "(format, …values)"),
			method("htmlEncode", "(value)"),
			method("htmlDecode", "(value)"),
			method("trim", "(string)"),
			method("urlEncode", "(o, pre?)"),
			method("urlDecode", "(string, overwrite?)"),
			method("ellipsis", "(value, length, word?)"),
			method("escape", "(string)"),
			method("escapeRegex", "(string)"),
			method("leftPad", "(string, size, character?)"),
			method("repeat", "(pattern, count, sep?)"),
			method("toggle", "(string, value, other)"),
			method("startsWith", "(string, start)"),
			method("endsWith", "(string, end)")
		]),
		ns("Array", [
			method("each", "(array, fn, scope?, reverse?)"),
			method("forEach", "(array, fn, scope?)"),
			method("indexOf", "(array, item, from?)"),
			method("contains", "(array, item)"),
			method("toArray", "(iterable, start?, end?)"),
			method("pluck", "(array, propertyName)"),
			method("map", "(array, fn, scope?)"),
			method("filter", "(array, fn, scope?)"),
			method("unique", "(array)"),
			method("clean", "(array)"),
			method("clone", "(array)"),
			method("from", "(value, newReference?)"),
			method("merge", "(…arrays)"),
			method("intersect", "(…arrays)"),
			method("difference", "(arrayA, arrayB)"),
			method("min", "(array, comparisonFn?)"),
			method("max", "(array, comparisonFn?)"),
			method("sum", "(array)"),
			method("mean", "(array)"),
			method("flatten", "(array)"),
			method("sort", "(array, sortFn?)")
		]),
		ns("Object", [
			method("each", "(object, fn, scope?)"),
			method("merge", "(…objects)"),
			method("getKey", "(object, value)"),
			method("getValues", "(object)"),
			method("getKeys", "(object)"),
			method("getSize", "(object)"),
			method("isEmpty", "(object)"),
			method("equals", "(object1, object2)"),
			method("clone", "(object)"),
			method("toQueryString", "(object, recursive?)"),
			method("fromQueryString", "(queryString, recursive?)")
		]),
		ns("Date", [
			method("parse", "(input, format)"),
			method("format", "(date, format)"),
			method("add", "(date, interval, value)"),
			method("diff", "(min, max, unit)"),
			method("between", "(date, start, end)"),
			method("isEqual", "(date1, date2)"),
			method("clone", "(date)"),
			method("clearTime", "(date, clone?)"),
			method("now", "()"),
			prop("defaultFormat", "string")
		]),
		ns("Number", [
			method("constrain", "(number, min, max)"),
			method("toFixed", "(value, precision)"),
			method("from", "(value, defaultValue)")
		]),
		ns("Function", [
			method("bind", "(fn, scope, args?, appendArgs?)"),
			method("pass", "(fn, args, scope?)"),
			method("alias", "(object, methodName)"),
			method("createInterceptor", "(origFn, newFn, scope?, returnValue?)"),
			method("createSequence", "(originalFn, newFn, scope?)"),
			method("createBuffered", "(fn, buffer, scope?, args?)"),
			method("createDelayed", "(fn, delay, scope?, args?)"),
			method("createThrottled", "(fn, interval, scope?)"),
			method("defer", "(fn, millis, scope?, args?, appendArgs?)"),
			method("flexSetter", "(setter)")
		]),
		ns("JSON", [method("encode", "(o)"), method("decode", "(json)")]),
		ns("dom", [
			method("Query", "Ext.dom.Query"),
			method("Element", "Ext.dom.Element")
		])
	];
}

function findExtBaseFiles(roots: string[]): string[] {
	const layouts = resolveAppLayouts(roots);
	const rels = [
		"ui/ExtJs/extjs-base-debug.js",
		"ui/ExtJs/extjs-base-release.js",
		"ui/ExtJs/extjs5-base-debug.js"
	];
	const out: string[] = [];
	const resourceRoots = layouts
		.map((l) => l.resourcesRoot)
		.filter((p): p is string => Boolean(p));
	if (!resourceRoots.length) {
		for (const root of roots) {
			resourceRoots.push(path.join(root, "Resources"));
		}
	}
	for (const resourcesRoot of resourceRoots) {
		for (const rel of rels) {
			const full = path.join(resourcesRoot, rel);
			if (fs.existsSync(full)) {
				out.push(full);
			}
		}
	}
	return out;
}

/**
 * Pull top-level keys from Ext.apply(Ext, { … }) object literals in a source chunk.
 */
function extractExtApplyMembers(source: string): PlatformStubMember[] {
	const out: PlatformStubMember[] = [];
	const marker = /Ext\.apply\(\s*Ext\s*,\s*\{/g;
	let match: RegExpExecArray | null;
	while ((match = marker.exec(source))) {
		const start = match.index + match[0].length - 1;
		const obj = sliceBalancedObject(source, start);
		if (!obj) {
			continue;
		}
		for (const name of extractObjectKeys(obj)) {
			if (name.startsWith("_") || name === "name") {
				continue;
			}
			const kind: MemberKind =
				new RegExp(`${name}\\s*:\\s*function`).test(obj) ||
				new RegExp(`${name}\\s*:\\s*\\(`).test(obj)
					? "method"
					: "property";
			out.push({ name, kind, detail: "Ext" });
		}
	}
	return out;
}

function sliceBalancedObject(source: string, openBraceIndex: number): string | null {
	if (source[openBraceIndex] !== "{") {
		return null;
	}
	let depth = 0;
	let inStr: string | null = null;
	let escaped = false;
	for (let i = openBraceIndex; i < source.length; i++) {
		const ch = source[i];
		if (inStr) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === inStr) {
				inStr = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			inStr = ch;
			continue;
		}
		if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) {
				return source.slice(openBraceIndex, i + 1);
			}
		}
	}
	return null;
}

function extractObjectKeys(objectLiteral: string): string[] {
	const keys: string[] = [];
	const body = objectLiteral.slice(1, -1);
	const keyRe = /(?:^|[,{])\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:\/\/[^\n]*\n\s*)*([A-Za-z_$][\w$]*)\s*:/g;
	let m: RegExpExecArray | null;
	while ((m = keyRe.exec(body))) {
		keys.push(m[1]);
	}
	return Array.from(new Set(keys));
}

function mergeChildren(
	existing: PlatformStubMember[],
	incoming: PlatformStubMember[]
): PlatformStubMember[] {
	const map = new Map<string, PlatformStubMember>();
	for (const c of existing) {
		map.set(c.name, c);
	}
	for (const c of incoming) {
		if (!map.has(c.name)) {
			map.set(c.name, c);
		}
	}
	return Array.from(map.values());
}

function cloneStub(s: PlatformStubMember): PlatformStubMember {
	return {
		name: s.name,
		kind: s.kind,
		detail: s.detail,
		documentation: s.documentation,
		children: s.children?.map(cloneStub)
	};
}
