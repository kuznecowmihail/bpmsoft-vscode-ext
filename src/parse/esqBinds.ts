import * as walk from "acorn-walk";
import { AnyNode, parseJs } from "./jsAst";
import { propName } from "./amdAst";

const QUERY_CLASS_NAMES = new Set([
	"BPMSoft.EntitySchemaQuery",
	"BPMSoft.InsertQuery",
	"BPMSoft.UpdateQuery",
	"BPMSoft.DeleteQuery"
]);
export const COLUMN_ARG0 = new Set([
	"addColumn",
	"addAggregationSchemaColumn",
	"addSchemaColumn",
	"createColumnIsNotNullFilter",
	"createColumnIsNullFilter",
	"createColumnBetweenFilterWithParameters",
	"setParameterValue",
	"setColumnValue"
]);
const COLUMN_ARG1 = new Set([
	"createColumnFilterWithParameter"
]);

const COLUMN_LITERAL_RE = /^[A-Za-z_][\w.]*$/;

export interface EsqColumnAccess {
	entityNames: string[];
	column: string;
	start: number;
	end: number;
}

interface QueryVarBind {
	entities: Set<string>;
	classNames: Set<string>;
}

type QueryBinds = Map<number, Map<string, QueryVarBind>>;

interface FnRange {
	start: number;
	end: number;
}

interface PendingColumnAccess {
	queryIdent?: string;
	column: string;
	start: number;
	end: number;
	nodeStart: number;
}

function isFunctionNode(node: AnyNode | undefined): boolean {
	return (
		node?.type === "FunctionExpression" ||
		node?.type === "ArrowFunctionExpression" ||
		node?.type === "FunctionDeclaration"
	);
}

function collectFunctions(ast: AnyNode): FnRange[] {
	const functions: FnRange[] = [];
	walk.simple(ast, {
		FunctionExpression(node: AnyNode) {
			if (typeof node.start === "number" && typeof node.end === "number") {
				functions.push({ start: node.start, end: node.end });
			}
		},
		ArrowFunctionExpression(node: AnyNode) {
			if (typeof node.start === "number" && typeof node.end === "number") {
				functions.push({ start: node.start, end: node.end });
			}
		},
		FunctionDeclaration(node: AnyNode) {
			if (typeof node.start === "number" && typeof node.end === "number") {
				functions.push({ start: node.start, end: node.end });
			}
		}
	} as any);
	return functions;
}

function collectProperties(ast: AnyNode): AnyNode[] {
	const properties: AnyNode[] = [];
	walk.simple(ast, {
		Property(node: AnyNode) {
			properties.push(node);
		}
	} as any);
	return properties;
}

function innermostFn(functions: FnRange[], offset: number): number {
	let bestStart = -1;
	let best = 0;
	for (const fn of functions) {
		if (fn.start <= offset && offset < fn.end && fn.start > bestStart) {
			bestStart = fn.start;
			best = fn.start;
		}
	}
	return best;
}

function ensureBind(
	binds: QueryBinds,
	fnStart: number,
	varName: string
): QueryVarBind {
	let fnBinds = binds.get(fnStart);
	if (!fnBinds) {
		fnBinds = new Map();
		binds.set(fnStart, fnBinds);
	}
	let bind = fnBinds.get(varName);
	if (!bind) {
		bind = { entities: new Set(), classNames: new Set() };
		fnBinds.set(varName, bind);
	}
	return bind;
}

function addEntityBind(
	binds: QueryBinds,
	fnStart: number,
	varName: string,
	entity: string
): void {
	ensureBind(binds, fnStart, varName).entities.add(entity);
}

function addClassBind(
	binds: QueryBinds,
	fnStart: number,
	varName: string,
	className: string
): void {
	ensureBind(binds, fnStart, varName).classNames.add(className);
}

function getBindsAt(
	binds: QueryBinds,
	fnStart: number,
	varName: string
): QueryVarBind | undefined {
	return binds.get(fnStart)?.get(varName);
}

