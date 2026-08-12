import * as acorn from "acorn";
import * as walk from "acorn-walk";
import {
	IndexedMember,
	IndexedModule,
	MemberKind,
	SourcePosition
} from "../index/types";

type AnyNode = acorn.Node & Record<string, any>;

function posFromNode(node: AnyNode): SourcePosition | undefined {
	if (typeof node.start !== "number") {
		return undefined;
	}
	// filled after parse with locations
	const loc = node.loc?.start;
	if (!loc) {
		return undefined;
	}
	return { line: loc.line - 1, character: loc.column };
}

function getLeadingComment(
	comments: acorn.Comment[],
	node: AnyNode
): string | undefined {
	const start = node.start as number;
	let best: acorn.Comment | undefined;
	for (const c of comments) {
		if (c.end <= start && start - c.end < 80) {
			if (!best || c.end > best.end) {
				best = c;
			}
		}
	}
	if (!best) {
		return undefined;
	}
	return best.value
		.replace(/^\*+/, "")
		.replace(/\n\s*\*/g, "\n")
		.trim();
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
	if (
		value.type === "FunctionExpression" ||
		value.type === "ArrowFunctionExpression"
	) {
		return "method";
	}
	if (value.type === "ObjectExpression") {
		return "enum";
	}
	return "const";
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
		if (!name || name.startsWith("_")) {
			continue;
		}
		const value = prop.value as AnyNode;
		if (filter && !filter(name, value)) {
			continue;
		}
		members.push({
			name,
			kind: inferMemberKind(value),
			documentation: getLeadingComment(comments, prop),
			position: posFromNode(prop.key ?? prop)
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

function stringProp(obj: AnyNode, key: string): string | undefined {
	if (!obj || obj.type !== "ObjectExpression") {
		return undefined;
	}
	for (const prop of obj.properties as AnyNode[]) {
		if (propName(prop) !== key) {
			continue;
		}
		const v = prop.value as AnyNode;
		if (v?.type === "Literal" && typeof v.value === "string") {
			return v.value;
		}
	}
	return undefined;
}

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

	for (const prop of classBody.properties as AnyNode[]) {
		const n = propName(prop);
		if (
			!n ||
			n === "extend" ||
			n === "override" ||
			n === "mixins" ||
			n === "alternateClassName" ||
			n === "statics" ||
			n === "inheritableStatics" ||
			n.startsWith("_")
		) {
			continue;
		}
		const value = prop.value as AnyNode;
		if (
			value?.type === "FunctionExpression" ||
			value?.type === "ArrowFunctionExpression"
		) {
			module.members.push({
				name: n,
				kind: "method",
				documentation: getLeadingComment(comments, prop),
				position: posFromNode(prop.key ?? prop)
			});
		}
	}

	if (className && !module.alternateClassName && !module.override) {
		const short = className.split(".").pop();
		if (short) {
			module.alternateClassName = `BPMSoft.${short}`;
		}
	}
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

function findMethodsObject(returnObj: AnyNode): AnyNode | undefined {
	if (!returnObj || returnObj.type !== "ObjectExpression") {
		return undefined;
	}
	for (const prop of returnObj.properties as AnyNode[]) {
		if (propName(prop) === "methods") {
			return prop.value as AnyNode;
		}
	}
	return undefined;
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
	let factory: AnyNode | undefined;

	if (args.length >= 2 && args[1].type === "ArrayExpression") {
		deps = (args[1].elements as AnyNode[])
			.filter((e) => e && e.type === "Literal" && typeof e.value === "string")
			.map((e) => e.value as string)
			.filter((d) => !d.startsWith("css!") && !d.startsWith("text!"));
		factory = args[2];
	} else {
		factory = args[1];
	}

	const paramNames: string[] = [];
	if (
		factory &&
		(factory.type === "FunctionExpression" ||
			factory.type === "ArrowFunctionExpression")
	) {
		for (const p of factory.params as AnyNode[]) {
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
		mixins: {}
	};

	if (
		!factory ||
		(factory.type !== "FunctionExpression" &&
			factory.type !== "ArrowFunctionExpression")
	) {
		return module;
	}

	const body = factory.body as AnyNode;
	let returnArg: AnyNode | undefined;

	if (body.type === "BlockStatement") {
		for (const stmt of body.body as AnyNode[]) {
			if (stmt.type === "ReturnStatement" && stmt.argument) {
				returnArg = stmt.argument as AnyNode;
			}
		}
	} else {
		returnArg = body;
	}

	// Ext.define inside factory (mixins / overrides / controls)
	walk.simple(body, {
		CallExpression(node: AnyNode) {
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
			const methodsObj = findMethodsObject(returnArg);
			if (methodsObj) {
				module.members.push(
					...collectObjectMembers(methodsObj, comments, (_n, v) => {
						return (
							v.type === "FunctionExpression" ||
							v.type === "ArrowFunctionExpression"
						);
					})
				);
			}
		} else if (!module.members.length) {
			module.kind = "constants";
			module.members.push(...collectObjectMembers(returnArg, comments));
		}
	}

	// de-dupe members by name
	const seen = new Set<string>();
	module.members = module.members.filter((m) => {
		if (seen.has(m.name)) {
			return false;
		}
		seen.add(m.name);
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
	const comments: acorn.Comment[] = [];
	let ast: AnyNode;
	try {
		ast = acorn.parse(source, {
			ecmaVersion: "latest",
			sourceType: "script",
			locations: true,
			allowReturnOutsideFunction: true,
			onComment: comments
		}) as AnyNode;
	} catch {
		try {
			ast = acorn.parse(source, {
				ecmaVersion: 2020,
				sourceType: "script",
				locations: true,
				allowReturnOutsideFunction: true,
				onComment: comments
			}) as AnyNode;
		} catch {
			return undefined;
		}
	}

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
				className
			};
			applyExtDefine(module, className, classBody, comments);
			const seen = new Set<string>();
			module.members = module.members.filter((m) => {
				if (seen.has(m.name)) {
					return false;
				}
				seen.add(m.name);
				return true;
			});
			found = module;
		}
	} as any);

	return found;
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
