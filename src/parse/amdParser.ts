import * as acorn from "acorn";
import * as walk from "acorn-walk";
import {
	IndexedMember,
	IndexedModule,
	IndexedSchemaMessage,
	MemberKind,
	SchemaMessageDirection,
	memberDedupeKey
} from "../index/types";
import { AnyNode, childNodes, parseJs, posFromNode, leadingComment } from "./jsAst";

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

function defineFactory(call: AnyNode): AnyNode | undefined {
	const args = call.arguments as AnyNode[];
	if (args.length >= 2 && args[1].type === "ArrayExpression") {
		return args[2];
	}
	return args[1];
}

function isFunctionNode(node: AnyNode | undefined): boolean {
	return (
		node?.type === "FunctionExpression" ||
		node?.type === "ArrowFunctionExpression"
	);
}

/** BPMSoft.emptyFn / this.BPMSoft.emptyFn / Ext.emptyFn — stub method, not a property. */
function isEmptyFnRef(node: AnyNode | undefined): boolean {
	if (!node) {
		return false;
	}
	if (node.type === "Identifier") {
		return node.name === "emptyFn";
	}
	if (node.type !== "MemberExpression" || node.computed) {
		return false;
	}
	const prop = node.property as AnyNode;
	return prop?.type === "Identifier" && prop.name === "emptyFn";
}

function isMethodValue(node: AnyNode | undefined): boolean {
	return isFunctionNode(node) || isEmptyFnRef(node);
}

function factoryReturnArg(factory: AnyNode | undefined): AnyNode | undefined {
	if (!factory || !isFunctionNode(factory)) {
		return undefined;
	}
	const body = factory.body as AnyNode;
	if (body.type !== "BlockStatement") {
		return body;
	}
	let returnArg: AnyNode | undefined;
	for (const stmt of body.body as AnyNode[]) {
		if (stmt.type === "ReturnStatement" && stmt.argument) {
			returnArg = stmt.argument as AnyNode;
		}
	}
	return returnArg;
}

function propName(prop: AnyNode): string | undefined {
	if (!prop || prop.type !== "Property") {
		return undefined;
	}
	const key = prop.key;
	if (!key) {
		return undefined;
	}
	if (key.type === "Identifier") {
		return key.name as string;
	}
	if (key.type === "Literal" && typeof key.value === "string") {
		return key.value;
	}
	return undefined;
}

function inferMemberKind(value: AnyNode | undefined): MemberKind {
	if (!value) {
		return "property";
	}
	if (isMethodValue(value)) {
		return "method";
	}
	if (value.type === "ObjectExpression") {
		return "enum";
	}
	return "const";
}

function functionParamNames(value: AnyNode | undefined): string[] | undefined {
	if (!value || !isFunctionNode(value)) {
		return undefined;
	}
	const names: string[] = [];
	for (const p of (value.params as AnyNode[]) || []) {
		if (p.type === "Identifier") {
			names.push(p.name as string);
		} else if (p.type === "RestElement") {
			const arg = p.argument as AnyNode;
			if (arg?.type === "Identifier") {
				names.push(`...${arg.name}`);
			}
		}
	}
	return names;
}

function collectObjectMembers(
	obj: AnyNode,
	comments: acorn.Comment[],
	filter?: (name: string, value: AnyNode) => boolean
): IndexedMember[] {
	const members: IndexedMember[] = [];
	if (!obj || obj.type !== "ObjectExpression") {
		return members;
	}
	for (const prop of obj.properties as AnyNode[]) {
		const name = propName(prop);
		if (!name) {
			continue;
		}
		const value = prop.value as AnyNode;
		if (filter && !filter(name, value)) {
			continue;
		}
		members.push({
			name,
			kind: inferMemberKind(value),
			documentation: leadingComment(comments, prop, 80),
			position: posFromNode(prop.key ?? prop),
			params: functionParamNames(value)
		});
	}
	return members;
}

function extractMixinsFromValue(mixinsVal: AnyNode | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	if (!mixinsVal) {
		return result;
	}
	if (mixinsVal.type === "ObjectExpression") {
		for (const m of mixinsVal.properties as AnyNode[]) {
			const local = propName(m);
			const val = m.value as AnyNode;
			if (!local || !val || val.type !== "Literal") {
				continue;
			}
			if (typeof val.value === "string") {
				result[local] = val.value;
			}
		}
		return result;
	}
	if (mixinsVal.type === "ArrayExpression") {
		let i = 0;
		for (const el of mixinsVal.elements as AnyNode[]) {
			if (el?.type === "Literal" && typeof el.value === "string") {
				result[`mixin${i++}`] = el.value;
			}
		}
	}
	return result;
}

