import * as acorn from "acorn";
import * as walk from "acorn-walk";
import {
	IndexedMember,
	IndexedModule,
	memberDedupeKey
} from "../index/types";
import { AnyNode, parseJs } from "./jsAst";
import {
	isExtDefineCall,
	extDefineParts,
	applyExtDefine,
	findSchemaSection,
	collectSchemaAttributes,
	parseDefineCall
} from "./amdAst";

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

export {
	getMemberAccessPrefix,
	getIdentifierAt,
	getCallParentContext,
	getThisGetSetContext,
	getThisSandboxMessageContext,
	getDiffBindToContext,
	getThisLookupAccessContext,
	rewriteThisRuntimePrefix
} from "./amdCursor";
export type {
	ThisGetSetContext,
	ThisSandboxMessageContext,
	DiffBindToContext,
	ThisLookupAccessContext
} from "./amdCursor";

export {
	collectThisMemberAccesses,
	planCreateMemberInsert
} from "./amdThisAccess";
export type {
	ThisMemberAccessKind,
	ThisMemberAccess,
	CreateMemberKind,
	TextInsert
} from "./amdThisAccess";

export {
	getOverrideInsertContext,
	formatOverrideSnippet,
	collectLocalMethodKeys
} from "./amdOverride";
export type { OverrideInsertContext } from "./amdOverride";
