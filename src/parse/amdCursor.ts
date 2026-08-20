import * as walk from "acorn-walk";
import { AnyNode, parseJs, skipJsString } from "./jsAst";
import { propName } from "./amdAst";

/**
 * Resolve left-hand identifier before `.` at a given offset (simple scan).
 */
export function getMemberAccessPrefix(
	documentText: string,
	offset: number
): string | undefined {
	// Walk back over identifier.chain ending before current position.
	// Caller should pass offset of the character after the last `.` or of the `.` itself.
	let i = offset - 1;
	if (i < 0) {
		return undefined;
	}
	// If we're right after `.`, step onto the left expression
	if (documentText[i] === ".") {
		i--;
	}
	while (i >= 0 && /\s/.test(documentText[i])) {
		i--;
	}
	const end = i + 1;
	while (i >= 0 && /[A-Za-z0-9_$.]/.test(documentText[i])) {
		i--;
	}
	const expr = documentText.slice(i + 1, end).trim();
	if (!expr || !/^[A-Za-z_$][\w.$]*$/.test(expr)) {
		return undefined;
	}
	return expr;
}

/**
 * Word at position for definition/hover (identifier only).
 */
export function getIdentifierAt(
	documentText: string,
	offset: number
): { name: string; start: number; end: number } | undefined {
	if (offset < 0 || offset > documentText.length) {
		return undefined;
	}
	let start = offset;
	let end = offset;
	while (start > 0 && /[A-Za-z0-9_$]/.test(documentText[start - 1])) {
		start--;
	}
	while (end < documentText.length && /[A-Za-z0-9_$]/.test(documentText[end])) {
		end++;
	}
	if (start === end) {
		return undefined;
	}
	return { name: documentText.slice(start, end), start, end };
}

/**
 * Cursor on `this.callParent` — enclosing schema/Ext method name.
 */
export function getCallParentContext(
	documentText: string,
	offset: number
): { methodName: string } | undefined {
	const ident = getIdentifierAt(documentText, offset);
	if (!ident || ident.name !== "callParent") {
		return undefined;
	}
	if (getMemberAccessPrefix(documentText, ident.start) !== "this") {
		return undefined;
	}
	const methodName = enclosingMethodNameAt(documentText, offset);
	if (!methodName) {
		return undefined;
	}
	return { methodName };
}

function enclosingMethodNameAt(
	source: string,
	offset: number
): string | undefined {
	const ast = parseJs(source);
	if (!ast) {
		return undefined;
	}
	let name: string | undefined;
	const visitFn = (node: AnyNode, ancestors: AnyNode[]) => {
		if (name) {
			return;
		}
		if (typeof node.start !== "number" || typeof node.end !== "number") {
			return;
		}
		if (offset < node.start || offset >= node.end) {
			return;
		}
		const parent = ancestors[ancestors.length - 2];
		if (!parent || parent.type !== "Property" || parent.value !== node) {
			return;
		}
		const key = propName(parent);
		if (key) {
			name = key;
		}
	};
	walk.ancestor(
		ast,
		{
			FunctionExpression: visitFn,
			ArrowFunctionExpression: visitFn
		} as any
	);
	return name;
}

export interface ThisGetSetContext {
	method: "get" | "set";
	quote: '"' | "'" | undefined;
	name: string;
	nameStart: number;
	nameEnd: number;
}

/**
 * Cursor inside this.get("…") / this.set("…", …) first argument.
 */