function isExtCreateCallee(callee: AnyNode): boolean {
	if (callee.type !== "MemberExpression" || callee.computed) {
		return false;
	}
	const prop = callee.property as AnyNode;
	if (prop?.type !== "Identifier" || prop.name !== "create") {
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

/** Dotted class name from a `new`/`Ext.create` callee - `BPMSoft.EntitySchemaQuery`
 * for both `new BPMSoft.EntitySchemaQuery(...)` (MemberExpression chain) and a
 * bare `new SomeLocalAlias(...)` (Identifier). */
function memberExpressionName(node: AnyNode | undefined): string | undefined {
	if (!node) {
		return undefined;
	}
	if (node.type === "Identifier") {
		return node.name as string;
	}
	if (node.type === "MemberExpression" && !node.computed) {
		const obj = memberExpressionName(node.object as AnyNode);
		const prop = node.property as AnyNode;
		if (obj && prop?.type === "Identifier") {
			return `${obj}.${prop.name}`;
		}
	}
	return undefined;
}

/** Class name + config-object argument from either construction syntax the
 * platform actually uses: `Ext.create("BPMSoft.X", {...})` (className is a
 * string literal, config is the 2nd argument) or `new BPMSoft.X({...})`
 * (className comes from the callee itself, config is the 1st argument). */
function extractClassNameAndConfig(
	node: AnyNode
): { className: string; configNode?: AnyNode } | undefined {
	if (node.type === "CallExpression") {
		const callee = node.callee as AnyNode;
		if (!isExtCreateCallee(callee)) {
			return undefined;
		}
		const args = node.arguments as AnyNode[];
		const arg0 = args[0];
		if (arg0?.type !== "Literal" || typeof arg0.value !== "string") {
			return undefined;
		}
		return { className: arg0.value, configNode: args[1] };
	}
	if (node.type === "NewExpression") {
		const className = memberExpressionName(node.callee as AnyNode);
		if (!className) {
			return undefined;
		}
		const args = node.arguments as AnyNode[];
		return { className, configNode: args[0] };
	}
	return undefined;
}

function parseExtCreateQuery(
	call: AnyNode
): { className: string; entity?: string } | undefined {
	const extracted = extractClassNameAndConfig(call);
	if (!extracted || !QUERY_CLASS_NAMES.has(extracted.className)) {
		return undefined;
	}
	const result: { className: string; entity?: string } = {
		className: extracted.className
	};
	const configNode = extracted.configNode;
	if (configNode?.type === "ObjectExpression") {
		for (const prop of configNode.properties as AnyNode[]) {
			if (prop.type !== "Property") {
				continue;
			}
			if (propName(prop) !== "rootSchemaName") {
				continue;
			}
			const val = prop.value as AnyNode;
			if (val?.type === "Literal" && typeof val.value === "string") {
				result.entity = val.value;
			}
		}
	}
	return result;
}

function processCallBinds(
	node: AnyNode,
	binds: QueryBinds,
	functions: FnRange[],
	properties: AnyNode[]
): void {
	const callee = node.callee as AnyNode;
	if (callee.type === "MemberExpression" && !callee.computed) {
		const obj = callee.object as AnyNode;
		const prop = callee.property as AnyNode;
		if (
			obj?.type === "Identifier" &&
			obj.name === "filters" &&
			prop?.type === "Identifier" &&
			prop.name === "add"
		) {
			return;
		}
	}
	let methodName: string | undefined;
	if (callee.type === "MemberExpression" && !callee.computed) {
		const obj = callee.object as AnyNode;
		const prop = callee.property as AnyNode;
		if (prop?.type === "Identifier" && obj?.type === "ThisExpression") {
			methodName = prop.name;
		}
	} else if (callee.type === "Identifier") {
		methodName = callee.name;
	}
	if (!methodName) {
		return;
	}
	const fnStart = innermostFn(functions, node.start);
	const args = node.arguments as AnyNode[];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg?.type !== "Identifier") {
			continue;
		}
		const bind = getBindsAt(binds, fnStart, arg.name);
		if (
			!bind ||
			(bind.entities.size === 0 && bind.classNames.size === 0)
		) {
			continue;
		}
		for (const prop of properties) {
			if (propName(prop) !== methodName) {
				continue;
			}
			const value = prop.value as AnyNode;
			if (!isFunctionNode(value)) {
				continue;
			}
			const params = value.params as AnyNode[];
			if (i >= params.length) {
				continue;
			}
			const param = params[i];
			if (param?.type !== "Identifier") {
				continue;
			}
			for (const entity of bind.entities) {
				addEntityBind(binds, value.start, param.name, entity);
			}
			for (const className of bind.classNames) {
				addClassBind(binds, value.start, param.name, className);
			}
		}
	}
}

