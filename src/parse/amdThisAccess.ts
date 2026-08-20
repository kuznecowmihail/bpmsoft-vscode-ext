import * as walk from "acorn-walk";
import { AnyNode, childNodes, parseJs } from "./jsAst";
import {
	IDENT_RE,
	defineFactory,
	factoryReturnArg,
	propName,
	isExtDefineCall,
	extDefineParts,
	findSchemaSection,
	isSchemaReturn
} from "./amdAst";

export type ThisMemberAccessKind =
	| "methodCall"
	| "bare"
	| "attribute"
	| "mixin"
	| "mixinMethod"
	| "mixinProperty"
	| "sandboxPublish"
	| "sandboxSubscribe"
	| "diffBindTo";

export interface ThisMemberAccess {
	kind: ThisMemberAccessKind;
	name: string;
	start: number;
	end: number;
	argNames?: string[];
	/** Local mixin name for this.mixins.Name.foo / this.Name.foo */
	mixinName?: string;
}

export type CreateMemberKind = "method" | "property" | "attribute";

export interface TextInsert {
	start: number;
	end: number;
	text: string;
}

const NESTED_THIS_SKIP = new Set(["sandbox", "Ext", "BPMSoft", "mixins"]);

/**
 * All `this.foo` / `this.$Foo` / `this.get("Foo")` / `this.set("Foo"` /
 * `this.mixins.Name` / `this.mixins.Name.foo` /
 * `this.sandbox.publish("Msg")` / `this.sandbox.subscribe("Msg")` /
 * `diff` / `methods` `bindTo: "Name"` accesses.
 * Skips comments/strings (AST) and computed `this[expr]`.
 */
export function collectThisMemberAccesses(
	source: string,
	parsed?: AnyNode
): ThisMemberAccess[] {
	const ast = parsed || parseJs(source);
	if (!ast) {
		return [];
	}
	const out: ThisMemberAccess[] = [];
	walk.ancestor(
		ast,
		{
			MemberExpression(node: AnyNode, ancestors: AnyNode[]) {
				if (node.computed) {
					return;
				}
				const object = node.object as AnyNode;
				const property = node.property as AnyNode;
				if (property?.type !== "Identifier") {
					return;
				}
				const name = property.name as string;
				const start = property.start as number;
				const end = property.end as number;
				const mixinName = mixinNameFromThisMixinsAccess(object);
				if (mixinName) {
					out.push(mixinMemberAccess(name, mixinName, start, end, node, ancestors));
					return;
				}
				if (isThisMixinsMemberExpression(object)) {
					out.push({ kind: "mixin", name, start, end });
					return;
				}
				const directMixin = thisDotIdentifier(object);
				if (
					directMixin &&
					!NESTED_THIS_SKIP.has(directMixin) &&
					!directMixin.startsWith("$")
				) {
					out.push(
						mixinMemberAccess(name, directMixin, start, end, node, ancestors)
					);
					return;
				}
				if (
					directMixin === "sandbox" &&
					(name === "publish" || name === "subscribe")
				) {
					const call = enclosingCall(node, ancestors);
					const msg = callFirstStringLiteral(call);
					if (msg) {
						out.push({
							kind:
								name === "publish" ? "sandboxPublish" : "sandboxSubscribe",
							name: msg.value,
							start: msg.start,
							end: msg.end
						});
					}
					return;
				}
				if (object?.type !== "ThisExpression") {
					return;
				}
				const call = enclosingCall(node, ancestors);
				if (name === "get" || name === "set") {
					const attr = literalStringArg(call);
					if (attr) {
						out.push(attr);
					}
					return;
				}
				if (name.startsWith("$") && name.length > 1) {
					out.push({
						kind: "attribute",
						name: name.slice(1),
						start,
						end
					});
					return;
				}
				if (call) {
					out.push({
						kind: "methodCall",
						name,
						start,
						end,
						argNames: callArgNames(call)
					});
					return;
				}
				out.push({ kind: "bare", name, start, end });
			}
		} as any
	);
	collectSchemaBindToAccesses(ast, out);
	return uniqueAccesses(out);
}