function extractMixins(returnObj: AnyNode): Record<string, string> {
	if (!returnObj || returnObj.type !== "ObjectExpression") {
		return {};
	}
	for (const prop of returnObj.properties as AnyNode[]) {
		if (propName(prop) === "mixins") {
			return extractMixinsFromValue(prop.value as AnyNode);
		}
	}
	return {};
}

function memberTailName(node: AnyNode | undefined): string | undefined {
	if (!node) {
		return undefined;
	}
	if (node.type === "Identifier") {
		return node.name as string;
	}
	if (node.type === "MemberExpression" && !node.computed) {
		const prop = node.property as AnyNode;
		if (prop?.type === "Identifier") {
			return prop.name as string;
		}
	}
	return undefined;
}

function parseMessageDirection(node: AnyNode | undefined): SchemaMessageDirection | undefined {
	const tail = memberTailName(node);
	if (tail === "PUBLISH") {
		return "publish";
	}
	if (tail === "SUBSCRIBE") {
		return "subscribe";
	}
	if (tail === "BIDIRECTIONAL") {
		return "bidirectional";
	}
	return undefined;
}

function extractMessagesFromValue(
	messagesVal: AnyNode | undefined,
	filePath: string,
	comments: acorn.Comment[]
): Record<string, IndexedSchemaMessage> {
	const result: Record<string, IndexedSchemaMessage> = {};
	if (!messagesVal || messagesVal.type !== "ObjectExpression") {
		return result;
	}
	for (const prop of messagesVal.properties as AnyNode[]) {
		const name = propName(prop);
		const value = prop.value as AnyNode;
		if (!name || !value || value.type !== "ObjectExpression") {
			continue;
		}
		let direction: SchemaMessageDirection | undefined;
		for (const inner of value.properties as AnyNode[]) {
			if (propName(inner) === "direction") {
				direction = parseMessageDirection(inner.value as AnyNode);
				break;
			}
		}
		if (!direction) {
			continue;
		}
		result[name] = {
			name,
			direction,
			position: posFromNode(prop.key ?? prop),
			filePath,
			documentation: leadingComment(comments, prop, 80)
		};
	}
	return result;
}

function extractMessages(
	returnObj: AnyNode,
	filePath: string,
	comments: acorn.Comment[]
): Record<string, IndexedSchemaMessage> {
	if (!returnObj || returnObj.type !== "ObjectExpression") {
		return {};
	}
	for (const prop of returnObj.properties as AnyNode[]) {
		if (propName(prop) === "messages") {
			return extractMessagesFromValue(prop.value as AnyNode, filePath, comments);
		}
	}
	return {};
}

function stringProp(obj: AnyNode, key: string): string | undefined {
	return findStringProp(obj, key)?.value;
}

function findStringProp(
	obj: AnyNode,
	key: string
): { value: string; prop: AnyNode } | undefined {
	if (!obj || obj.type !== "ObjectExpression") {
		return undefined;
	}
	for (const prop of obj.properties as AnyNode[]) {
		if (propName(prop) !== key) {
			continue;
		}
		const v = prop.value as AnyNode;
		if (v?.type === "Literal" && typeof v.value === "string") {
			return { value: v.value, prop };
		}
	}
	return undefined;
}

const EXT_DEFINE_META_KEYS = new Set([
	"extend",
	"override",
	"mixins",
	"messages",
	"alternateClassName",
	"statics",
	"inheritableStatics",
	"requires",
	"uses",
	"alias",
	"xtype",
	"singleton",
	"columns"
]);

/**
 * Apply Ext.define(className, { ... }) onto an IndexedModule.
 */
function applyExtDefine(
	module: IndexedModule,
	className: string | undefined,
	classBody: AnyNode,
	comments: acorn.Comment[]
): void {
	if (className) {
		module.className = className;
	}
	if (module.kind === "amd" || module.kind === "unknown") {
		module.kind = "class";
	}

	const alternate = stringProp(classBody, "alternateClassName");
	if (alternate) {
		module.alternateClassName = alternate;
	}
	const override = stringProp(classBody, "override");
	if (override) {
		module.override = override;
	}
	const extend = stringProp(classBody, "extend");
	if (extend) {
		module.extend = extend;
	}
	Object.assign(module.mixins, extractMixins(classBody));
	Object.assign(module.messages, extractMessages(classBody, module.filePath, comments));

	for (const prop of classBody.properties as AnyNode[]) {
		const n = propName(prop);
		if (!n || EXT_DEFINE_META_KEYS.has(n)) {
			continue;
		}
		const value = prop.value as AnyNode;
		const isMethod = isMethodValue(value);
		module.members.push({
			name: n,
			kind: isMethod ? "method" : "property",
			documentation:
				leadingComment(comments, prop, 80) ||
				(isMethod ? undefined : literalPreview(value)),
			position: posFromNode(prop.key ?? prop),
			params: isMethod ? functionParamNames(value) : undefined
		});
	}

	const bindings = collectViewModelAssignments(classBody);
	if (bindings.length) {
		module.viewModelBindings = uniqueNames(
			module.viewModelBindings,
			bindings
		);
	}

	if (className && !module.alternateClassName && !module.override) {
		const short = className.split(".").pop();
		if (short) {
			module.alternateClassName = `BPMSoft.${short}`;
		}
	}
}