function buildBindsFromAst(
	ast: AnyNode
): { binds: QueryBinds; functions: FnRange[] } {
	const binds: QueryBinds = new Map();
	const functions = collectFunctions(ast);
	const properties = collectProperties(ast);

	walk.simple(ast, {
		VariableDeclarator(node: AnyNode) {
			const id = node.id as AnyNode | undefined;
			const init = node.init as AnyNode | undefined;
			if (!init || id?.type !== "Identifier") {
				return;
			}
			const parsed = parseExtCreateQuery(init);
			if (parsed) {
				const fnStart = innermostFn(functions, node.start);
				addClassBind(binds, fnStart, id.name, parsed.className);
				if (parsed.entity) {
					addEntityBind(binds, fnStart, id.name, parsed.entity);
				}
			}
		},
		AssignmentExpression(node: AnyNode) {
			const left = node.left as AnyNode;
			const right = node.right as AnyNode;
			if (left?.type === "Identifier") {
				const parsed = parseExtCreateQuery(right);
				if (parsed) {
					const fnStart = innermostFn(functions, node.start);
					addClassBind(binds, fnStart, left.name, parsed.className);
					if (parsed.entity) {
						addEntityBind(binds, fnStart, left.name, parsed.entity);
					}
				}
			}
			if (left?.type === "MemberExpression" && !left.computed) {
				const obj = left.object as AnyNode;
				const prop = left.property as AnyNode;
				if (
					obj?.type === "Identifier" &&
					prop?.type === "Identifier" &&
					prop.name === "rootSchemaName" &&
					right?.type === "Literal" &&
					typeof right.value === "string"
				) {
					addEntityBind(
						binds,
						innermostFn(functions, node.start),
						obj.name,
						right.value
					);
				}
			}
		}
	} as any);

	for (let round = 0; round < 3; round++) {
		walk.simple(ast, {
			CallExpression(node: AnyNode) {
				processCallBinds(node, binds, functions, properties);
			}
		} as any);
	}

	return { binds, functions };
}

/** A dangling `ident.` with nothing after the dot (no property name typed
 * yet) is invalid JS - exactly the shape the live buffer is in right when a
 * `.`-triggered completion request fires, since there's no auto-inserted text
 * to keep it valid the way e.g. auto-closed quotes/parens do for a string- or
 * call-argument completion. `acorn.parse` has no error recovery, so that one
 * dangling dot anywhere in the file fails the *entire* parse and silently
 * empties every ESQ bind in it. Patching in a placeholder property name right
 * at the completion offset (only ever tried as a fallback after a first parse
 * already failed) turns it back into valid JS without shifting any position
 * at or before `offset`. */
function patchDanglingDotForCompletion(source: string, offset: number): string | undefined {
	let i = offset;
	while (i > 0 && (source[i - 1] === " " || source[i - 1] === "\t")) {
		i--;
	}
	if (i > 0 && source[i - 1] === ".") {
		return `${source.slice(0, offset)}__bpmsoftCursor__${source.slice(offset)}`;
	}
	return undefined;
}

function parseJsTolerant(source: string, offsetHint?: number): AnyNode | undefined {
	const direct = parseJs(source);
	if (direct || typeof offsetHint !== "number") {
		return direct;
	}
	const patched = patchDanglingDotForCompletion(source, offsetHint);
	return patched ? parseJs(patched) : undefined;
}

function analyzeQuerySource(
	source: string,
	offsetHint?: number
):
	| { ast: AnyNode; binds: QueryBinds; functions: FnRange[] }
	| { ast: undefined; binds: QueryBinds; functions: FnRange[] } {
	const ast = parseJsTolerant(source, offsetHint);
	const binds: QueryBinds = new Map();
	if (!ast) {
		return { ast: undefined, binds, functions: [] };
	}
	const { binds: builtBinds, functions } = buildBindsFromAst(ast);
	return { ast, binds: builtBinds, functions };
}

function resolveBindNames(
	binds: QueryBinds,
	functions: FnRange[],
	offset: number,
	queryIdent: string | undefined,
	field: "entities" | "classNames"
): string[] {
	const fnStart = innermostFn(functions, offset);
	if (queryIdent) {
		const bind = getBindsAt(binds, fnStart, queryIdent);
		if (bind && bind[field].size > 0) {
			return [...bind[field]].sort();
		}
		const rootBind = getBindsAt(binds, 0, queryIdent);
		if (rootBind && rootBind[field].size > 0) {
			return [...rootBind[field]].sort();
		}
		return [];
	}
	const fnBinds = binds.get(fnStart);
	if (!fnBinds) {
		return [];
	}
	const all = new Set<string>();
	for (const bind of fnBinds.values()) {
		for (const name of bind[field]) {
			all.add(name);
		}
	}
	return [...all].sort();
}

export function resolveQueryEntities(
	source: string,
	offset: number,
	queryIdent?: string
): string[] {
	const { binds, functions } = analyzeQuerySource(source, offset);
	return resolveBindNames(binds, functions, offset, queryIdent, "entities");
}

export function resolveQueryClassNames(
	source: string,
	offset: number,
	queryIdent?: string
): string[] {
	const { binds, functions } = analyzeQuerySource(source, offset);
	return resolveBindNames(binds, functions, offset, queryIdent, "classNames");
}