export function getThisGetSetContext(
	documentText: string,
	offset: number
): ThisGetSetContext | undefined {
	const before = documentText.slice(Math.max(0, offset - 300), offset);
	const m = before.match(
		/\bthis\s*\.\s*(get|set)\s*\(\s*(?:(["'])([\w$]*))?$/
	);
	if (!m) {
		return undefined;
	}
	const method = m[1] as "get" | "set";
	const quote = m[2] as '"' | "'" | undefined;
	const typed = m[3] || "";
	if (!quote) {
		return {
			method,
			quote: undefined,
			name: "",
			nameStart: offset,
			nameEnd: offset
		};
	}
	return {
		method,
		quote,
		...nameSpanAt(documentText, offset, typed)
	};
}

export interface ThisSandboxMessageContext {
	method: "publish" | "subscribe";
	quote: '"' | "'" | undefined;
	name: string;
	nameStart: number;
	nameEnd: number;
}

/**
 * Cursor inside this.sandbox.publish("…") / this.sandbox.subscribe("…") first argument.
 * Also matches unquoted typing: this.sandbox.publish(Set|)
 */
export function getThisSandboxMessageContext(
	documentText: string,
	offset: number
): ThisSandboxMessageContext | undefined {
	const before = documentText.slice(Math.max(0, offset - 300), offset);
	const m = before.match(
		/\bthis\s*\.\s*sandbox\s*\.\s*(publish|subscribe)\s*\(\s*(?:(["'])([\w$]*)|([\w$]*))$/
	);
	if (!m) {
		return undefined;
	}
	const method = m[1] as "publish" | "subscribe";
	const quote = (m[2] as '"' | "'" | undefined) || undefined;
	const typed = (quote ? m[3] : m[4]) || "";
	return {
		method,
		quote,
		...nameSpanAt(documentText, offset, typed)
	};
}

export interface DiffBindToContext {
	quote: '"' | "'" | undefined;
	name: string;
	nameStart: number;
	nameEnd: number;
}

/**
 * Cursor inside `bindTo: "Name"` in schema `diff` or `methods`.
 * Keys may be quoted or bare: bindTo / "bindTo".
 */
export function getDiffBindToContext(
	documentText: string,
	offset: number
): DiffBindToContext | undefined {
	const before = documentText.slice(Math.max(0, offset - 400), offset);
	const m = before.match(
		/(?:["']bindTo["']|\bbindTo\b)\s*:\s*(?:(["'])([\w$]*)|([\w$]*))$/
	);
	if (!m || !isInsideBindToSection(documentText, offset)) {
		return undefined;
	}
	const quote = (m[1] as '"' | "'" | undefined) || undefined;
	const typed = (quote ? m[2] : m[3]) || "";
	return {
		quote,
		...nameSpanAt(documentText, offset, typed)
	};
}

function isInsideBindToSection(text: string, offset: number): boolean {
	return (
		isInsideSchemaSection(text, offset, "diff") ||
		isInsideSchemaSection(text, offset, "methods")
	);
}

function isInsideSchemaSection(
	text: string,
	offset: number,
	section: "diff" | "methods"
): boolean {
	const lastEnd = lastSectionKeyColonEnd(text, offset, section);
	if (lastEnd < 0) {
		return false;
	}
	const i = skipWsAndCommentsForward(text, lastEnd, offset);
	if (i >= offset || (text[i] !== "[" && text[i] !== "{")) {
		return false;
	}
	return unclosedBrackets(text, i, offset);
}

/** Last `section:` / `"section":` property key before offset, ignoring comments and other strings. */
function lastSectionKeyColonEnd(
	text: string,
	offset: number,
	section: string
): number {
	let i = 0;
	let last = -1;
	while (i < offset) {
		const skipped = skipComment(text, i, offset);
		if (skipped !== undefined) {
			i = skipped;
			continue;
		}
		const ch = text[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			const start = i;
			i = skipJsString(text, i, offset);
			if (i > start + 1 && text[i - 1] === ch) {
				const content = text.slice(start + 1, i - 1);
				if (content === section) {
					const colon = skipWsAndCommentsForward(text, i, offset);
					if (colon < offset && text[colon] === ":") {
						last = colon + 1;
					}
				}
			}
			continue;
		}
		if (/[A-Za-z_$]/.test(ch)) {
			const start = i;
			i++;
			while (i < offset && /[\w$]/.test(text[i])) {
				i++;
			}
			if (text.slice(start, i) === section) {
				const colon = skipWsAndCommentsForward(text, i, offset);
				if (colon < offset && text[colon] === ":") {
					last = colon + 1;
				}
			}
			continue;
		}
		i++;
	}
	return last;
}

function skipComment(text: string, i: number, end: number): number | undefined {
	if (text[i] !== "/") {
		return undefined;
	}
	if (text[i + 1] === "/") {
		const nl = text.indexOf("\n", i);
		return nl < 0 ? end : nl + 1;
	}
	if (text[i + 1] === "*") {
		const close = text.indexOf("*/", i + 2);
		return close < 0 ? end : close + 2;
	}
	return undefined;
}

function skipWsAndCommentsForward(text: string, i: number, end: number): number {
	while (i < end) {
		const ch = text[i];
		if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
			i++;
			continue;
		}
		const skipped = skipComment(text, i, end);
		if (skipped !== undefined) {
			i = skipped;
			continue;
		}
		break;
	}
	return i;
}

function unclosedBrackets(text: string, start: number, offset: number): boolean {
	let depth = 0;
	let i = start;
	while (i < offset) {
		const skipped = skipComment(text, i, offset);
		if (skipped !== undefined) {
			i = skipped;
			continue;
		}
		const ch = text[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			i = skipJsString(text, i, offset);
			continue;
		}
		if (ch === "[" || ch === "{") {
			depth++;
		} else if (ch === "]" || ch === "}") {
			depth--;
			if (depth <= 0) {
				return false;
			}
		}
		i++;
	}
	return depth > 0;
}

function identEnd(documentText: string, offset: number): number {
	let nameEnd = offset;
	while (
		nameEnd < documentText.length &&
		/[\w$]/.test(documentText[nameEnd])
	) {
		nameEnd++;
	}
	return nameEnd;
}

function nameSpanAt(
	documentText: string,
	offset: number,
	typed: string
): { name: string; nameStart: number; nameEnd: number } {
	const nameEnd = identEnd(documentText, offset);
	return {
		name: typed + documentText.slice(offset, nameEnd),
		nameStart: offset - typed.length,
		nameEnd
	};
}

function skipWsBack(text: string, i: number): number {
	while (i >= 0 && /\s/.test(text[i])) {
		i--;
	}
	return i;
}

function readIdentBack(
	text: string,
	i: number
): { i: number; name: string } | undefined {
	if (i < 0 || !/[A-Za-z0-9_$]/.test(text[i])) {
		return undefined;
	}
	const end = i + 1;
	while (i >= 0 && /[A-Za-z0-9_$]/.test(text[i])) {
		i--;
	}
	return { i, name: text.slice(i + 1, end) };
}

export interface ThisLookupAccessContext {
	attrName: string;
}

/**
 * Cursor after this.$Attr. or this.get("Attr"). — lookup/enum nested fields.
 * Also accepts this.get("Attr". (dot before the auto-closed ')').
 */
export function getThisLookupAccessContext(
	documentText: string,
	offset: number
): ThisLookupAccessContext | undefined {
	let i = skipWsBack(documentText, offset - 1);
	if (i >= 0 && /[A-Za-z0-9_$]/.test(documentText[i])) {
		const field = readIdentBack(documentText, i);
		if (!field) {
			return undefined;
		}
		i = skipWsBack(documentText, field.i);
	}
	if (i < 0 || documentText[i] !== ".") {
		return undefined;
	}
	i = skipWsBack(documentText, i - 1);
	if (i >= 0 && documentText[i] === "?") {
		i = skipWsBack(documentText, i - 1);
	}
	if (i >= 0 && documentText[i] === ")") {
		i = skipWsBack(documentText, i - 1);
	}
	if (i >= 0 && (documentText[i] === '"' || documentText[i] === "'")) {
		const quote = documentText[i];
		i--;
		const nameEnd = i + 1;
		while (
			i >= 0 &&
			documentText[i] !== quote &&
			/[A-Za-z0-9_$]/.test(documentText[i])
		) {
			i--;
		}
		const attrName = documentText.slice(i + 1, nameEnd);
		if (!attrName || documentText[i] !== quote) {
			return undefined;
		}
		i = skipWsBack(documentText, i - 1);
		if (i < 0 || documentText[i] !== "(") {
			return undefined;
		}
		i = skipWsBack(documentText, i - 1);
		const meth = readIdentBack(documentText, i);
		if (!meth || meth.name !== "get") {
			return undefined;
		}
		i = skipWsBack(documentText, meth.i);
		if (i < 0 || documentText[i] !== ".") {
			return undefined;
		}
		i = skipWsBack(documentText, i - 1);
		const obj = readIdentBack(documentText, i);
		if (!obj || obj.name !== "this") {
			return undefined;
		}
		return { attrName };
	}

	const attr = readIdentBack(documentText, i);
	if (!attr?.name.startsWith("$") || attr.name.length < 2) {
		return undefined;
	}
	i = skipWsBack(documentText, attr.i);
	if (i < 0 || documentText[i] !== ".") {
		return undefined;
	}
	i = skipWsBack(documentText, i - 1);
	const obj = readIdentBack(documentText, i);
	if (!obj || obj.name !== "this") {
		return undefined;
	}
	return { attrName: attr.name.slice(1) };
}

/**
 * this.Ext / this.BPMSoft → same lookup as global Ext / BPMSoft.
 */
export function rewriteThisRuntimePrefix(prefix: string): string | undefined {
	if (
		prefix === "this.Ext" ||
		prefix.startsWith("this.Ext.") ||
		prefix === "this.BPMSoft" ||
		prefix.startsWith("this.BPMSoft.")
	) {
		return prefix.slice("this.".length);
	}
	return undefined;
}