function uniqueNames(prev: string[] | undefined, extra: string[]): string[] {
	const out = prev ? [...prev] : [];
	const seen = new Set(out);
	for (const name of extra) {
		if (!seen.has(name)) {
			seen.add(name);
			out.push(name);
		}
	}
	return out;
}

/**
 * `viewModel.foo = this.foo.bind(this)` / `this.viewModel.foo = this.foo`
 * inside Ext.define methods — members copied onto the schema view model.
 */
function collectViewModelAssignments(classBody: AnyNode): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	const visit = (node: AnyNode | undefined) => {
		if (!node) {
			return;
		}
		if (node.type === "AssignmentExpression") {
			const name = viewModelThisAssignName(node);
			if (name && IDENT_RE.test(name) && !seen.has(name)) {
				seen.add(name);
				names.push(name);
			}
		}
		for (const child of childNodes(node)) {
			visit(child);
		}
	};
	if (classBody.type !== "ObjectExpression") {
		return names;
	}
	for (const prop of classBody.properties as AnyNode[]) {
		const value = prop.value as AnyNode;
		if (isMethodValue(value)) {
			visit(value);
		}
	}
	return names;
}

function viewModelThisAssignName(node: AnyNode): string | undefined {
	const leftName = memberNameIfRoot(node.left as AnyNode, isViewModelRoot);
	if (!leftName) {
		return undefined;
	}
	const fromThis = memberNameIfRoot(unwrapBindCall(node.right as AnyNode), isThisIdent);
	if (!fromThis) {
		return undefined;
	}
	return leftName;
}

function unwrapBindCall(node: AnyNode | undefined): AnyNode | undefined {
	if (!node || node.type !== "CallExpression") {
		return node;
	}
	const callee = node.callee as AnyNode;
	if (
		callee?.type === "MemberExpression" &&
		!callee.computed &&
		(callee.property as AnyNode)?.type === "Identifier" &&
		(callee.property as AnyNode).name === "bind"
	) {
		return callee.object as AnyNode;
	}
	return node;
}

function isThisIdent(node: AnyNode | undefined): boolean {
	return node?.type === "ThisExpression";
}

function isViewModelRoot(node: AnyNode | undefined): boolean {
	if (!node) {
		return false;
	}
	if (node.type === "Identifier" && node.name === "viewModel") {
		return true;
	}
	return (
		node.type === "MemberExpression" &&
		!node.computed &&
		isThisIdent(node.object as AnyNode) &&
		(node.property as AnyNode)?.type === "Identifier" &&
		(node.property as AnyNode).name === "viewModel"
	);
}

function memberNameIfRoot(
	node: AnyNode | undefined,
	isRoot: (obj: AnyNode | undefined) => boolean
): string | undefined {
	if (!node || node.type !== "MemberExpression" || !isRoot(node.object as AnyNode)) {
		return undefined;
	}
	const prop = node.property as AnyNode;
	if (!node.computed && prop?.type === "Identifier") {
		return prop.name as string;
	}
	if (node.computed && prop?.type === "Literal" && typeof prop.value === "string") {
		return prop.value;
	}
	return undefined;
}

function isExtDefineCall(node: AnyNode): boolean {
	const callee = node.callee as AnyNode;
	return (
		callee?.type === "MemberExpression" &&
		(callee.object as AnyNode)?.type === "Identifier" &&
		(callee.object as AnyNode).name === "Ext" &&
		(callee.property as AnyNode)?.type === "Identifier" &&
		(callee.property as AnyNode).name === "define"
	);
}

function isSandboxRegisterMessagesCall(node: AnyNode): boolean {
	const callee = node.callee as AnyNode;
	if (callee?.type !== "MemberExpression") {
		return false;
	}
	const prop = callee.property as AnyNode;
	if (prop?.type !== "Identifier" || prop.name !== "registerMessages") {
		return false;
	}
	const obj = callee.object as AnyNode;
	if (obj?.type !== "MemberExpression") {
		return false;
	}
	const sandboxProp = obj.property as AnyNode;
	if (sandboxProp?.type !== "Identifier" || sandboxProp.name !== "sandbox") {
		return false;
	}
	return (obj.object as AnyNode)?.type === "ThisExpression";
}

