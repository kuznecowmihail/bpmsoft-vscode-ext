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
	if (callee?.type !== "MemberExpression" || callee.computed) {
		return false;
	}
	const prop = callee.property as AnyNode;
	if (prop?.type !== "Identifier" || prop.name !== "define") {
		return false;
	}
	const obj = callee.object as AnyNode;
	if (obj?.type === "Identifier" && obj.name === "Ext") {
		return true;
	}
	if (obj?.type === "MemberExpression" && !obj.computed) {
		const objObj = obj.object as AnyNode;
		const objProp = obj.property as AnyNode;
		return (
			objObj?.type === "ThisExpression" &&
			objProp?.type === "Identifier" &&
			objProp.name === "Ext"
		);
	}
	return false;
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
				: undefined,
			dataValueType: attributeDataValueType(value)
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

function propObjectValue(obj: AnyNode | undefined, key: string): AnyNode | undefined {
	if (!obj || obj.type !== "ObjectExpression") {
		return undefined;
	}
	for (const p of obj.properties as AnyNode[]) {
		if (propName(p) === key) {
			const v = p.value as AnyNode;
			return v?.type === "ObjectExpression" ? v : undefined;
		}
	}
	return undefined;
}

function propExprPreview(obj: AnyNode | undefined, key: string): string | undefined {
	if (!obj || obj.type !== "ObjectExpression") {
		return undefined;
	}
	for (const p of obj.properties as AnyNode[]) {
		if (propName(p) === key) {
			return exprPreview(p.value as AnyNode);
		}
	}
	return undefined;
}

// Heuristic, not authoritative — BPMSoft view configs don't tag which
// `values` keys are event handlers vs. plain properties anywhere accessible
// via static analysis; this is the common Ext/BPMSoft DOM-ish event-name
// vocabulary actually observed in practice (e.g. `click: {bindTo:
// "onSaveButtonClick"}`). Anything not in this list is shown as a property.
const DIFF_EVENT_KEYS = new Set([
	"click",
	"dblclick",
	"change",
	"select",
	"blur",
	"focus",
	"afterrender",
	"beforerender",
	"render",
	"destroy",
	"show",
	"hide",
	"keydown",
	"keyup",
	"keypress",
	"mouseenter",
	"mouseleave",
	"mousedown",
	"mouseup",
	"scroll",
	"resize",
	"specialkey",
	"boxready",
	"activate",
	"deactivate"
]);

// Authoritative, straight from the enum's own source —
// `Resources/ui/BPMSoft/core/enums/sysenums.js`'s `BPMSoft.ViewItemType = {...}`.
// A real schema (`GoPresetsInGridSettingsPage.js`) was found authoring
// `itemType: 2` as a bare number instead of the symbolic
// `BPMSoft.ViewItemType.DETAIL` constant — both mean the same thing at
// runtime, so both need to resolve to the same `ViewControlsIndex` lookup
// key here, not just the symbolic form.
const VIEW_ITEM_TYPE_NAMES: Record<number, string> = {
	0: "GRID_LAYOUT",
	1: "TAB_PANEL",
	2: "DETAIL",
	3: "MODEL_ITEM",
	4: "MODULE",
	5: "BUTTON",
	6: "LABEL",
	7: "CONTAINER",
	8: "MENU",
	9: "MENU_ITEM",
	10: "MENU_SEPARATOR",
	11: "SECTION_VIEWS",
	12: "SECTION_VIEW",
	13: "GRID",
	14: "SCHEDULE_EDIT",
	15: "CONTROL_GROUP",
	16: "RADIO_GROUP",
	17: "DESIGN_VIEW",
	18: "COLOR_BUTTON",
	19: "IMAGE_TAB_PANEL",
	20: "HYPERLINK",
	21: "INFORMATION_BUTTON",
	22: "TIP",
	23: "COMPONENT",
	24: "TIP_LABEL",
	30: "PROGRESS_BAR",
	31: "GRID_LAYOUT_EDIT",
	32: "IFRAMECONTROL",
	33: "EXTERNAL_WIDGET"
};

