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
import { AnyNode, childNodes, posFromNode, leadingComment } from "./jsAst";

export const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

export function defineFactory(call: AnyNode): AnyNode | undefined {
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

export function factoryReturnArg(factory: AnyNode | undefined): AnyNode | undefined {
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

function findObjectBinding(scope: AnyNode, name: string): AnyNode | undefined {
	let found: AnyNode | undefined;
	walk.simple(scope, {
		VariableDeclarator(node: AnyNode) {
			const id = node.id as AnyNode | undefined;
			const init = node.init as AnyNode | undefined;
			if (id?.type === "Identifier" && id.name === name && init?.type === "ObjectExpression") {
				found = init;
			}
		}
	} as any);
	return found;
}

export function resolveFactoryExportObject(factory: AnyNode | undefined): AnyNode | undefined {
	if (!factory || !isFunctionNode(factory)) {
		return undefined;
	}

	let prototypeSource: AnyNode | undefined;
	walk.simple(factory, {
		AssignmentExpression(node: AnyNode) {
			const left = node.left as AnyNode | undefined;
			if (left?.type !== "MemberExpression" || left.computed) {
				return;
			}
			const prop = left.property as AnyNode;
			if (prop?.type !== "Identifier" || prop.name !== "prototype") {
				return;
			}
			prototypeSource = node.right as AnyNode;
		}
	} as any);

	if (prototypeSource?.type === "ObjectExpression") {
		return prototypeSource;
	}
	if (prototypeSource?.type === "Identifier") {
		const named = findObjectBinding(factory, prototypeSource.name as string);
		if (named) {
			return named;
		}
	}

	const returnArg = factoryReturnArg(factory);
	if (returnArg?.type === "ObjectExpression") {
		return returnArg;
	}
	if (returnArg?.type === "Identifier") {
		return findObjectBinding(factory, returnArg.name as string);
	}
	return undefined;
}

export function propName(prop: AnyNode): string | undefined {
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
export function applyExtDefine(
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

export function isExtDefineCall(node: AnyNode): boolean {
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

export function extDefineParts(node: AnyNode): {
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

export function findSchemaSection(returnObj: AnyNode, key: string): AnyNode | undefined {
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

export function collectSchemaAttributes(
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
		const member: IndexedMember = {
			name,
			kind: "attribute",
			documentation: attributeDocumentation(value, comments, prop),
			position: posFromNode(prop.key ?? prop),
			children: attributeHasLookupFields(value)
				? lookupEnumFieldMembers()
				: undefined
		};
		if (value?.type === "ObjectExpression") {
			const ref = stringProp(value, "referenceSchemaName");
			if (ref && /^[A-Za-z_][\w]*$/.test(ref)) {
				member.referenceSchemaName = ref;
			}
		}
		members.push(member);
	}
	return members;
}

export function isSchemaReturn(obj: AnyNode): boolean {
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

export function parseDefineCall(
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

	const exportObj = resolveFactoryExportObject(factory);
	if (exportObj?.type === "ObjectExpression") {
		if (isSchemaReturn(exportObj)) {
			module.kind = module.kind === "mixin" || module.kind === "class" ? module.kind : "page";
			Object.assign(module.mixins, extractMixins(exportObj));
			Object.assign(module.messages, extractMessages(exportObj, module.filePath, comments));
			const entityProp = findStringProp(exportObj, "entitySchemaName");
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
			const methodsObj = findSchemaSection(exportObj, "methods");
			if (methodsObj) {
				module.members.push(
					...collectObjectMembers(methodsObj, comments, (_n, v) => {
						return isMethodValue(v);
					})
				);
			}
			const propertiesObj = findSchemaSection(exportObj, "properties");
			if (propertiesObj) {
				module.members.push(
					...collectSchemaProperties(propertiesObj, comments)
				);
			}
			const attributesObj = findSchemaSection(exportObj, "attributes");
			if (attributesObj) {
				module.members.push(
					...collectSchemaAttributes(attributesObj, comments)
				);
			}
		} else if (!module.members.length) {
			if (returnArg?.type === "ObjectExpression") {
				module.kind = "constants";
			}
			module.members.push(...collectObjectMembers(exportObj, comments));
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