function extDefineParts(node: AnyNode): {
	className?: string;
	classBody?: AnyNode;
} {
	const extArgs = node.arguments as AnyNode[];
	const className =
		extArgs[0]?.type === "Literal" && typeof extArgs[0].value === "string"
			? (extArgs[0].value as string)
			: undefined;
	const classBody =
		extArgs.length >= 2 && extArgs[1].type === "ObjectExpression"
			? (extArgs[1] as AnyNode)
			: extArgs.length >= 3 && extArgs[2].type === "ObjectExpression"
				? (extArgs[2] as AnyNode)
				: undefined;
	return { className, classBody };
}

function findSchemaSection(returnObj: AnyNode, key: string): AnyNode | undefined {
	if (!returnObj || returnObj.type !== "ObjectExpression") {
		return undefined;
	}
	for (const prop of returnObj.properties as AnyNode[]) {
		if (propName(prop) === key) {
			return prop.value as AnyNode;
		}
	}
	return undefined;
}

function literalPreview(value: AnyNode | undefined): string | undefined {
	if (!value || value.type !== "Literal") {
		return undefined;
	}
	if (typeof value.value === "string") {
		return `"${value.value}"`;
	}
	if (
		typeof value.value === "number" ||
		typeof value.value === "boolean" ||
		value.value === null
	) {
		return String(value.value);
	}
	return undefined;
}

function collectSchemaProperties(
	obj: AnyNode,
	comments: acorn.Comment[]
): IndexedMember[] {
	const members: IndexedMember[] = [];
	if (!obj || obj.type !== "ObjectExpression") {
		return members;
	}
	for (const prop of obj.properties as AnyNode[]) {
		const name = propName(prop);
		if (!name) {
			continue;
		}
		const value = prop.value as AnyNode;
		members.push({
			name,
			kind: inferMemberKind(value) === "method" ? "method" : "property",
			documentation: leadingComment(comments, prop, 80) || literalPreview(value),
			position: posFromNode(prop.key ?? prop),
			params: functionParamNames(value)
		});
	}
	return members;
}

function exprPreview(node: AnyNode | undefined, depth = 0): string | undefined {
	if (!node || depth > 6) {
		return undefined;
	}
	if (node.type === "Literal") {
		return literalPreview(node);
	}
	if (node.type === "Identifier") {
		return node.name as string;
	}
	if (node.type === "MemberExpression" && !node.computed) {
		const obj = exprPreview(node.object as AnyNode, depth + 1);
		const prop = (node.property as AnyNode)?.name as string | undefined;
		if (obj && prop) {
			return `${obj}.${prop}`;
		}
	}
	return undefined;
}

function attributeDataValueType(value: AnyNode | undefined): string | undefined {
	if (!value || value.type !== "ObjectExpression") {
		return undefined;
	}
	for (const p of value.properties as AnyNode[]) {
		if (propName(p) === "dataValueType") {
			return exprPreview(p.value as AnyNode);
		}
	}
	return undefined;
}