export function collectEsqColumnAccesses(source: string): EsqColumnAccess[] {
	const analyzed = analyzeQuerySource(source);
	if (!analyzed.ast) {
		return [];
	}
	const { ast, binds, functions } = analyzed;
	const pending: PendingColumnAccess[] = [];

	walk.simple(ast, {
		CallExpression(node: AnyNode) {
			const callee = node.callee as AnyNode;
			if (callee.type !== "MemberExpression" || callee.computed) {
				return;
			}
			const obj = callee.object as AnyNode;
			const prop = callee.property as AnyNode;
			if (obj?.type !== "Identifier" || prop?.type !== "Identifier") {
				return;
			}
			const method = prop.name;
			const queryIdent =
				obj.name === "this" || obj.name === "BPMSoft" ? undefined : obj.name;
			const args = node.arguments as AnyNode[];

			const recordArg = (arg: AnyNode | undefined, ident: string | undefined) => {
				if (!arg || arg.type !== "Literal" || typeof arg.value !== "string") {
					return;
				}
				if (!COLUMN_LITERAL_RE.test(arg.value)) {
					return;
				}
				pending.push({
					queryIdent: ident,
					column: arg.value,
					start: arg.start + 1,
					end: arg.end - 1,
					nodeStart: node.start
				});
			};

			if (COLUMN_ARG0.has(method)) {
				recordArg(args[0], queryIdent);
			}
			if (COLUMN_ARG1.has(method)) {
				recordArg(args[1], queryIdent);
			}
		}
	} as any);

	return pending.map((item) => ({
		entityNames: resolveBindNames(
			binds,
			functions,
			item.nodeStart,
			item.queryIdent,
			"entities"
		),
		column: item.column,
		start: item.start,
		end: item.end
	}));
}

export interface ConstructorConfigContext {
	className: string;
	typed: string;
	nameStart: number;
	nameEnd: number;
	existingKeys: Set<string>;
}

const IDENT_CHAR_RE = /[\w$]/;

/** Completion for the config-object argument of `Ext.create("Some.Class", {…})`
 * / `new Some.Class({…})` - not limited to the 4 ESQ classes above, since
 * `SymbolIndex.resolveQueryInstanceMembers` (the consumer) already works for
 * any indexed Ext class by name, not just query ones. Picks the *innermost*
 * matching call whose config object's own range contains `offset` (a nested
 * `Ext.create(...)` as a property value must not be shadowed by its outer
 * call). Returns undefined for any position inside an already-typed
 * `key: value` pair's value (a different completion, e.g. `rootSchemaName`'s
 * entity-name completion, owns that spot) - only a bare key position (typing
 * a new key, or still inside an existing/shorthand key) counts. */
export function getConstructorConfigContext(
	source: string,
	offset: number
): ConstructorConfigContext | undefined {
	const ast = parseJsTolerant(source, offset);
	if (!ast) {
		return undefined;
	}

	let best: { className: string; obj: AnyNode } | undefined;
	const consider = (node: AnyNode) => {
		const extracted = extractClassNameAndConfig(node);
		const obj = extracted?.configNode;
		if (!extracted || !obj || obj.type !== "ObjectExpression") {
			return;
		}
		if (typeof obj.start !== "number" || typeof obj.end !== "number") {
			return;
		}
		if (offset < obj.start || offset > obj.end) {
			return;
		}
		if (!best || obj.end - obj.start < best.obj.end - best.obj.start) {
			best = { className: extracted.className, obj };
		}
	};
	walk.simple(ast, {
		CallExpression: consider,
		NewExpression: consider
	} as any);
	if (!best) {
		return undefined;
	}

	const properties = best.obj.properties as AnyNode[];
	const existingKeys = new Set<string>();
	for (const prop of properties) {
		if (prop.type !== "Property") {
			continue;
		}
		const name = propName(prop);
		const key = prop.key as AnyNode;
		if (
			typeof key?.start === "number" &&
			typeof key?.end === "number" &&
			offset >= key.start &&
			offset <= key.end
		) {
			const siblingKeys = new Set<string>();
			for (const sibling of properties) {
				const siblingName = propName(sibling);
				if (siblingName && siblingName !== name) {
					siblingKeys.add(siblingName);
				}
			}
			return {
				className: best.className,
				typed: name || "",
				nameStart: key.start,
				nameEnd: key.end,
				existingKeys: siblingKeys
			};
		}
		if (
			typeof prop.start === "number" &&
			typeof prop.end === "number" &&
			typeof key?.end === "number" &&
			offset > key.end &&
			offset <= prop.end
		) {
			// Inside this property's own value (string, nested object, …) -
			// not a config-key position.
			return undefined;
		}
		if (name) {
			existingKeys.add(name);
		}
	}

	// A "gap" between properties (right after `{`, after a trailing comma, or
	// before `}`) - typing a brand new key.
	let start = offset;
	while (start > 0 && IDENT_CHAR_RE.test(source[start - 1])) {
		start--;
	}
	let end = offset;
	while (end < source.length && IDENT_CHAR_RE.test(source[end])) {
		end++;
	}
	return {
		className: best.className,
		typed: source.slice(start, end),
		nameStart: start,
		nameEnd: end,
		existingKeys
	};
}