/** Resolves a diff item's `values.itemType` node to its canonical
 * `BPMSoft.ViewItemType.X` symbolic name (for `ViewControlsIndex` lookups)
 * and a human-readable display form, regardless of whether the schema wrote
 * the symbolic constant or its bare numeric value. */
function resolveViewItemType(node: AnyNode | undefined): { symbolic: string; display: string } | undefined {
	if (!node) {
		return undefined;
	}
	if (node.type === "MemberExpression") {
		const preview = exprPreview(node);
		return preview?.startsWith("BPMSoft.ViewItemType.") ? { symbolic: preview, display: preview } : undefined;
	}
	if (node.type === "Literal" && typeof node.value === "number") {
		const name = VIEW_ITEM_TYPE_NAMES[node.value];
		return name ? { symbolic: `BPMSoft.ViewItemType.${name}`, display: `${name} (${node.value})` } : undefined;
	}
	return undefined;
}

interface DiffBuilderNode {
	name: string;
	parentName: string | undefined;
	propertyName: string | undefined;
	operation: string | undefined;
	removed: boolean;
	values: Map<string, AnyNode>;
	/** Keys deleted by a `{operation: "remove", name, properties: [...]}` op —
	 * that shape removes specific properties from an existing item, not the
	 * item itself (confirmed against the real `JsonApplier.remove()`
	 * implementation, `Resources/ui/BPMSoft/utils/common/json-applier.js`). */
	removedProperties: Set<string>;
	lastNode: AnyNode;
	children: DiffBuilderNode[];
}

function stringArrayElements(node: AnyNode | undefined): string[] {
	if (!node || node.type !== "ArrayExpression") {
		return [];
	}
	return (node.elements as AnyNode[])
		.filter((e) => e && e.type === "Literal" && typeof e.value === "string")
		.map((e) => e.value as string);
}

function previewDiffValue(node: AnyNode | undefined): string | undefined {
	if (!node) {
		return undefined;
	}
	const direct = exprPreview(node);
	if (direct) {
		return direct;
	}
	if (node.type === "ObjectExpression") {
		const bindTo = stringProp(node, "bindTo");
		return bindTo ? `bindTo: ${bindTo}` : undefined;
	}
	return undefined;
}

function diffNodeToMember(node: DiffBuilderNode): IndexedMember {
	const itemTypeNode = node.values.get("itemType");
	const resolvedItemType = resolveViewItemType(itemTypeNode);
	const itemType = resolvedItemType?.display ?? (itemTypeNode && previewDiffValue(itemTypeNode));
	const detailParts = [node.operation, itemType, node.removed ? "removed" : undefined].filter(Boolean);

	const properties: IndexedMember[] = [];
	const events: IndexedMember[] = [];
	for (const [key, valueNode] of node.values) {
		if (key === "itemType") {
			continue;
		}
		const member: IndexedMember = {
			name: key,
			kind: "property",
			detail: previewDiffValue(valueNode),
			position: posFromNode(valueNode)
		};
		(DIFF_EVENT_KEYS.has(key) ? events : properties).push(member);
	}

	const children: IndexedMember[] = [];
	if (properties.length) {
		children.push({
			name: "Заполненные свойства",
			kind: "namespace",
			detail: `${properties.length}`,
			children: properties
		});
	}
	if (events.length) {
		children.push({ name: "Заполненные события", kind: "namespace", detail: `${events.length}`, children: events });
	}
	if (node.removedProperties.size) {
		children.push({
			name: "Удалённые свойства",
			kind: "namespace",
			detail: `${node.removedProperties.size}`,
			children: [...node.removedProperties].map((key) => ({
				name: key,
				kind: "property" as const,
				detail: "removed"
			}))
		});
	}
	children.push(...node.children.map(diffNodeToMember));

	return {
		name: node.name,
		kind: "property",
		detail: detailParts.join(" · ") || undefined,
		documentation: node.parentName ? `parentName: ${node.parentName}` : undefined,
		children: children.length ? children : undefined,
		position: posFromNode(node.lastNode),
		viewItemType: resolvedItemType?.symbolic,
		// `bindTo` isn't just a display binding — for an itemType-less node
		// it's the join key `ViewGeneratorV2.findViewModelColumn` uses to
		// resolve the item's real control (via `generateModelItem` →
		// `generateEditControl`, dispatched on that attribute's own
		// `dataValueType` — a second dispatch table entirely separate from
		// the `itemType` one; see CLAUDE.md §4b). Exposed so the Outline can
		// cross-link this node to the matching "Атрибуты" entry.
		linkedAttributeName: bindToLiteral(node.values.get("bindTo"))
	};
}