function isLookupOrEnumDataValueType(preview: string | undefined): boolean {
	if (!preview) {
		return false;
	}
	const leaf = (preview.split(".").pop() || preview).replace(/^["']|["']$/g, "");
	return leaf === "LOOKUP" || leaf === "ENUM" || leaf === "10" || leaf === "11";
}

function isLookupFlag(value: AnyNode | undefined): boolean {
	if (!value || value.type !== "ObjectExpression") {
		return false;
	}
	for (const p of value.properties as AnyNode[]) {
		if (propName(p) !== "isLookup") {
			continue;
		}
		const v = p.value as AnyNode;
		return v?.type === "Literal" && v.value === true;
	}
	return false;
}

function attributeHasLookupFields(value: AnyNode | undefined): boolean {
	return (
		isLookupOrEnumDataValueType(attributeDataValueType(value)) ||
		isLookupFlag(value)
	);
}

function lookupEnumFieldMembers(): IndexedMember[] {
	return [
		{
			name: "value",
			kind: "property",
			detail: "lookup/enum",
			documentation: "Идентификатор / код значения"
		},
		{
			name: "displayValue",
			kind: "property",
			detail: "lookup/enum",
			documentation: "Отображаемое значение"
		}
	];
}

function attributeDocumentation(
	value: AnyNode | undefined,
	comments: acorn.Comment[],
	prop: AnyNode
): string | undefined {
	const comment = leadingComment(comments, prop, 80);
	const bits: string[] = [];
	if (value?.type === "ObjectExpression") {
		for (const key of ["dataValueType", "type", "value", "referenceSchemaName", "isRequired"]) {
			for (const p of value.properties as AnyNode[]) {
				if (propName(p) !== key) {
					continue;
				}
				const preview = exprPreview(p.value as AnyNode);
				if (preview) {
					bits.push(`${key}: ${preview}`);
				}
			}
		}
	}
	if (attributeHasLookupFields(value)) {
		bits.push("fields: value, displayValue");
	}
	const meta = bits.join("\n");
	if (comment && meta) {
		return `${comment}\n\n${meta}`;
	}
	return comment || meta || undefined;
}

function collectSchemaAttributes(
	obj: AnyNode,
	comments: acorn.Comment[]
): IndexedMember[] {
	const members: IndexedMember[] = [];
	if (!obj || obj.type !== "ObjectExpression") {
		return members;
	}
	for (const prop of obj.properties as AnyNode[]) {
		const name = propName(prop);
		if (!name) {
			continue;
		}
		const value = prop.value as AnyNode;
		members.push({
			name,
			kind: "attribute",
			documentation: attributeDocumentation(value, comments, prop),
			position: posFromNode(prop.key ?? prop),
			children: attributeHasLookupFields(value)
				? lookupEnumFieldMembers()
				: undefined
		});
	}
	return members;
}

function isSchemaReturn(obj: AnyNode): boolean {
	if (!obj || obj.type !== "ObjectExpression") {
		return false;
	}
	const names = new Set(
		(obj.properties as AnyNode[])
			.map((p) => propName(p))
			.filter(Boolean) as string[]
	);
	return (
		names.has("methods") ||
		names.has("properties") ||
		names.has("attributes") ||
		names.has("entitySchemaName") ||
		names.has("diff") ||
		names.has("messages") ||
		names.has("mixins")
	);
}

function parseDefineCall(
	call: AnyNode,
	comments: acorn.Comment[],
	filePath: string
): IndexedModule | undefined {
	const args = call.arguments as AnyNode[];
	if (!args.length) {
		return undefined;
	}
	const nameArg = args[0];
	if (nameArg?.type !== "Literal" || typeof nameArg.value !== "string") {
		return undefined;
	}
	const moduleName = nameArg.value as string;

	let deps: string[] = [];
	if (args.length >= 2 && args[1].type === "ArrayExpression") {
		deps = (args[1].elements as AnyNode[])
			.filter((e) => e && e.type === "Literal" && typeof e.value === "string")
			.map((e) => e.value as string)
			.filter((d) => !d.startsWith("css!") && !d.startsWith("text!"));
	}
	const factory = defineFactory(call);

	const paramNames: string[] = [];
	if (factory && isFunctionNode(factory)) {
		for (const p of (factory.params as AnyNode[]) || []) {
			if (p.type === "Identifier") {
				paramNames.push(p.name as string);
			}
		}
	}

	const module: IndexedModule = {
		name: moduleName,
		filePath,
		kind: "amd",
		dependencies: deps,
		paramNames,
		members: [],
		mixins: {},
		messages: {}
	};

	if (!factory || !isFunctionNode(factory)) {
		return module;
	}

	const body = factory.body as AnyNode;
	const returnArg = factoryReturnArg(factory);

	// Ext.define inside factory (mixins / overrides / controls)
	walk.simple(body, {
		CallExpression(node: AnyNode) {
			if (isSandboxRegisterMessagesCall(node)) {
				const args = node.arguments as AnyNode[];
				Object.assign(
					module.messages,
					extractMessagesFromValue(args[0], filePath, comments)
				);
				return;
			}
			if (!isExtDefineCall(node)) {
				return;
			}
			const { className, classBody } = extDefineParts(node);
			if (!classBody) {
				return;
			}
			applyExtDefine(module, className, classBody, comments);
			if (module.override || module.extend) {
				module.kind = module.override ? "class" : module.kind;
			} else if (module.kind === "class") {
				module.kind = "mixin";
			}
		}
	} as any);

	if (returnArg && returnArg.type === "ObjectExpression") {
		if (isSchemaReturn(returnArg)) {
			module.kind = module.kind === "mixin" || module.kind === "class" ? module.kind : "page";
			Object.assign(module.mixins, extractMixins(returnArg));
			Object.assign(module.messages, extractMessages(returnArg, module.filePath, comments));
			const entityProp = findStringProp(returnArg, "entitySchemaName");
			if (entityProp) {
				module.entitySchemaName = entityProp.value;
				module.members.push({
					name: "entitySchemaName",
					kind: "property",
					detail: entityProp.value,
					documentation: `Имя объекта страницы: "${entityProp.value}"`,
					position: posFromNode(entityProp.prop.key ?? entityProp.prop),
					filePath
				});
			}
			const methodsObj = findSchemaSection(returnArg, "methods");
			if (methodsObj) {
				module.members.push(
					...collectObjectMembers(methodsObj, comments, (_n, v) => {
						return isMethodValue(v);
					})
				);
			}
			const propertiesObj = findSchemaSection(returnArg, "properties");
			if (propertiesObj) {
				module.members.push(
					...collectSchemaProperties(propertiesObj, comments)
				);
			}
			const attributesObj = findSchemaSection(returnArg, "attributes");
			if (attributesObj) {
				module.members.push(
					...collectSchemaAttributes(attributesObj, comments)
				);
			}
		} else if (!module.members.length) {
			module.kind = "constants";
			module.members.push(...collectObjectMembers(returnArg, comments));
		}
	}

	// de-dupe members by name (attributes keep a parallel $Name slot)
	const seen = new Set<string>();
	module.members = module.members.filter((m) => {
		const key = memberDedupeKey(m);
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});

	return module;
}

/**
 * Parse a BPMSoft AMD schema / Ext class file into an IndexedModule.
 */
export function parseAmdModule(
	source: string,
	filePath: string
): IndexedModule | undefined {
	const parsed = parseAmdAst(source, filePath);
	return parsed?.module;
}

/** Parse once: module index + AST for diagnostics / this-access collection. */
export function parseAmdAst(
	source: string,
	filePath: string
): { module: IndexedModule; ast: AnyNode } | undefined {
	const comments: acorn.Comment[] = [];
	const ast = parseJs(source, comments);
	if (!ast) {
		return undefined;
	}
	const module = indexAmdAst(ast, comments, filePath);
	return module ? { module, ast } : undefined;
}

function indexAmdAst(
	ast: AnyNode,
	comments: acorn.Comment[],
	filePath: string
): IndexedModule | undefined {
	let found: IndexedModule | undefined;
	walk.simple(ast, {
		CallExpression(node: AnyNode) {
			if (found) {
				return;
			}
			const callee = node.callee as AnyNode;
			if (callee?.type === "Identifier" && callee.name === "define") {
				found = parseDefineCall(node, comments, filePath);
			}
		}
	} as any);

	if (found) {
		return found;
	}

	// Platform UI / pure Ext.define files (e.g. Resources/ui/.../grid.js)
	walk.simple(ast, {
		CallExpression(node: AnyNode) {
			if (found || !isExtDefineCall(node)) {
				return;
			}
			const { className, classBody } = extDefineParts(node);
			if (!classBody || !className) {
				return;
			}
			const module: IndexedModule = {
				name: className,
				filePath,
				kind: "class",
				dependencies: [],
				paramNames: [],
				members: [],
				mixins: {},
				messages: {},
				className
			};
			applyExtDefine(module, className, classBody, comments);
			const seen = new Set<string>();
			module.members = module.members.filter((m) => {
				const key = memberDedupeKey(m);
				if (seen.has(key)) {
					return false;
				}
				seen.add(key);
				return true;
			});
			found = module;
		}
	} as any);

	return found;
}

/**
 * Columns from conf/content/{Entity}.js (Ext.define … columns: { Name: { dataValueType } }).
 */
export function parseEntityColumns(
	source: string,
	filePath: string
): IndexedMember[] {
	const comments: acorn.Comment[] = [];
	const ast = parseJs(source.replace(/^\uFEFF/, ""), comments);
	if (!ast) {
		return [];
	}
	let columns: IndexedMember[] = [];
	walk.simple(ast, {
		CallExpression(node: AnyNode) {
			if (columns.length || !isExtDefineCall(node)) {
				return;
			}
			const { classBody } = extDefineParts(node);
			if (!classBody) {
				return;
			}
			const columnsObj = findSchemaSection(classBody, "columns");
			if (columnsObj) {
				columns = collectSchemaAttributes(columnsObj, comments);
			}
		}
	} as any);
	return columns;
}

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

export interface OverrideInsertContext {
	kind: "methods" | "class";
	typed: string;
	identStart: number;
	identEnd: number;
}

/**
 * Cursor is at an object-key in schema `methods: { }` or Ext.define class body.
 */
export function getOverrideInsertContext(
	documentText: string,
	offset: number
): OverrideInsertContext | undefined {
	if (offset < 0 || offset > documentText.length) {
		return undefined;
	}
	const key = objectKeyPrefix(documentText, offset);
	if (!key) {
		return undefined;
	}
	const scope = scanOverrideScope(documentText, key.identStart);
	if (scope && scope.methodsDepth >= 0 && scope.braceDepth === scope.methodsDepth) {
		return { ...key, kind: "methods" };
	}
	if (scope && scope.classBodyDepth >= 0 && scope.braceDepth === scope.classBodyDepth) {
		return { ...key, kind: "class" };
	}
	return undefined;
}

export function formatOverrideSnippet(
	owner: string,
	name: string,
	params: string[] = []
): string {
	const args = params.join(", ");
	return [
		"/**",
		` * @inheritdoc ${owner}#${name}`,
		" * @overriden",
		" */",
		`${name}: function (${args}) {`,
		"\t$0",
		"},"
	].join("\n");
}

/**
 * Method names already declared in this file's `methods: { }` or Ext.define body.
 * The identifier currently being typed is not included.
 */
export function collectLocalMethodKeys(
	documentText: string,
	skipStart = -1,
	skipEnd = -1
): Set<string> {
	const keys = new Set<string>();
	let braceDepth = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let methodsDepth = -1;
	let classBodyDepth = -1;
	let extDefineParen = -1;
	let lastIdent = "";
	let lastIdentStart = -1;
	let pendingKey = "";
	let afterDot = false;
	let i = 0;
	const end = documentText.length;

	const setIdent = (name: string, start: number) => {
		if (afterDot && lastIdent === "Ext" && name === "define") {
			lastIdent = "Ext.define";
			lastIdentStart = -1;
		} else {
			lastIdent = name;
			lastIdentStart = start;
		}
		afterDot = false;
	};

	const atMemberDepth = () =>
		(methodsDepth >= 0 && braceDepth === methodsDepth) ||
		(classBodyDepth >= 0 && braceDepth === classBodyDepth);

	while (i < end) {
		const ch = documentText[i];
		const next = documentText[i + 1];

		if (ch === "/" && next === "/") {
			i += 2;
			while (i < end && documentText[i] !== "\n") {
				i++;
			}
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i + 1 < end && !(documentText[i] === "*" && documentText[i + 1] === "/")) {
				i++;
			}
			i = Math.min(end, i + 2);
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			i = skipJsString(documentText, i, end);
			pendingKey = "";
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			continue;
		}

		if (/[A-Za-z_$]/.test(ch)) {
			let j = i + 1;
			while (j < end && /[A-Za-z0-9_$]/.test(documentText[j])) {
				j++;
			}
			setIdent(documentText.slice(i, j), i);
			i = j;
			continue;
		}

		if (ch === ".") {
			afterDot = lastIdent === "Ext";
			i++;
			continue;
		}

		if (ch === "(") {
			parenDepth++;
			if (lastIdent === "Ext.define") {
				extDefineParen = parenDepth;
			}
			pendingKey = "";
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			i++;
			continue;
		}
		if (ch === ")") {
			if (parenDepth === extDefineParen) {
				extDefineParen = -1;
				classBodyDepth = -1;
			}
			parenDepth = Math.max(0, parenDepth - 1);
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "[") {
			bracketDepth++;
			pendingKey = "";
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "]") {
			bracketDepth = Math.max(0, bracketDepth - 1);
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			if (pendingKey === "methods") {
				methodsDepth = braceDepth;
			} else if (
				!pendingKey &&
				extDefineParen >= 0 &&
				classBodyDepth < 0 &&
				bracketDepth === 0
			) {
				classBodyDepth = braceDepth;
			}
			pendingKey = "";
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth === methodsDepth) {
				methodsDepth = -1;
			}
			if (braceDepth === classBodyDepth) {
				classBodyDepth = -1;
			}
			braceDepth = Math.max(0, braceDepth - 1);
			pendingKey = "";
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			i++;
			continue;
		}
		if (ch === ":") {
			if (
				atMemberDepth() &&
				lastIdent &&
				lastIdent !== "Ext.define" &&
				(lastIdentStart < skipStart || lastIdentStart >= skipEnd)
			) {
				keys.add(lastIdent);
			}
			pendingKey = lastIdent;
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "," || ch === ";" || ch === "=") {
			pendingKey = "";
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
			i++;
			continue;
		}

		if (!/\s/.test(ch)) {
			lastIdent = "";
			lastIdentStart = -1;
			afterDot = false;
		}
		i++;
	}

	return keys;
}