function uniqueAccesses(items: ThisMemberAccess[]): ThisMemberAccess[] {
	const seen = new Set<string>();
	const out: ThisMemberAccess[] = [];
	for (const item of items) {
		const key = `${item.kind}:${item.name}:${item.start}:${item.end}:${item.mixinName ?? ""}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push(item);
	}
	return out;
}

function collectSchemaBindToAccesses(ast: AnyNode, out: ThisMemberAccess[]): void {
	const schema = findSchemaReturnObject(ast);
	if (!schema) {
		return;
	}
	for (const prop of (schema.properties as AnyNode[]) || []) {
		const name = propName(prop);
		if (name === "diff" || name === "methods") {
			walkBindTo(prop.value as AnyNode, out);
		}
	}
}

function walkBindTo(node: AnyNode | undefined, out: ThisMemberAccess[]): void {
	if (!node) {
		return;
	}
	if (node.type === "ObjectExpression") {
		for (const prop of (node.properties as AnyNode[]) || []) {
			if (prop.type === "SpreadElement") {
				walkBindTo(prop.argument as AnyNode, out);
				continue;
			}
			if (propName(prop) === "bindTo") {
				pushDiffBindToAccess(prop.value as AnyNode, out);
			}
			walkBindTo(prop.value as AnyNode, out);
		}
		return;
	}
	if (node.type === "ArrayExpression") {
		for (const el of (node.elements as AnyNode[]) || []) {
			walkBindTo(el, out);
		}
		return;
	}
	for (const child of childNodes(node)) {
		walkBindTo(child, out);
	}
}

function pushDiffBindToAccess(value: AnyNode | undefined, out: ThisMemberAccess[]): void {
	if (!value) {
		return;
	}
	if (value.type === "Literal" && typeof value.value === "string") {
		const name = value.value;
		if (!IDENT_RE.test(name)) {
			return;
		}
		out.push({
			kind: "diffBindTo",
			name,
			start: (value.start as number) + 1,
			end: (value.end as number) - 1
		});
		return;
	}
	if (value.type === "Identifier") {
		const name = value.name as string;
		if (!IDENT_RE.test(name)) {
			return;
		}
		out.push({
			kind: "diffBindTo",
			name,
			start: value.start as number,
			end: value.end as number
		});
	}
}

function isThisMixinsMemberExpression(object: AnyNode | undefined): boolean {
	if (!object || object.type !== "MemberExpression" || object.computed) {
		return false;
	}
	if ((object.object as AnyNode)?.type !== "ThisExpression") {
		return false;
	}
	const inner = object.property as AnyNode;
	return inner?.type === "Identifier" && inner.name === "mixins";
}

function thisDotIdentifier(object: AnyNode | undefined): string | undefined {
	if (!object || object.type !== "MemberExpression" || object.computed) {
		return undefined;
	}
	if ((object.object as AnyNode)?.type !== "ThisExpression") {
		return undefined;
	}
	const inner = object.property as AnyNode;
	return inner?.type === "Identifier" ? (inner.name as string) : undefined;
}

/** `this.mixins.Name` → Name */
function mixinNameFromThisMixinsAccess(object: AnyNode | undefined): string | undefined {
	if (!object || object.type !== "MemberExpression" || object.computed) {
		return undefined;
	}
	if (!isThisMixinsMemberExpression(object.object as AnyNode)) {
		return undefined;
	}
	const inner = object.property as AnyNode;
	return inner?.type === "Identifier" ? (inner.name as string) : undefined;
}

function mixinMemberAccess(
	name: string,
	mixinName: string,
	start: number,
	end: number,
	node: AnyNode,
	ancestors: AnyNode[]
): ThisMemberAccess {
	const call = enclosingCall(node, ancestors);
	if (call) {
		return {
			kind: "mixinMethod",
			name,
			mixinName,
			start,
			end,
			argNames: callArgNames(call)
		};
	}
	return { kind: "mixinProperty", name, mixinName, start, end };
}

/**
 * Insert a new method/property/attribute into the current file's schema
 * section or Ext.define class body.
 */
export function planCreateMemberInsert(
	source: string,
	kind: CreateMemberKind,
	name: string,
	params?: string[],
	dataValueType?: string
): TextInsert | undefined {
	const ast = parseJs(source);
	if (!ast) {
		return undefined;
	}
	const schema = findSchemaReturnObject(ast);
	const unit = detectIndentUnit(source);
	if (schema) {
		return insertInSchemaSection(
			source,
			schema,
			kind === "method" ? "methods" : kind === "property" ? "properties" : "attributes",
			kind,
			name,
			params,
			unit,
			dataValueType
		);
	}
	if (kind === "attribute") {
		return undefined;
	}
	const extBody = findExtClassBody(ast);
	if (extBody) {
		return insertMemberIntoObject(source, extBody, kind, name, params, unit);
	}
	return undefined;
}

function enclosingCall(node: AnyNode, ancestors: AnyNode[]): AnyNode | undefined {
	for (let i = ancestors.length - 2; i >= 0; i--) {
		const parent = ancestors[i];
		if (parent.type === "ChainExpression") {
			continue;
		}
		if (parent.type === "CallExpression") {
			const callee = parent.callee as AnyNode;
			if (callee === node || callee === ancestors[i + 1]) {
				return parent;
			}
		}
		return undefined;
	}
	return undefined;
}

function callFirstStringLiteral(
	call: AnyNode | undefined
): { value: string; start: number; end: number } | undefined {
	if (!call) {
		return undefined;
	}
	const arg0 = (call.arguments as AnyNode[])?.[0];
	if (
		!arg0 ||
		arg0.type !== "Literal" ||
		typeof arg0.value !== "string" ||
		!arg0.value
	) {
		return undefined;
	}
	return {
		value: arg0.value,
		start: arg0.start as number,
		end: arg0.end as number
	};
}

function literalStringArg(call: AnyNode | undefined): ThisMemberAccess | undefined {
	if (!call) {
		return undefined;
	}
	const arg0 = (call.arguments as AnyNode[])?.[0];
	if (!arg0 || arg0.type !== "Literal" || typeof arg0.value !== "string") {
		return undefined;
	}
	const name = arg0.value;
	if (!IDENT_RE.test(name)) {
		return undefined;
	}
	return {
		kind: "attribute",
		name,
		start: (arg0.start as number) + 1,
		end: (arg0.end as number) - 1
	};
}

function callArgNames(call: AnyNode): string[] {
	const args = (call.arguments as AnyNode[]) || [];
	return args.map((arg, i) =>
		arg?.type === "Identifier" ? (arg.name as string) : `arg${i}`
	);
}

function findSchemaReturnObject(ast: AnyNode): AnyNode | undefined {
	let found: AnyNode | undefined;
	walk.simple(ast, {
		CallExpression(node: AnyNode) {
			if (found) {
				return;
			}
			const callee = node.callee as AnyNode;
			if (callee?.type !== "Identifier" || callee.name !== "define") {
				return;
			}
			const returnArg = factoryReturnArg(defineFactory(node));
			if (returnArg?.type === "ObjectExpression" && isSchemaReturn(returnArg)) {
				found = returnArg;
			}
		}
	} as any);
	return found;
}

function findExtClassBody(ast: AnyNode): AnyNode | undefined {
	let found: AnyNode | undefined;
	walk.simple(ast, {
		CallExpression(node: AnyNode) {
			if (found || !isExtDefineCall(node)) {
				return;
			}
			const { classBody } = extDefineParts(node);
			if (classBody?.type === "ObjectExpression") {
				found = classBody;
			}
		}
	} as any);
	return found;
}

function detectIndentUnit(source: string): string {
	const m = source.match(/\n([\t ]+)/);
	if (!m) {
		return "\t";
	}
	if (m[1].includes("\t")) {
		return "\t";
	}
	if (m[1].length % 4 === 0) {
		return "    ";
	}
	if (m[1].length % 2 === 0) {
		return "  ";
	}
	return "\t";
}

function indentAt(source: string, offset: number): string {
	let i = offset;
	while (i > 0 && source[i - 1] !== "\n") {
		i--;
	}
	let j = i;
	while (j < source.length && (source[j] === " " || source[j] === "\t")) {
		j++;
	}
	return source.slice(i, j);
}

function formatCreateMemberText(
	kind: CreateMemberKind,
	name: string,
	params: string[] | undefined,
	indent: string,
	unit: string,
	dataValueType?: string
): string {
	if (kind === "method") {
		const args = (params || []).join(", ");
		return `${name}: function (${args}) {\n${indent}${unit}\n${indent}}`;
	}
	if (kind === "property") {
		return `${name}: null`;
	}
	const typeName = dataValueType || "TEXT";
	return `${name}: {\n${indent}${unit}dataValueType: BPMSoft.DataValueType.${typeName}\n${indent}}`;
}

function insertIntoObject(
	source: string,
	obj: AnyNode,
	inner: string,
	innerIndent: string
): TextInsert | undefined {
	const close = (obj.end as number) - 1;
	if (close < 0 || source[close] !== "}") {
		return undefined;
	}
	const props = (obj.properties as AnyNode[]) || [];
	let comma = "";
	if (props.length) {
		const last = props[props.length - 1];
		const between = source.slice(last.end as number, close);
		if (!between.includes(",")) {
			comma = ",";
		}
	}
	let padStart = close;
	while (padStart > 0 && /[ \t\n\r]/.test(source[padStart - 1])) {
		padStart--;
	}
	const closeIndent = indentAt(source, close);
	return {
		start: padStart,
		end: close,
		text: `${comma}\n${innerIndent}${inner}\n${closeIndent}`
	};
}

function objectPropIndent(source: string, obj: AnyNode, unit: string): string {
	const props = (obj.properties as AnyNode[]) || [];
	return props.length
		? indentAt(source, props[props.length - 1].start as number)
		: indentAt(source, obj.start as number) + unit;
}

function insertInSchemaSection(
	source: string,
	schema: AnyNode,
	sectionName: string,
	kind: CreateMemberKind,
	name: string,
	params: string[] | undefined,
	unit: string,
	dataValueType?: string
): TextInsert | undefined {
	const section = findSchemaSection(schema, sectionName);
	if (section?.type === "ObjectExpression") {
		return insertMemberIntoObject(
			source,
			section,
			kind,
			name,
			params,
			unit,
			dataValueType
		);
	}
	return insertNewSchemaSection(
		source,
		schema,
		sectionName,
		kind,
		name,
		params,
		unit,
		dataValueType
	);
}

function insertMemberIntoObject(
	source: string,
	obj: AnyNode,
	kind: CreateMemberKind,
	name: string,
	params: string[] | undefined,
	unit: string,
	dataValueType?: string
): TextInsert | undefined {
	const innerIndent = objectPropIndent(source, obj, unit);
	const inner = formatCreateMemberText(
		kind,
		name,
		params,
		innerIndent,
		unit,
		dataValueType
	);
	return insertIntoObject(source, obj, inner, innerIndent);
}

function insertNewSchemaSection(
	source: string,
	schema: AnyNode,
	sectionName: string,
	kind: CreateMemberKind,
	name: string,
	params: string[] | undefined,
	unit: string,
	dataValueType?: string
): TextInsert | undefined {
	const sectionIndent = objectPropIndent(source, schema, unit);
	const innerIndent = sectionIndent + unit;
	const member = formatCreateMemberText(
		kind,
		name,
		params,
		innerIndent,
		unit,
		dataValueType
	);
	const section = `${sectionName}: {\n${innerIndent}${member}\n${sectionIndent}}`;
	return insertIntoObject(source, schema, section, sectionIndent);
}
