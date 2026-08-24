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

function parseExtCreateQuery(
	call: AnyNode
): { className: string; entity?: string } | undefined {
	if (call.type !== "CallExpression") {
		return undefined;
	}
	const callee = call.callee as AnyNode;
	if (!isExtCreateCallee(callee)) {
		return undefined;
	}
	const args = call.arguments as AnyNode[];
	if (args.length < 1) {
		return undefined;
	}
	const arg0 = args[0];
	if (arg0.type !== "Literal" || typeof arg0.value !== "string") {
		return undefined;
	}
	if (!QUERY_CLASS_NAMES.has(arg0.value)) {
		return undefined;
	}
	const result: { className: string; entity?: string } = {
		className: arg0.value
	};
	const arg1 = args[1];
	if (arg1?.type === "ObjectExpression") {
		for (const prop of arg1.properties as AnyNode[]) {
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

function analyzeQuerySource(
	source: string
):
	| { ast: AnyNode; binds: QueryBinds; functions: FnRange[] }
	| { ast: undefined; binds: QueryBinds; functions: FnRange[] } {
	const ast = parseJs(source);
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
	const { binds, functions } = analyzeQuerySource(source);
	return resolveBindNames(binds, functions, offset, queryIdent, "entities");
}

export function resolveQueryClassNames(
	source: string,
	offset: number,
	queryIdent?: string
): string[] {
	const { binds, functions } = analyzeQuerySource(source);
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