function objectKeyPrefix(
	documentText: string,
	offset: number
): Omit<OverrideInsertContext, "kind"> | undefined {
	let identEnd = offset;
	while (
		identEnd < documentText.length &&
		/[A-Za-z0-9_$]/.test(documentText[identEnd])
	) {
		identEnd++;
	}
	let identStart = offset;
	while (identStart > 0 && /[A-Za-z0-9_$]/.test(documentText[identStart - 1])) {
		identStart--;
	}
	const typed = documentText.slice(identStart, offset);
	if (typed && !/^[A-Za-z_$][\w$]*$/.test(typed)) {
		return undefined;
	}

	let k = identEnd;
	while (k < documentText.length && /[ \t]/.test(documentText[k])) {
		k++;
	}
	if (documentText[k] === ":") {
		return undefined;
	}

	let i = identStart - 1;
	while (i >= 0 && /\s/.test(documentText[i])) {
		i--;
	}
	const prev = documentText[i];
	if (prev !== "{" && prev !== ",") {
		return undefined;
	}

	let lineStart = identStart;
	while (lineStart > 0 && documentText[lineStart - 1] !== "\n") {
		lineStart--;
	}
	const indent = documentText.slice(lineStart, identStart);
	if (/[^\t ]/.test(indent)) {
		return undefined;
	}
	return { typed, identStart, identEnd };
}