function bindToLiteral(node: AnyNode | undefined): string | undefined {
	return node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

/** `diff: [...]` is a *tree*, not a flat list — each `insert` names its
 * `parentName`, `merge` updates an existing element's `values` in place,
 * `move` relocates one without touching its config, `remove` deletes one.
 * Rebuilds that real parent/child structure (confirmed against
 * `BPMSoft.JsonApplier.applyDiff`'s four operations, real examples across
 * both installs, 2026-09-06 — see CLAUDE.md §4b) instead of the flat
 * insertion-order list this used to be. Each node's own filled `values`
 * become "Заполненные свойства"/"Заполненные события" children (heuristic
 * split, see `DIFF_EVENT_KEYS`) alongside its real diff children. An
 * `insert` whose `parentName` isn't itself in this file's own diff (i.e. the
 * parent lives on an ancestor schema) surfaces as a root — outline/browsing
 * aid, not used for completion/hover. */
export function collectDiffMembers(diffNode: AnyNode | undefined): IndexedMember[] {
	if (!diffNode || diffNode.type !== "ArrayExpression") {
		return [];
	}
	const byName = new Map<string, DiffBuilderNode>();
	const roots: DiffBuilderNode[] = [];

	const attach = (node: DiffBuilderNode) => {
		const parent = node.parentName ? byName.get(node.parentName) : undefined;
		if (parent) {
			parent.children.push(node);
		} else {
			roots.push(node);
		}
	};
	const detach = (node: DiffBuilderNode) => {
		const parent = node.parentName ? byName.get(node.parentName) : undefined;
		const list = parent ? parent.children : roots;
		const idx = list.indexOf(node);
		if (idx >= 0) {
			list.splice(idx, 1);
		}
	};

	for (const el of diffNode.elements as AnyNode[]) {
		if (!el || el.type !== "ObjectExpression") {
			continue;
		}
		const name = stringProp(el, "name");
		if (!name) {
			continue;
		}
		const operation = stringProp(el, "operation");

		if (operation === "remove") {
			const removedKeys = stringArrayElements(rawPropValue(el, "properties"));
			const existing = byName.get(name);
			if (removedKeys.length) {
				// Property-only removal — the item itself stays.
				const target =
					existing ||
					((): DiffBuilderNode => {
						const stub: DiffBuilderNode = {
							name,
							parentName: undefined,
							propertyName: undefined,
							operation: undefined,
							removed: false,
							values: new Map(),
							removedProperties: new Set(),
							lastNode: el,
							children: []
						};
						byName.set(name, stub);
						roots.push(stub);
						return stub;
					})();
				for (const key of removedKeys) {
					target.values.delete(key);
					target.removedProperties.add(key);
				}
				continue;
			}
			if (existing) {
				existing.removed = true;
				existing.operation = operation;
				existing.lastNode = el;
			} else {
				const node: DiffBuilderNode = {
					name,
					parentName: undefined,
					propertyName: undefined,
					operation,
					removed: true,
					values: new Map(),
					removedProperties: new Set(),
					lastNode: el,
					children: []
				};
				byName.set(name, node);
				roots.push(node);
			}
			continue;
		}

		const parentName = stringProp(el, "parentName");
		const propertyName = stringProp(el, "propertyName");
		let node = byName.get(name);
		if (!node) {
			node = {
				name,
				parentName,
				propertyName,
				operation,
				removed: false,
				values: new Map(),
				removedProperties: new Set(),
				lastNode: el,
				children: []
			};
			byName.set(name, node);
			attach(node);
		} else {
			node.operation = operation;
			node.lastNode = el;
			if (operation === "insert") {
				node.removed = false;
			}
			if (parentName && parentName !== node.parentName) {
				detach(node);
				node.parentName = parentName;
				node.propertyName = propertyName || node.propertyName;
				attach(node);
			}
		}

		const valuesObj = propObjectValue(el, "values");
		if (valuesObj) {
			for (const prop of valuesObj.properties as AnyNode[]) {
				const key = propName(prop);
				if (key) {
					node.values.set(key, prop.value as AnyNode);
				}
			}
		}
	}

	return roots.map(diffNodeToMember);
}

/** `{ AttrName: { RuleId: {...} } }` → `Map<name, Property node>` — shared by
 * the `rules`/`businessRules` merge below (mirrors `BusinessRulesApplierV2.
 * mergeRules`/`mergeColumnRules` in `conf/content`, confirmed 2026-09-06:
 * same-named entries in both get shallow-merged with `businessRules` fields
 * winning conflicts; entries unique to either side are kept as-is). */
function objectPropsByName(node: AnyNode | undefined): Map<string, AnyNode> {
	const map = new Map<string, AnyNode>();
	if (!node || node.type !== "ObjectExpression") {
		return map;
	}
	for (const p of node.properties as AnyNode[]) {
		const name = propName(p);
		if (name) {
			map.set(name, p);
		}
	}
	return map;
}

// The authoritative source, not a guess: `conf\content\BusinessRuleModule.js`
// declares these numeric values directly (`var enums = {Property: {VISIBLE:
// 0, ENABLED: 1, REQUIRED: 2, READONLY: 3}, RuleType: {DISABLED: -1,
// BINDPARAMETER: 0, FILTRATION: 1, AUTOCOMPLETE: 2, POPULATE_ATTRIBUTE: 3},
// ...}`) — see CLAUDE.md §4b.
const RULE_TYPE_CODE_NAMES: Record<string, string> = {
	"-1": "DISABLED",
	"0": "BINDPARAMETER",
	"1": "FILTRATION",
	"2": "AUTOCOMPLETE",
	"3": "POPULATE_ATTRIBUTE"
};
const RULE_PROPERTY_CODE_NAMES: Record<string, string> = {
	"0": "VISIBLE",
	"1": "ENABLED",
	"2": "REQUIRED",
	"3": "READONLY"
};
/** Ordered so the "available" list below reads in the same order the
 * platform declares them, not alphabetically. */
const ALL_RULE_PROPERTY_NAMES = ["VISIBLE", "ENABLED", "REQUIRED", "READONLY"];

function describeRuleCode(preview: string | undefined, names: Record<string, string>): string | undefined {
	if (!preview) {
		return undefined;
	}
	const mapped = names[preview];
	return mapped ? `${mapped} (${preview})` : preview;
}

/** Resolves a rule's `ruleType`/`property` to its canonical enum name
 * regardless of which authoring path produced it: the Designer's numeric
 * code ("2") via `codeNames`, or hand-written `rules`' own symbolic constant
 * ("BusinessRuleModule.enums.Property.REQUIRED", matched by its trailing
 * identifier) — both mean the same thing, just spelled differently. */
function normalizeRuleCode(preview: string | undefined, codeNames: Record<string, string>): string | undefined {
	if (!preview) {
		return undefined;
	}
	const direct = codeNames[preview];
	if (direct) {
		return direct;
	}
	const tail = preview.slice(preview.lastIndexOf(".") + 1);
	return Object.values(codeNames).includes(tail) ? tail : undefined;
}

/** `rules` (hand-written, symbolic `BusinessRuleModule.enums.*` constants)
 * and `businessRules` (Designer "Бизнес-правила" panel output, numeric
 * codes + `uId`/`enabled`/`removed` bookkeeping) are two authoring paths
 * into the *same* engine — merged here the same way the runtime merges them,
 * so the outline shows what actually applies to the page, not just what's
 * hand-written. */
export function collectBusinessRuleMembers(
	rulesNode: AnyNode | undefined,
	businessRulesNode: AnyNode | undefined
): IndexedMember[] {
	const rulesByAttr = objectPropsByName(rulesNode);
	const businessRulesByAttr = objectPropsByName(businessRulesNode);
	const attrNames = new Set<string>([...rulesByAttr.keys(), ...businessRulesByAttr.keys()]);

	const members: IndexedMember[] = [];
	for (const attrName of attrNames) {
		const rulesByRuleId = objectPropsByName((rulesByAttr.get(attrName) as AnyNode | undefined)?.value as AnyNode);
		const businessRulesByRuleId = objectPropsByName(
			(businessRulesByAttr.get(attrName) as AnyNode | undefined)?.value as AnyNode
		);
		const ruleIds = new Set<string>([...rulesByRuleId.keys(), ...businessRulesByRuleId.keys()]);

		const children: IndexedMember[] = [];
		const usedBindParameterProperties = new Set<string>();
		for (const ruleId of ruleIds) {
			const ruleProp = rulesByRuleId.get(ruleId);
			const businessRuleProp = businessRulesByRuleId.get(ruleId);
			// businessRules wins field conflicts at runtime — prefer it for display too.
			const ruleObj = (businessRuleProp?.value ?? ruleProp?.value) as AnyNode | undefined;
			const ruleTypeRaw = propExprPreview(ruleObj, "ruleType");
			const propertyRaw = propExprPreview(ruleObj, "property");
			const ruleType = describeRuleCode(ruleTypeRaw, RULE_TYPE_CODE_NAMES);
			const property = describeRuleCode(propertyRaw, RULE_PROPERTY_CODE_NAMES);
			const source = businessRuleProp && ruleProp ? "rules + businessRules" : businessRuleProp ? "businessRules" : "rules";
			const anchorProp = ruleProp ?? businessRuleProp;
			children.push({
				name: ruleId,
				kind: "property",
				detail: [ruleType, property].filter(Boolean).join(" · ") || undefined,
				documentation: `Источник: ${source}`,
				position: anchorProp ? posFromNode((anchorProp as AnyNode).key ?? anchorProp) : undefined
			});
			// Only BINDPARAMETER rules target a `Property` (VISIBLE/ENABLED/
			// REQUIRED/READONLY) — FILTRATION/AUTOCOMPLETE/POPULATE_ATTRIBUTE
			// don't use that field for the same purpose, so they don't count
			// toward "already used" here.
			if (normalizeRuleCode(ruleTypeRaw, RULE_TYPE_CODE_NAMES) === "BINDPARAMETER") {
				const propertyName = normalizeRuleCode(propertyRaw, RULE_PROPERTY_CODE_NAMES);
				if (propertyName) {
					usedBindParameterProperties.add(propertyName);
				}
			}
		}
		if (!children.length) {
			continue;
		}
		const availableProperties = ALL_RULE_PROPERTY_NAMES.filter((p) => !usedBindParameterProperties.has(p));
		if (availableProperties.length) {
			children.push({
				name: "Доступные свойства (BINDPARAMETER)",
				kind: "namespace",
				detail: `${availableProperties.length}`,
				documentation:
					"Значения BusinessRuleModule.enums.Property, для которых у этого атрибута ещё нет правила видимости/доступности",
				children: availableProperties.map((p) => ({ name: p, kind: "property" }))
			});
		}
		const anchorAttrProp = rulesByAttr.get(attrName) ?? businessRulesByAttr.get(attrName);
		members.push({
			name: attrName,
			kind: "namespace",
			detail: `${children.length}`,
			children,
			position: anchorAttrProp ? posFromNode((anchorAttrProp as AnyNode).key ?? anchorAttrProp) : undefined
		});
	}
	return members;
}

function localizedCaption(node: AnyNode | undefined): string | undefined {
	if (!node || node.type !== "ArrayExpression") {
		return undefined;
	}
	let fallback: string | undefined;
	for (const el of node.elements as AnyNode[]) {
		if (!el || el.type !== "ObjectExpression") {
			continue;
		}
		const culture = stringProp(el, "cultureName");
		const value = stringProp(el, "value");
		if (!value) {
			continue;
		}
		fallback = fallback ?? value;
		if (culture === "ru-RU") {
			return value;
		}
	}
	return fallback;
}

function rawPropValue(obj: AnyNode | undefined, key: string): AnyNode | undefined {
	if (!obj || obj.type !== "ObjectExpression") {
		return undefined;
	}
	for (const p of obj.properties as AnyNode[]) {
		if (propName(p) === key) {
			return p.value as AnyNode;
		}
	}
	return undefined;
}

// The three action-type Designer components in conf/content
// (BusinessRuleBindParameterActionDesigner*/BusinessRuleFilterActionDesigner*/
// BusinessRulePopulateItemActionDesigner*) line up exactly with these three
// action.ruleType codes — see CLAUDE.md §4b.
const MULTIPLY_ACTION_TYPE_NAMES: Record<string, string> = {
	"0": "свойство (BINDPARAMETER)",
	"1": "фильтр (FILTRATION)",
	"3": "заполнение значения (POPULATE)"
};

/** `businessRulesMultiplyActions: { "<uid>": { name: [{cultureName,value}],
 * enabled, removed, businessRuleTree: { actions: [...], childRuleTree: [...] } } }`
 * — a richer, tree-based engine distinct from `rules`/`businessRules`: one
 * shared AND/OR condition can drive actions across *multiple* columns at
 * once (hence the name), including a "populate value from an expression"
 * action type the classic engine has no equivalent for. See CLAUDE.md §4b. */
export function collectMultiplyActionMembers(node: AnyNode | undefined): IndexedMember[] {
	if (!node || node.type !== "ObjectExpression") {
		return [];
	}
	const members: IndexedMember[] = [];
	for (const prop of node.properties as AnyNode[]) {
		const uid = propName(prop);
		const ruleObj = prop.value as AnyNode;
		if (!uid || ruleObj?.type !== "ObjectExpression") {
			continue;
		}
		const caption = localizedCaption(rawPropValue(ruleObj, "name")) || uid;
		const enabledNode = rawPropValue(ruleObj, "enabled");
		const enabled = enabledNode?.type === "Literal" ? enabledNode.value !== false : true;
		const treeObj = propObjectValue(ruleObj, "businessRuleTree");
		const actionsNode = treeObj ? rawPropValue(treeObj, "actions") : undefined;
		const children: IndexedMember[] = [];
		if (actionsNode?.type === "ArrayExpression") {
			for (const action of actionsNode.elements as AnyNode[]) {
				if (!action || action.type !== "ObjectExpression") {
					continue;
				}
				const columnName = stringProp(action, "columnName");
				const ruleTypePreview = propExprPreview(action, "ruleType");
				const ruleTypeLabel = ruleTypePreview
					? MULTIPLY_ACTION_TYPE_NAMES[ruleTypePreview] || ruleTypePreview
					: undefined;
				// BINDPARAMETER-style actions (ruleType 0) also carry which
				// property they toggle (VISIBLE/REQUIRED/...), same code space
				// as classic rules' `property` field.
				const propertyLabel = describeRuleCode(propExprPreview(action, "property"), RULE_PROPERTY_CODE_NAMES);
				children.push({
					name: columnName || "(?)",
					kind: "property",
					detail: [ruleTypeLabel, propertyLabel].filter(Boolean).join(" · ") || undefined,
					position: posFromNode(action)
				});
			}
		}
		members.push({
			name: caption,
			kind: "namespace",
			detail: enabled ? `${children.length}` : `${children.length} · отключено`,
			children,
			position: posFromNode(prop.key ?? prop)
		});
	}
	return members;
}

// Confirmed straight from the real consumer, `conf\content\BaseSchemaViewModel.js`
// (`loadModule`/`getModuleConfig`/`getModuleInstanceConfig`) — see CLAUDE.md
// §4b. Deliberately excludes `moduleClassName`: despite being common in
// netmonet_1.9 schemas, stock `loadModule` never reads it — it only works
// there because that install carries its own
// `Ext.override(BPMSoft.BaseSchemaViewModel, {loadModule: ...})` patch. Listing
// it as "available" everywhere would overclaim a project-specific extension
// as a platform guarantee.
const KNOWN_MODULE_KEYS = ["moduleName", "moduleId", "reload", "config", "instanceConfig", "alias"];

/** `modules: { "<EmbeddedModuleName>": { moduleName, config: {...}, ... } }`
 * — a named, pre-configured module instance. A `diff` entry with
 * `itemType: MODULE` mounts it by matching its own `name` against this
 * registry's key (confirmed: `getModuleConfig` falls back to
 * `this.modules[config.name]` whenever the diff item has no `values.moduleName`
 * of its own — the dominant real-world case). See CLAUDE.md §4b. */
export function collectEmbeddedModuleMembers(node: AnyNode | undefined): IndexedMember[] {
	if (!node || node.type !== "ObjectExpression") {
		return [];
	}
	const members: IndexedMember[] = [];
	for (const prop of node.properties as AnyNode[]) {
		const name = propName(prop);
		const value = prop.value as AnyNode;
		if (!name || value?.type !== "ObjectExpression") {
			continue;
		}
		const moduleName = stringProp(value, "moduleName");
		members.push({
			name,
			kind: "property",
			detail: moduleName || "BaseSchemaModuleV2 (по умолчанию)",
			position: posFromNode(prop.key ?? prop),
			children: collectFilledAndAvailable(value, KNOWN_MODULE_KEYS)
		});
	}
	return members;
}

/** Shared by `details`/`modules`: lists this item's own filled top-level
 * keys (raw preview per key, same convention as diff's "Заполненные
 * свойства") plus, from a fixed catalog of keys the real platform consumer
 * is confirmed to read (see CLAUDE.md §4b for each), the ones not set yet. */
function collectFilledAndAvailable(value: AnyNode, knownKeys: string[]): IndexedMember[] {
	const filled: IndexedMember[] = [];
	const filledNames = new Set<string>();
	for (const prop of value.properties as AnyNode[]) {
		const key = propName(prop);
		if (!key) {
			continue;
		}
		filledNames.add(key);
		filled.push({
			name: key,
			kind: "property",
			detail: previewDiffValue(prop.value as AnyNode),
			position: posFromNode(prop.value as AnyNode)
		});
	}
	const available = knownKeys.filter((k) => !filledNames.has(k));
	const children: IndexedMember[] = [];
	if (filled.length) {
		children.push({ name: "Заполненные свойства", kind: "namespace", detail: `${filled.length}`, children: filled });
	}
	if (available.length) {
		children.push({
			name: "Доступные, но не заполненные",
			kind: "namespace",
			detail: `${available.length}`,
			children: available.map((k) => ({ name: k, kind: "property" }))
		});
	}
	return children;
}

/** `dataModels: { "<Name>": { entitySchemaName, primaryColumnValue: { bindTo } } }`
 * — a named reference to a related entity (reached via a lookup attribute on
 * this page's own entity), so other parts of the schema can address its
 * columns without that related entity being this page's own
 * `entitySchemaName`. Real but not runtime-confirmed to the same depth as
 * the rules family — see CLAUDE.md §4b. */
export function collectDataModelMembers(node: AnyNode | undefined): IndexedMember[] {
	if (!node || node.type !== "ObjectExpression") {
		return [];
	}
	const members: IndexedMember[] = [];
	for (const prop of node.properties as AnyNode[]) {
		const name = propName(prop);
		const value = prop.value as AnyNode;
		if (!name || value?.type !== "ObjectExpression") {
			continue;
		}
		const entitySchemaName = stringProp(value, "entitySchemaName");
		const primaryColumnValue = propObjectValue(value, "primaryColumnValue");
		const bindTo = primaryColumnValue ? stringProp(primaryColumnValue, "bindTo") : undefined;
		const detailParts = [
			entitySchemaName ? `entity ${entitySchemaName}` : undefined,
			bindTo ? `bindTo: ${bindTo}` : undefined
		].filter(Boolean);
		members.push({
			name,
			kind: "property",
			detail: detailParts.join(" · ") || undefined,
			position: posFromNode(prop.key ?? prop),
			linkedAttributeName: bindTo
		});
	}
	return members;
}

/** `details: { DetailName: { schemaName, entitySchemaName, filter, ... } }`
 * — a Detail embedded directly in the schema's own config rather than
 * through the visual Designer's diff tree. Rare in practice (survey of two
 * real BPMSoft installs: ~1% of schemas actually populate this; the rest
 * carry it only as the Designer's own empty placeholder comment block) but
 * worth surfacing when present — it's easy to miss scrolling through source
 * and not otherwise visible anywhere in the Outline.
 *
 * `details` is `modules` under a `@deprecated 7.8` alias at the generator
 * level (`ViewModelGeneratorV2.applySchemaDetails` just calls
 * `applySchemaModules`) — but its *consumer*, `BaseEntityPage.js`, reads a
 * genuinely different field set, confirmed field-by-field — see CLAUDE.md
 * §4b. */
const KNOWN_DETAIL_KEYS = [
	"schemaName",
	"entitySchemaName",
	"filter",
	"filterMethod",
	"useRelationship",
	"defaultValues",
	"subscriber",
	"captionName",
	"profileKey",
	"relationType",
	"relationTypePath",
	"relationshipPath",
	"detailElementsPrefix"
];

export function collectDetailMembers(detailsNode: AnyNode | undefined): IndexedMember[] {
	if (!detailsNode || detailsNode.type !== "ObjectExpression") {
		return [];
	}
	const members: IndexedMember[] = [];
	for (const prop of detailsNode.properties as AnyNode[]) {
		const name = propName(prop);
		const value = prop.value as AnyNode;
		if (!name || value?.type !== "ObjectExpression") {
			continue;
		}
		const schemaName = stringProp(value, "schemaName");
		const entitySchemaName = stringProp(value, "entitySchemaName");
		// `masterColumn` is this schema's own attribute (the join key on
		// *our* entity); `detailColumn` is the matching attribute on the
		// detail's own entitySchemaName, not ours — only masterColumn is
		// something "Атрибуты" could actually contain.
		const filterObj = propObjectValue(value, "filter");
		const masterColumn = filterObj ? stringProp(filterObj, "masterColumn") : undefined;
		const detailParts = [
			schemaName && schemaName !== name ? schemaName : undefined,
			entitySchemaName ? `entity ${entitySchemaName}` : undefined
		].filter(Boolean);
		members.push({
			name,
			kind: "property",
			detail: detailParts.join(" · ") || undefined,
			position: posFromNode(prop.key ?? prop),
			linkedAttributeName: masterColumn,
			children: collectFilledAndAvailable(value, KNOWN_DETAIL_KEYS)
		});
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
	let pluginDeps: string[] = [];
	if (args.length >= 2 && args[1].type === "ArrayExpression") {
		const rawDeps = (args[1].elements as AnyNode[])
			.filter((e) => e && e.type === "Literal" && typeof e.value === "string")
			.map((e) => e.value as string);
		// css!/text! loader-plugin deps don't get their own factory parameter
		// (RequireJS treats them as side-effect-only loads), so they're kept
		// out of `deps` — it has to stay positionally aligned 1:1 with
		// `paramNames` for `SymbolIndex.resolveLocalAlias` to work. Tracked
		// separately in `pluginDeps` purely for outline display.
		deps = rawDeps.filter((d) => !d.startsWith("css!") && !d.startsWith("text!"));
		pluginDeps = rawDeps.filter((d) => d.startsWith("css!") || d.startsWith("text!"));
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
		pluginDependencies: pluginDeps.length ? pluginDeps : undefined,
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
			const diffMembers = collectDiffMembers(findSchemaSection(exportObj, "diff"));
			if (diffMembers.length) {
				module.diffMembers = diffMembers;
			}
			const businessRuleMembers = collectBusinessRuleMembers(
				findSchemaSection(exportObj, "rules"),
				findSchemaSection(exportObj, "businessRules")
			);
			if (businessRuleMembers.length) {
				module.businessRuleMembers = businessRuleMembers;
			}
			const multiplyActionMembers = collectMultiplyActionMembers(
				findSchemaSection(exportObj, "businessRulesMultiplyActions")
			);
			if (multiplyActionMembers.length) {
				module.multiplyActionMembers = multiplyActionMembers;
			}
			const detailMembers = collectDetailMembers(findSchemaSection(exportObj, "details"));
			if (detailMembers.length) {
				module.detailMembers = detailMembers;
			}
			const embeddedModuleMembers = collectEmbeddedModuleMembers(findSchemaSection(exportObj, "modules"));
			if (embeddedModuleMembers.length) {
				module.embeddedModuleMembers = embeddedModuleMembers;
			}
			const dataModelMembers = collectDataModelMembers(findSchemaSection(exportObj, "dataModels"));
			if (dataModelMembers.length) {
				module.dataModelMembers = dataModelMembers;
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