function scanOverrideScope(
	text: string,
	end: number
): {
	braceDepth: number;
	methodsDepth: number;
	classBodyDepth: number;
} {
	let braceDepth = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let methodsDepth = -1;
	let classBodyDepth = -1;
	let extDefineParen = -1;
	let lastIdent = "";
	let pendingKey = "";
	let afterDot = false;
	let i = 0;

	const setIdent = (name: string) => {
		if (afterDot && lastIdent === "Ext" && name === "define") {
			lastIdent = "Ext.define";
		} else {
			lastIdent = name;
		}
		afterDot = false;
	};

	while (i < end) {
		const ch = text[i];
		const next = text[i + 1];

		if (ch === "/" && next === "/") {
			i += 2;
			while (i < end && text[i] !== "\n") {
				i++;
			}
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i + 1 < end && !(text[i] === "*" && text[i + 1] === "/")) {
				i++;
			}
			i = Math.min(end, i + 2);
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			i = skipJsString(text, i, end);
			pendingKey = "";
			lastIdent = "";
			afterDot = false;
			continue;
		}

		if (/[A-Za-z_$]/.test(ch)) {
			let j = i + 1;
			while (j < end && /[A-Za-z0-9_$]/.test(text[j])) {
				j++;
			}
			setIdent(text.slice(i, j));
			i = j;
			continue;
		}

		if (ch === ".") {
			afterDot = lastIdent === "Ext";
			i++;
			continue;
		}

		if (ch === "(") {
			parenDepth++;
			if (lastIdent === "Ext.define") {
				extDefineParen = parenDepth;
			}
			pendingKey = "";
			lastIdent = "";
			afterDot = false;
			i++;
			continue;
		}
		if (ch === ")") {
			if (parenDepth === extDefineParen) {
				extDefineParen = -1;
				classBodyDepth = -1;
			}
			parenDepth = Math.max(0, parenDepth - 1);
			lastIdent = "";
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "[") {
			bracketDepth++;
			pendingKey = "";
			lastIdent = "";
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "]") {
			bracketDepth = Math.max(0, bracketDepth - 1);
			lastIdent = "";
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			if (pendingKey === "methods") {
				methodsDepth = braceDepth;
			} else if (
				!pendingKey &&
				extDefineParen >= 0 &&
				classBodyDepth < 0 &&
				bracketDepth === 0
			) {
				classBodyDepth = braceDepth;
			}
			pendingKey = "";
			lastIdent = "";
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth === methodsDepth) {
				methodsDepth = -1;
			}
			if (braceDepth === classBodyDepth) {
				classBodyDepth = -1;
			}
			braceDepth = Math.max(0, braceDepth - 1);
			pendingKey = "";
			lastIdent = "";
			afterDot = false;
			i++;
			continue;
		}
		if (ch === ":") {
			pendingKey = lastIdent;
			lastIdent = "";
			afterDot = false;
			i++;
			continue;
		}
		if (ch === "," || ch === ";" || ch === "=") {
			pendingKey = "";
			lastIdent = "";
			afterDot = false;
			i++;
			continue;
		}

		if (!/\s/.test(ch)) {
			lastIdent = "";
			afterDot = false;
		}
		i++;
	}

	return {
		braceDepth,
		methodsDepth,
		classBodyDepth
	};
}

function skipJsString(text: string, start: number, end: number): number {
	const quote = text[start];
	let i = start + 1;
	while (i < end) {
		if (quote === "`" && text[i] === "$" && text[i + 1] === "{") {
			i += 2;
			let depth = 1;
			while (i < end && depth > 0) {
				if (text[i] === "'" || text[i] === '"') {
					i = skipJsString(text, i, end);
					continue;
				}
				if (text[i] === "`") {
					i = skipJsString(text, i, end);
					continue;
				}
				if (text[i] === "{") {
					depth++;
				} else if (text[i] === "}") {
					depth--;
				}
				i++;
			}
			continue;
		}
		if (text[i] === "\\") {
			i += 2;
			continue;
		}
		if (text[i] === quote) {
			return i + 1;
		}
		i++;
	}
	return end;
}
