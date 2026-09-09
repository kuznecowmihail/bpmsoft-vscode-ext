import * as acorn from "acorn";
import {
	collectSchemaUnusedIssues,
	collectDiffDuplicateIssues,
	collectDiffGuidNameIssues,
	InheritedSchemaNames
} from "./schemaUsageAnalyzer";
import { AnyNode, childNodes, parseJs } from "./jsAst";
import { KNOWN_JSDOC_TAGS, nearestKnownTag } from "./docTagCheck";
import { isSuppressedAbove } from "./suppressComments";
export { isSuppressedAbove } from "./suppressComments";

type StyleIssueKind =
	| "krBrace"
	| "krCuddle"
	| "varDecl"
	| "constAssign"
	| "ifElseChain"
	| "eqeqeq"
	| "unusedVar"
	| "unusedParam"
	| "unreachable"
	| "switchFallthrough"
	| "switchDuplicateCase"
	| "curly"
	| "debuggerStmt"
	| "consoleCall"
	| "nanCompare"
	| "duplicateKey"
	| "duplicateDiff"
	| "diffGuidName"
	| "unusedMethod"
	| "unusedAttribute"
	| "unusedMessage"
	| "allmanBrace"
	| "allmanCuddle"
	| "pascalMethod"
	| "pascalProperty"
	| "privateField"
	| "camelLocal"
	| "camelParam"
	| "camelMethod"
	| "pascalType"
	| "interfacePrefix"
	| "emptyCatch"
	| "nullPattern"
	| "asyncSuffix"
	| "idSuffix"
	| "flagsEnumValue"
	| "delegateSuffix"
	| "commentSpacing"
	| "xmlDocMissing"
	| "trailingComment"
	| "selectAllColumnsHint"
	| "jsDocTagTypo"
	| "xmlDocTagTypo";

export interface StyleFix {
	title: string;
	start: number;
	end: number;
	text: string;
}

export interface StyleIssue {
	kind: StyleIssueKind;
	start: number;
	end: number;
	message: string;
	severity: "warning" | "error" | "info";
	fix?: StyleFix;
}

/** Kinds that can be silenced at a specific call site via `// bpmsoft-ignore: <id>`. */
export const SUPPRESSIBLE_RULE_IDS: Partial<Record<StyleIssueKind, string>> = {
	selectAllColumnsHint: "select-all-columns",
	diffGuidName: "diff-guid-name"
};

/**
 * Issue kinds whose `fix` is safe to batch-apply automatically (the
 * formatter) rather than one at a time with a human looking at each —
 * pure brace/spacing/comment repositioning and rewrites that don't change
 * an identifier's name. Deliberately excluded:
 * - renames (pascalMethod/pascalProperty/privateField/camelLocal/camelParam/
 *   camelMethod/pascalType/interfacePrefix/idSuffix/delegateSuffix/
 *   asyncSuffix) — a StyleFix only rewrites its own declaration span; it
 *   does not know about (or touch) call sites elsewhere in the file or in
 *   other files, so batch-renaming every flagged declaration on save would
 *   silently break every reference to it.
 * - deletions (unusedMethod/unusedAttribute/unusedMessage/debuggerStmt/
 *   consoleCall) — "unused" is a heuristic with real false-positive edge
 *   cases (dynamic dispatch, bindTo strings, mixins); deleting code a
 *   developer wrote should go through a reviewed quick-fix, not a silent
 *   save-time formatter.
 * - structural rewrites (switchFallthrough's inserted `break`, which can
 *   change behavior if the fallthrough was intentional; ifElseChain's
 *   switch rewrite, which is a refactor, not a format).
 */
export const AUTO_FORMAT_SAFE_KINDS: ReadonlySet<StyleIssueKind> = new Set<StyleIssueKind>([
	"krBrace",
	"krCuddle",
	"varDecl",
	"constAssign",
	"eqeqeq",
	"curly",
	"nanCompare",
	"allmanBrace",
	"allmanCuddle",
	"nullPattern",
	"commentSpacing",
	"trailingComment",
	"jsDocTagTypo",
	"xmlDocTagTypo"
]);

type BindingKind = "const" | "let" | "var" | "param" | "function";

interface Binding {
	kind: BindingKind;
	assigned: boolean;
	read: boolean;
	keywordStart: number;
	identStart: number;
	identEnd: number;
	skipUnused?: boolean;
}

interface Scope {
	parent?: Scope;
	isFunction: boolean;
	bindings: Map<string, Binding>;
	usesArguments: boolean;
}

interface AnalyzeCtx {
	source: string;
	issues: StyleIssue[];
	pendingVars: PendingVar[];
	allScopes: Scope[];
}

const IF_CHAIN_WARN_AFTER = 3;
const CONSOLE_METHODS = new Set([
	"log",
	"warn",
	"error",
	"info",
	"debug",
	"table",
	"dir",
	"trace"
]);

interface PendingVar {
	node: AnyNode;
	scope: Scope;
}

export function collectStyleIssues(
	source: string,
	inherited?: InheritedSchemaNames
): StyleIssue[] {
	const comments: acorn.Comment[] = [];
	const ast = parseJs(source, comments);
	if (!ast) {
		return [];
	}
	const issues: StyleIssue[] = [];
	const pendingVars: PendingVar[] = [];
	const allScopes: Scope[] = [];
	const programScope: Scope = {
		isFunction: true,
		bindings: new Map(),
		usesArguments: false
	};
	allScopes.push(programScope);
	const ctx: AnalyzeCtx = { source, issues, pendingVars, allScopes };
	hoistVars(ast, programScope);
	visit(ast, programScope, ctx, false);
	for (const item of pendingVars) {
		issues.push(varIssue(item.node, item.scope));
	}
	pushUnusedBindings(ctx);
	issues.push(...collectSchemaUnusedIssues(source, inherited, ast));
	issues.push(...collectDiffDuplicateIssues(ast));
	issues.push(...collectDiffGuidNameIssues(ast, source));
	issues.push(...collectTrailingCommentIssues(source, comments));
	issues.push(...collectJsDocTagIssues(comments));
	return issues;
}

function visit(
	node: AnyNode | undefined | null,
	scope: Scope,
	ctx: AnalyzeCtx,
	isElseIf: boolean
): void {
	if (!node || typeof node.type !== "string") {
		return;
	}
	switch (node.type) {
		case "FunctionDeclaration":
			visitFunction(node, scope, ctx, false);
			return;
		case "FunctionExpression":
		case "ArrowFunctionExpression":
			visitFunction(node, scope, ctx, false);
			return;
		case "BlockStatement":
			visitBlock(node, newScope(scope, false, ctx), ctx);
			return;
		case "IfStatement":
			visitIf(node, scope, ctx, isElseIf);
			return;
		case "ForStatement":
		case "ForInStatement":
		case "ForOfStatement":
			visitFor(node, scope, ctx);
			return;
		case "WhileStatement":
			visit(node.test, scope, ctx, false);
			checkCurly(ctx, node.body);
			checkOpeningBrace(ctx.source, ctx.issues, node.body);
			visit(node.body, scope, ctx, false);
			return;
		case "DoWhileStatement":
			checkCurly(ctx, node.body);
			checkOpeningBrace(ctx.source, ctx.issues, node.body);
			visit(node.body, scope, ctx, false);
			visit(node.test, scope, ctx, false);
			checkCuddle(ctx.source, ctx.issues, blockEnd(node.body), node.test.start, "while");
			return;
		case "TryStatement":
			visitTry(node, scope, ctx);
			return;
		case "SwitchStatement":
			visitSwitch(node, scope, ctx);
			return;
		case "ClassDeclaration":
		case "ClassExpression":
			visitClass(node, scope, ctx);
			return;
		case "VariableDeclaration":
			visitVariableDeclaration(node, scope, ctx);
			return;
		case "AssignmentExpression":
			markAssignment(node.left, scope, ctx.issues);
			checkAllColumnsAssignment(node, ctx);
			visitLValue(node.left, scope, ctx);
			visit(node.right, scope, ctx, false);
			return;
		case "UpdateExpression":
			markAssignment(node.argument, scope, ctx.issues);
			if (node.argument?.type === "Identifier") {
				markRead(scope, node.argument);
			} else {
				visit(node.argument, scope, ctx, false);
			}
			return;
		case "Identifier":
			markRead(scope, node);
			return;
		case "MemberExpression":
			visit(node.object, scope, ctx, false);
			if (node.computed) {
				visit(node.property, scope, ctx, false);
			}
			return;
		case "ObjectExpression":
			checkDuplicateKeys(node, ctx);
			for (const prop of (node.properties as AnyNode[]) || []) {
				if (prop.type === "SpreadElement") {
					visit(prop.argument, scope, ctx, false);
					continue;
				}
				if (prop.computed) {
					visit(prop.key, scope, ctx, false);
				} else {
					checkMethodPropertyName(prop, ctx);
				}
				visit(prop.value, scope, ctx, false);
			}
			return;
		case "BinaryExpression":
			checkEqeqeq(node, ctx);
			checkNanCompare(node, ctx);
			visit(node.left, scope, ctx, false);
			visit(node.right, scope, ctx, false);
			return;
		case "CallExpression":
			visitCall(node, scope, ctx);
			return;
		case "ExpressionStatement":
			if (isConsoleCall(node.expression)) {
				pushConsoleIssue(node, ctx);
			}
			visit(node.expression, scope, ctx, false);
			return;
		case "DebuggerStatement":
			ctx.issues.push({
				kind: "debuggerStmt",
				start: node.start,
				end: node.end,
				message: "Инструкция debugger",
				severity: "warning",
				fix: {
					title: "Удалить debugger",
					start: node.start,
					end: node.end,
					text: ""
				}
			});
			return;
		case "LabeledStatement":
			visit(node.body, scope, ctx, false);
			return;
		default:
			break;
	}
	for (const child of childNodes(node)) {
		visit(child, scope, ctx, false);
	}
}

function visitBlock(node: AnyNode, scope: Scope, ctx: AnalyzeCtx): void {
	let dead = false;
	for (const stmt of node.body as AnyNode[]) {
		if (dead && stmt.type !== "FunctionDeclaration") {
			ctx.issues.push({
				kind: "unreachable",
				start: stmt.start,
				end: Math.min(stmt.end, stmt.start + 12),
				message: "Недостижимый код",
				severity: "warning"
			});
			dead = false;
		}
		visit(stmt, scope, ctx, false);
		if (isTerminator(stmt)) {
			dead = true;
		}
	}
}

function visitFunction(
	node: AnyNode,
	parent: Scope,
	ctx: AnalyzeCtx,
	skipUnusedParams: boolean
): void {
	const fnScope = newScope(parent, true, ctx);
	if (node.id?.type === "Identifier" && node.id.name) {
		if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
			checkCamelName(ctx, node.id, "camelMethod", "Метод");
		}
	}
	if (node.type === "FunctionExpression" && node.id?.name) {
		bindName(
			fnScope,
			node.id.name,
			"function",
			node.start,
			node.id.start,
			node.id.end
		);
	}
	for (const param of node.params as AnyNode[]) {
		bindPattern(fnScope, param, "param", node.start);
		if (skipUnusedParams) {
			forEachIdent(param, (ident) => {
				const binding = fnScope.bindings.get(ident.name);
				if (binding) {
					binding.skipUnused = true;
				}
			});
		} else {
			forEachIdent(param, (ident) =>
				checkCamelName(ctx, ident, "camelParam", "Параметр")
			);
		}
		if (param.type === "AssignmentPattern") {
			visit(param.right, fnScope, ctx, false);
		}
	}
	const body = node.body as AnyNode;
	if (body?.type === "BlockStatement") {
		hoistVars(body, fnScope);
		checkOpeningBrace(ctx.source, ctx.issues, body);
		visitBlock(body, newScope(fnScope, false, ctx), ctx);
		return;
	}
	visit(body, fnScope, ctx, false);
}

function visitIf(node: AnyNode, scope: Scope, ctx: AnalyzeCtx, isElseIf: boolean): void {
	if (!isElseIf) {
		maybeIfElseChain(node, ctx.source, ctx.issues);
	}
	visit(node.test, scope, ctx, false);
	checkCurly(ctx, node.consequent);
	checkOpeningBrace(ctx.source, ctx.issues, node.consequent);
	visit(node.consequent, scope, ctx, false);
	const alt = node.alternate as AnyNode | undefined;
	if (!alt) {
		return;
	}
	checkCuddle(ctx.source, ctx.issues, blockEnd(node.consequent), alt.start, "else");
	if (alt.type === "IfStatement") {
		visitIf(alt, scope, ctx, true);
		return;
	}
	checkCurly(ctx, alt);
	checkOpeningBrace(ctx.source, ctx.issues, alt);
	visit(alt, scope, ctx, false);
}

function visitFor(node: AnyNode, parent: Scope, ctx: AnalyzeCtx): void {
	const forScope = newScope(parent, false, ctx);
	if (node.type === "ForStatement") {
		visit(node.init, forScope, ctx, false);
		visit(node.test, forScope, ctx, false);
		visit(node.update, forScope, ctx, false);
	} else {
		const left = node.left as AnyNode;
		if (left?.type === "VariableDeclaration") {
			visitVariableDeclaration(left, forScope, ctx);
		} else {
			markAssignment(left, forScope, ctx.issues);
			visitLValue(left, forScope, ctx);
		}
		visit(node.right, forScope, ctx, false);
	}
	checkCurly(ctx, node.body);
	checkOpeningBrace(ctx.source, ctx.issues, node.body);
	visit(node.body, forScope, ctx, false);
}

function visitTry(node: AnyNode, scope: Scope, ctx: AnalyzeCtx): void {
	checkOpeningBrace(ctx.source, ctx.issues, node.block);
	visit(node.block, scope, ctx, false);
	const handler = node.handler as AnyNode | undefined;
	if (handler) {
		checkCuddle(ctx.source, ctx.issues, blockEnd(node.block), handler.start, "catch");
		visitCatch(handler, scope, ctx);
	}
	const finalizer = node.finalizer as AnyNode | undefined;
	if (finalizer) {
		const after = handler ? blockEnd(handler.body) : blockEnd(node.block);
		checkCuddle(ctx.source, ctx.issues, after, finalizer.start, "finally");
		checkOpeningBrace(ctx.source, ctx.issues, finalizer);
		visit(finalizer, scope, ctx, false);
	}
}

function visitCatch(node: AnyNode, parent: Scope, ctx: AnalyzeCtx): void {
	const catchScope = newScope(parent, false, ctx);
	if (node.param) {
		bindPattern(catchScope, node.param, "param", node.start);
		forEachIdent(node.param, (ident) =>
			checkCamelName(ctx, ident, "camelLocal", "Переменная")
		);
	}
	checkOpeningBrace(ctx.source, ctx.issues, node.body);
	visit(node.body, catchScope, ctx, false);
}

function visitClass(node: AnyNode, scope: Scope, ctx: AnalyzeCtx): void {
	if (node.id?.name && node.type === "ClassDeclaration") {
		bindName(scope, node.id.name, "let", node.start, node.id.start, node.id.end);
	}
	const body = node.body as AnyNode;
	checkOpeningBrace(ctx.source, ctx.issues, body);
	for (const item of (body.body as AnyNode[]) || []) {
		if (item.computed) {
			visit(item.key, scope, ctx, false);
		} else {
			checkMethodPropertyName(item, ctx);
		}
		visit(item.value || item, scope, ctx, false);
	}
}

function visitVariableDeclaration(node: AnyNode, scope: Scope, ctx: AnalyzeCtx): void {
	const kind = node.kind as BindingKind;
	const keywordStart = node.start as number;
	for (const decl of node.declarations as AnyNode[]) {
		visit(decl.init, scope, ctx, false);
		if (kind === "var") {
			bindPattern(functionScope(scope), decl.id, "var", keywordStart);
		} else if (kind === "const" || kind === "let") {
			bindPattern(scope, decl.id, kind, keywordStart);
		}
		if (decl.id?.type === "Identifier" && isFunctionNode(decl.init)) {
			checkCamelName(ctx, decl.id, "camelMethod", "Метод");
		} else {
			forEachIdent(decl.id, (ident) =>
				checkCamelName(ctx, ident, "camelLocal", "Переменная", kind === "const")
			);
		}
	}
	if (kind === "var") {
		ctx.pendingVars.push({ node, scope });
	}
}

function visitSwitch(node: AnyNode, scope: Scope, ctx: AnalyzeCtx): void {
	visit(node.discriminant, scope, ctx, false);
	checkOpeningBrace(ctx.source, ctx.issues, node);
	const swScope = newScope(scope, false, ctx);
	const cases = node.cases as AnyNode[];
	const seen = new Map<string, number>();
	for (let i = 0; i < cases.length; i++) {
		const clause = cases[i];
		visit(clause.test, swScope, ctx, false);
		const key = caseKey(clause, ctx.source);
		const prev = seen.get(key);
		if (prev !== undefined) {
			const start = clause.test ? clause.test.start : clause.start;
			const end = clause.test ? clause.test.end : clause.start + 7;
			ctx.issues.push({
				kind: "switchDuplicateCase",
				start,
				end,
				message: "Повторяющаяся метка case",
				severity: "error"
			});
		} else {
			seen.set(key, i);
		}
		const consequent = clause.consequent as AnyNode[];
		let dead = false;
		for (const stmt of consequent) {
			if (dead && stmt.type !== "FunctionDeclaration") {
				ctx.issues.push({
					kind: "unreachable",
					start: stmt.start,
					end: Math.min(stmt.end, stmt.start + 12),
					message: "Недостижимый код",
					severity: "warning"
				});
				dead = false;
			}
			visit(stmt, swScope, ctx, false);
			if (isTerminator(stmt)) {
				dead = true;
			}
		}
		const first = consequent[0];
		if (first?.type === "BlockStatement") {
			checkOpeningBrace(ctx.source, ctx.issues, first);
		}
		if (i < cases.length - 1 && !caseTerminates(consequent)) {
			const last = consequent[consequent.length - 1];
			const indent = last ? lineIndent(ctx.source, last.start) : "\t";
			ctx.issues.push({
				kind: "switchFallthrough",
				start: clause.start,
				end: clause.start + 4,
				message: "Возможен провал в следующую ветку switch: добавьте break",
				severity: "warning",
				fix: last
					? {
							title: "Добавить break",
							start: last.end,
							end: last.end,
							text: `\n${indent}break;`
						}
					: undefined
			});
		}
	}
}

function varIssue(node: AnyNode, scope: Scope): StyleIssue {
	const start = node.start as number;
	const end = start + 3;
	const names: string[] = [];
	let allInited = true;
	for (const decl of node.declarations as AnyNode[]) {
		if (!decl.init) {
			allInited = false;
		}
		forEachIdent(decl.id, (ident) => names.push(ident.name));
	}
	const fn = functionScope(scope);
	const anyAssigned = names.some((name) => fn.bindings.get(name)?.assigned);
	const next = anyAssigned || !allInited ? "let" : "const";
	return {
		kind: "varDecl",
		start,
		end,
		message: "Объявление через var: используйте let или const",
		severity: "warning",
		fix: {
			title: `Заменить var на ${next}`,
			start,
			end,
			text: next
		}
	};
}

function maybeIfElseChain(node: AnyNode, source: string, issues: StyleIssue[]): void {
	const length = chainLength(node);
	if (length <= IF_CHAIN_WARN_AFTER) {
		return;
	}
	const chainEnd = lastAlternateEnd(node);
	const switchText = buildSwitchFromIfChain(source, node);
	issues.push({
		kind: "ifElseChain",
		start: node.start,
		end: (node.test as AnyNode).end,
		message:
			"Слишком длинная цепочка if/else (больше 3 ветвей): используйте switch",
		severity: "warning",
		fix: switchText
			? {
					title: "Заменить if/else на switch",
					start: node.start,
					end: chainEnd,
					text: switchText
				}
			: undefined
	});
}

function chainLength(node: AnyNode): number {
	let n = 1;
	let alt = node.alternate as AnyNode | undefined;
	while (alt) {
		n++;
		if (alt.type === "IfStatement") {
			alt = alt.alternate;
		} else {
			break;
		}
	}
	return n;
}

function lastAlternateEnd(node: AnyNode): number {
	let current = node;
	while (current.alternate) {
		current = current.alternate as AnyNode;
	}
	return current.end as number;
}

function markAssignment(
	left: AnyNode | undefined,
	scope: Scope,
	issues: StyleIssue[]
): void {
	if (!left || left.type === "MemberExpression") {
		return;
	}
	forEachIdent(left, (ident) => {
		const binding = lookup(scope, ident.name);
		if (!binding) {
			return;
		}
		binding.assigned = true;
		if (binding.kind !== "const") {
			return;
		}
		issues.push({
			kind: "constAssign",
			start: ident.start,
			end: ident.end,
			message: `Нельзя изменять переменную «${ident.name}», объявленную как const`,
			severity: "error",
			fix: {
				title: "Заменить const на let",
				start: binding.keywordStart,
				end: binding.keywordStart + 5,
				text: "let"
			}
		});
	});
}

function lookup(scope: Scope | undefined, name: string): Binding | undefined {
	for (let current = scope; current; current = current.parent) {
		const found = current.bindings.get(name);
		if (found) {
			return found;
		}
	}
	return undefined;
}

function newScope(parent: Scope, isFunction: boolean, ctx: AnalyzeCtx): Scope {
	const scope: Scope = {
		parent,
		isFunction,
		bindings: new Map(),
		usesArguments: false
	};
	ctx.allScopes.push(scope);
	return scope;
}

function functionScope(scope: Scope): Scope {
	let current = scope;
	while (current.parent && !current.isFunction) {
		current = current.parent;
	}
	return current;
}

function bindPattern(
	scope: Scope,
	id: AnyNode | undefined,
	kind: BindingKind,
	keywordStart: number
): void {
	forEachIdent(id, (ident) =>
		bindName(scope, ident.name, kind, keywordStart, ident.start, ident.end)
	);
}

function bindName(
	scope: Scope,
	name: string,
	kind: BindingKind,
	keywordStart: number,
	identStart: number,
	identEnd: number
): void {
	if (!scope.bindings.has(name)) {
		scope.bindings.set(name, {
			kind,
			assigned: false,
			read: false,
			keywordStart,
			identStart,
			identEnd
		});
	}
}

function hoistVars(node: AnyNode | undefined, fnScope: Scope): void {
	if (!node || typeof node.type !== "string") {
		return;
	}
	if (
		node.type === "FunctionExpression" ||
		node.type === "ArrowFunctionExpression"
	) {
		return;
	}
	if (node.type === "FunctionDeclaration") {
		if (node.id?.name) {
			bindName(
				fnScope,
				node.id.name,
				"function",
				node.start,
				node.id.start,
				node.id.end
			);
		}
		return;
	}
	if (node.type === "VariableDeclaration" && node.kind === "var") {
		for (const decl of node.declarations as AnyNode[]) {
			bindPattern(fnScope, decl.id, "var", node.start);
		}
	}
	for (const child of childNodes(node)) {
		hoistVars(child, fnScope);
	}
}

function forEachIdent(id: AnyNode | undefined, fn: (ident: AnyNode) => void): void {
	if (!id) {
		return;
	}
	if (id.type === "Identifier") {
		fn(id);
		return;
	}
	if (id.type === "MemberExpression") {
		return;
	}
	if (id.type === "ObjectPattern") {
		for (const prop of (id.properties as AnyNode[]) || []) {
			if (prop.type === "RestElement") {
				forEachIdent(prop.argument, fn);
			} else {
				forEachIdent(prop.value, fn);
			}
		}
		return;
	}
	if (id.type === "ArrayPattern") {
		for (const el of (id.elements as AnyNode[]) || []) {
			forEachIdent(el, fn);
		}
		return;
	}
	if (id.type === "AssignmentPattern") {
		forEachIdent(id.left, fn);
		return;
	}
	if (id.type === "RestElement") {
		forEachIdent(id.argument, fn);
	}
}

function markRead(scope: Scope, ident: AnyNode): void {
	if (ident.name === "arguments") {
		functionScope(scope).usesArguments = true;
		return;
	}
	const binding = lookup(scope, ident.name);
	if (binding) {
		binding.read = true;
	}
}

function visitLValue(node: AnyNode | undefined, scope: Scope, ctx: AnalyzeCtx): void {
	if (!node) {
		return;
	}
	if (node.type === "Identifier") {
		return;
	}
	if (node.type === "MemberExpression") {
		visit(node.object, scope, ctx, false);
		if (node.computed) {
			visit(node.property, scope, ctx, false);
		}
		return;
	}
	if (node.type === "AssignmentPattern") {
		visitLValue(node.left, scope, ctx);
		visit(node.right, scope, ctx, false);
		return;
	}
	if (node.type === "RestElement") {
		visitLValue(node.argument, scope, ctx);
		return;
	}
	if (node.type === "ObjectPattern") {
		for (const prop of (node.properties as AnyNode[]) || []) {
			if (prop.type === "RestElement") {
				visitLValue(prop.argument, scope, ctx);
			} else {
				if (prop.computed) {
					visit(prop.key, scope, ctx, false);
				}
				visitLValue(prop.value, scope, ctx);
			}
		}
		return;
	}
	if (node.type === "ArrayPattern") {
		for (const el of (node.elements as AnyNode[]) || []) {
			visitLValue(el, scope, ctx);
		}
	}
}

function visitCall(node: AnyNode, scope: Scope, ctx: AnalyzeCtx): void {
	const callee = node.callee as AnyNode;
	const isDefine = callee?.type === "Identifier" && callee.name === "define";
	checkExtCreateEsqAllColumns(node, ctx);
	visit(callee, scope, ctx, false);
	for (const arg of (node.arguments as AnyNode[]) || []) {
		if (
			isDefine &&
			(arg.type === "FunctionExpression" || arg.type === "ArrowFunctionExpression")
		) {
			visitFunction(arg, scope, ctx, true);
		} else {
			visit(arg, scope, ctx, false);
		}
	}
}

function pushSelectAllColumnsHint(ctx: AnalyzeCtx, start: number, end: number): void {
	if (isSuppressedAbove(ctx.source, start, "select-all-columns")) {
		return;
	}
	ctx.issues.push({
		kind: "selectAllColumnsHint",
		start,
		end,
		message: "Убедитесь, что нужны все колонки — уточните список для эффективности",
		severity: "info"
	});
}

function checkAllColumnsAssignment(node: AnyNode, ctx: AnalyzeCtx): void {
	const left = node.left as AnyNode;
	if (!left || left.type !== "MemberExpression" || left.computed) {
		return;
	}
	const prop = left.property as AnyNode;
	if (prop?.type !== "Identifier" || prop.name !== "allColumns") {
		return;
	}
	const right = node.right as AnyNode;
	if (right?.type === "Literal" && right.value === true) {
		pushSelectAllColumnsHint(ctx, node.start, node.end);
	}
}

function checkExtCreateEsqAllColumns(node: AnyNode, ctx: AnalyzeCtx): void {
	const callee = node.callee as AnyNode;
	if (!callee || callee.type !== "MemberExpression" || callee.computed) {
		return;
	}
	const obj = callee.object as AnyNode;
	const prop = callee.property as AnyNode;
	if (
		obj?.type !== "Identifier" ||
		obj.name !== "Ext" ||
		prop?.type !== "Identifier" ||
		prop.name !== "create"
	) {
		return;
	}
	const args = (node.arguments as AnyNode[]) || [];
	const classArg = args[0];
	if (classArg?.type !== "Literal" || classArg.value !== "BPMSoft.EntitySchemaQuery") {
		return;
	}
	const configArg = args[1];
	if (configArg?.type !== "ObjectExpression") {
		return;
	}
	for (const configProp of (configArg.properties as AnyNode[]) || []) {
		if (configProp.type !== "Property" || configProp.computed) {
			continue;
		}
		const key = configProp.key as AnyNode;
		const keyName =
			key?.type === "Identifier"
				? key.name
				: key?.type === "Literal"
					? String(key.value)
					: undefined;
		if (keyName !== "allColumns") {
			continue;
		}
		const value = configProp.value as AnyNode;
		if (value?.type === "Literal" && value.value === true) {
			pushSelectAllColumnsHint(ctx, key.start, value.end);
		}
	}
}

function isConsoleCall(node: AnyNode | undefined): boolean {
	if (!node || node.type !== "CallExpression") {
		return false;
	}
	const callee = node.callee as AnyNode;
	if (callee?.type !== "MemberExpression" || callee.computed) {
		return false;
	}
	const obj = callee.object as AnyNode;
	const prop = callee.property as AnyNode;
	return (
		obj?.type === "Identifier" &&
		obj.name === "console" &&
		prop?.type === "Identifier" &&
		CONSOLE_METHODS.has(prop.name)
	);
}

function pushConsoleIssue(node: AnyNode, ctx: AnalyzeCtx): void {
	const call = node.expression as AnyNode;
	const prop = (call.callee as AnyNode).property as AnyNode;
	let end = node.end as number;
	if (ctx.source[end] === ";") {
		end++;
	} else if (ctx.source[end - 1] !== ";" && ctx.source[call.end] === ";") {
		end = call.end + 1;
	}
	ctx.issues.push({
		kind: "consoleCall",
		start: call.start,
		end: call.end,
		message: `Отладочный вызов console.${prop.name}`,
		severity: "warning",
		fix: {
			title: `Удалить console.${prop.name}`,
			start: node.start,
			end,
			text: ""
		}
	});
}

function checkEqeqeq(node: AnyNode, ctx: AnalyzeCtx): void {
	if (node.operator !== "==" && node.operator !== "!=") {
		return;
	}
	if (isNullLiteral(node.left) || isNullLiteral(node.right)) {
		return;
	}
	if (isNaNIdent(node.left) || isNaNIdent(node.right)) {
		return;
	}
	const from = node.left.end as number;
	const to = node.right.start as number;
	const mid = ctx.source.slice(from, to);
	const next = node.operator === "==" ? "===" : "!==";
	const replaced = mid.replace(node.operator, next);
	ctx.issues.push({
		kind: "eqeqeq",
		start: from,
		end: to,
		message: `Используйте ${next} вместо ${node.operator}`,
		severity: "warning",
		fix: replaced === mid
			? undefined
			: { title: `Заменить на ${next}`, start: from, end: to, text: replaced }
	});
}

function isNullLiteral(node: AnyNode | undefined): boolean {
	return node?.type === "Literal" && node.value === null;
}

function checkNanCompare(node: AnyNode, ctx: AnalyzeCtx): void {
	if (
		node.operator !== "===" &&
		node.operator !== "!==" &&
		node.operator !== "==" &&
		node.operator !== "!="
	) {
		return;
	}
	const nanLeft = isNaNIdent(node.left);
	const nanRight = isNaNIdent(node.right);
	if (nanLeft === nanRight) {
		return;
	}
	const other = nanLeft ? node.right : node.left;
	const expr = ctx.source.slice(other.start, other.end);
	const positive = node.operator === "===" || node.operator === "==";
	const text = positive ? `Number.isNaN(${expr})` : `!Number.isNaN(${expr})`;
	ctx.issues.push({
		kind: "nanCompare",
		start: node.start,
		end: node.end,
		message: "Сравнение с NaN всегда ложно: используйте Number.isNaN",
		severity: "warning",
		fix: {
			title: "Заменить на Number.isNaN",
			start: node.start,
			end: node.end,
			text
		}
	});
}

function isNaNIdent(node: AnyNode | undefined): boolean {
	if (!node) {
		return false;
	}
	if (node.type === "Identifier" && node.name === "NaN") {
		return true;
	}
	if (node.type === "MemberExpression" && !node.computed) {
		const obj = node.object as AnyNode;
		const prop = node.property as AnyNode;
		return (
			obj?.type === "Identifier" &&
			obj.name === "Number" &&
			prop?.type === "Identifier" &&
			prop.name === "NaN"
		);
	}
	return false;
}

function checkCurly(ctx: AnalyzeCtx, body: AnyNode | undefined): void {
	if (!body || body.type === "BlockStatement") {
		return;
	}
	const indent = lineIndent(ctx.source, body.start);
	const nl = ctx.source.includes("\r\n") ? "\r\n" : "\n";
	const unit = indent.includes("\t") || !indent ? "\t" : "    ";
	const inner = ctx.source.slice(body.start, body.end).trim();
	ctx.issues.push({
		kind: "curly",
		start: body.start,
		end: body.end,
		message: "Ожидаются фигурные скобки вокруг тела",
		severity: "warning",
		fix: {
			title: "Добавить фигурные скобки",
			start: body.start,
			end: body.end,
			text: `{${nl}${indent}${unit}${inner}${nl}${indent}}`
		}
	});
}

function checkDuplicateKeys(node: AnyNode, ctx: AnalyzeCtx): void {
	const seen = new Set<string>();
	for (const prop of (node.properties as AnyNode[]) || []) {
		if (prop.type === "SpreadElement" || prop.computed) {
			continue;
		}
		const key = prop.key as AnyNode;
		let name: string | undefined;
		if (key?.type === "Identifier") {
			name = key.name;
		} else if (key?.type === "Literal") {
			name = String(key.value);
		}
		if (!name) {
			continue;
		}
		if (seen.has(name)) {
			ctx.issues.push({
				kind: "duplicateKey",
				start: key.start,
				end: key.end,
				message: `Повторяющийся ключ «${name}»`,
				severity: "error"
			});
		} else {
			seen.add(name);
		}
	}
}

function caseKey(clause: AnyNode, source: string): string {
	if (!clause.test) {
		return "default";
	}
	return source.slice(clause.test.start, clause.test.end);
}

function caseTerminates(consequent: AnyNode[]): boolean {
	if (!consequent.length) {
		return true;
	}
	const last = consequent[consequent.length - 1];
	if (isTerminator(last)) {
		return true;
	}
	if (last.type === "BlockStatement") {
		const body = last.body as AnyNode[];
		return body.length > 0 && isTerminator(body[body.length - 1]);
	}
	return false;
}

function pushUnusedBindings(ctx: AnalyzeCtx): void {
	for (const scope of ctx.allScopes) {
		for (const [name, binding] of scope.bindings) {
			if (binding.read || binding.skipUnused || name.startsWith("_")) {
				continue;
			}
			if (binding.kind === "param") {
				if (functionScope(scope).usesArguments) {
					continue;
				}
				ctx.issues.push({
					kind: "unusedParam",
					start: binding.identStart,
					end: binding.identEnd,
					message: `Параметр «${name}» не используется`,
					severity: "warning"
				});
				continue;
			}
			ctx.issues.push({
				kind: "unusedVar",
				start: binding.identStart,
				end: binding.identEnd,
				message: `Переменная «${name}» объявлена, но не используется`,
				severity: "warning"
			});
		}
	}
}

function checkOpeningBrace(
	source: string,
	issues: StyleIssue[],
	block: AnyNode | undefined
): void {
	if (!block) {
		return;
	}
	const braceStart =
		block.type === "BlockStatement" || block.type === "ClassBody"
			? (block.start as number)
			: block.type === "SwitchStatement"
				? findSwitchBrace(source, block)
				: -1;
	if (braceStart < 0 || source[braceStart] !== "{") {
		return;
	}
	if (!isAllmanBrace(source, braceStart)) {
		return;
	}
	const fix = braceJoinFix(source, braceStart);
	issues.push({
		kind: "krBrace",
		start: braceStart,
		end: braceStart + 1,
		message: "Ожидается стиль K&R: «{» на той же строке",
		severity: "warning",
		fix: fix
			? {
					title: "Перенести «{» на предыдущую строку",
					start: fix.start,
					end: fix.end,
					text: fix.text
				}
			: undefined
	});
}

function findSwitchBrace(source: string, node: AnyNode): number {
	const from = (node.discriminant as AnyNode).end as number;
	const i = skipWsAndComments(source, from, node.end);
	return source[i] === ")" ? skipWsAndComments(source, i + 1, node.end) : i;
}

function isAllmanBrace(source: string, braceStart: number): boolean {
	let i = braceStart - 1;
	while (i >= 0 && (source[i] === " " || source[i] === "\t" || source[i] === "\r")) {
		i--;
	}
	return i >= 0 && source[i] === "\n";
}

function braceJoinFix(
	source: string,
	braceStart: number
): { start: number; end: number; text: string } | undefined {
	let i = braceStart - 1;
	while (i >= 0 && /\s/.test(source[i])) {
		i--;
	}
	if (i < 0) {
		return undefined;
	}
	const head = source.slice(Math.max(0, i - 7), i + 1);
	if (
		source[i] !== ")" &&
		!/(?:else|try|do|finally|catch|=>)$/.test(head)
	) {
		return undefined;
	}
	const between = source.slice(i + 1, braceStart);
	if (!between.includes("\n") || !/^\s*$/.test(between)) {
		return undefined;
	}
	return { start: i + 1, end: braceStart, text: " " };
}

function checkCuddle(
	source: string,
	issues: StyleIssue[],
	closeBraceEnd: number,
	searchFrom: number,
	keyword: string
): void {
	if (closeBraceEnd < 0) {
		return;
	}
	const kwStart = findKeyword(source, closeBraceEnd, searchFrom + keyword.length, keyword);
	if (kwStart < 0) {
		return;
	}
	const between = source.slice(closeBraceEnd, kwStart);
	if (!between.includes("\n")) {
		return;
	}
	const fix = /^\s*$/.test(between)
		? {
				title: `Перенести «${keyword}» на строку с «}»`,
				start: closeBraceEnd,
				end: kwStart,
				text: " "
			}
		: undefined;
	issues.push({
		kind: "krCuddle",
		start: kwStart,
		end: kwStart + keyword.length,
		message: `Ожидается стиль K&R: «${keyword}» на той же строке, что и «}»`,
		severity: "warning",
		fix
	});
}

function blockEnd(node: AnyNode | undefined): number {
	if (!node || node.type !== "BlockStatement") {
		return -1;
	}
	return node.end as number;
}

function findKeyword(
	source: string,
	from: number,
	to: number,
	keyword: string
): number {
	let i = skipWsAndComments(source, from, to);
	if (source.slice(i, i + keyword.length) === keyword) {
		const before = i === 0 ? "" : source[i - 1];
		const after = source[i + keyword.length] || "";
		if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) {
			return i;
		}
	}
	return -1;
}

function skipWsAndComments(source: string, i: number, end: number): number {
	while (i < end) {
		const ch = source[i];
		if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
			i++;
			continue;
		}
		if (ch === "/" && source[i + 1] === "/") {
			const nl = source.indexOf("\n", i);
			i = nl < 0 ? end : nl + 1;
			continue;
		}
		if (ch === "/" && source[i + 1] === "*") {
			const close = source.indexOf("*/", i + 2);
			i = close < 0 ? end : close + 2;
			continue;
		}
		break;
	}
	return i;
}

interface EqualClause {
	disc: string;
	labels: string[];
	consequent: AnyNode;
}

function buildSwitchFromIfChain(source: string, node: AnyNode): string | undefined {
	const clauses: EqualClause[] = [];
	let current: AnyNode | undefined = node;
	let defaultNode: AnyNode | undefined;
	let disc: string | undefined;
	while (current && current.type === "IfStatement") {
		const parsed = parseEqualityTest(current.test, source);
		if (!parsed) {
			return undefined;
		}
		if (!disc) {
			disc = parsed.disc;
		} else if (parsed.disc !== disc) {
			return undefined;
		}
		clauses.push({
			disc: parsed.disc,
			labels: parsed.labels,
			consequent: current.consequent
		});
		const alt = current.alternate as AnyNode | undefined;
		if (!alt) {
			break;
		}
		if (alt.type === "IfStatement") {
			current = alt;
			continue;
		}
		defaultNode = alt;
		break;
	}
	if (!disc || clauses.length < 2) {
		return undefined;
	}
	return renderSwitch(source, node, disc, clauses, defaultNode);
}

function parseEqualityTest(
	test: AnyNode,
	source: string
): { disc: string; labels: string[] } | undefined {
	const parts: { disc: string; label: string }[] = [];
	if (!walkOrEquals(test, source, parts) || !parts.length) {
		return undefined;
	}
	const disc = parts[0].disc;
	if (parts.some((part) => part.disc !== disc)) {
		return undefined;
	}
	return { disc, labels: parts.map((part) => part.label) };
}

function walkOrEquals(
	node: AnyNode,
	source: string,
	parts: { disc: string; label: string }[]
): boolean {
	if (node.type === "LogicalExpression" && node.operator === "||") {
		return (
			walkOrEquals(node.left, source, parts) &&
			walkOrEquals(node.right, source, parts)
		);
	}
	if (
		node.type === "BinaryExpression" &&
		(node.operator === "===" || node.operator === "==")
	) {
		const pair = splitEquality(node.left, node.right, source);
		if (!pair) {
			return false;
		}
		parts.push(pair);
		return true;
	}
	return false;
}

function splitEquality(
	left: AnyNode,
	right: AnyNode,
	source: string
): { disc: string; label: string } | undefined {
	if (isDiscriminant(left) && isCaseLabel(right)) {
		return {
			disc: source.slice(left.start, left.end),
			label: source.slice(right.start, right.end)
		};
	}
	if (isDiscriminant(right) && right.type !== "Literal" && isCaseLabel(left)) {
		if (left.type === "Identifier" && right.type === "Identifier") {
			return undefined;
		}
		return {
			disc: source.slice(right.start, right.end),
			label: source.slice(left.start, left.end)
		};
	}
	return undefined;
}

function isDiscriminant(node: AnyNode): boolean {
	if (node.type === "Identifier") {
		return true;
	}
	if (node.type === "MemberExpression" && !node.computed) {
		return true;
	}
	return false;
}

function isCaseLabel(node: AnyNode): boolean {
	if (node.type === "Literal") {
		return true;
	}
	if (node.type === "Identifier") {
		return true;
	}
	if (node.type === "ThisExpression") {
		return true;
	}
	if (
		node.type === "UnaryExpression" &&
		(node.operator === "+" || node.operator === "-") &&
		node.argument?.type === "Literal"
	) {
		return true;
	}
	if (node.type === "MemberExpression" && !node.computed) {
		return (
			(node.property as AnyNode).type === "Identifier" && isCaseLabel(node.object)
		);
	}
	return false;
}

function renderSwitch(
	source: string,
	ifNode: AnyNode,
	disc: string,
	clauses: EqualClause[],
	defaultNode: AnyNode | undefined
): string {
	const nl = source.includes("\r\n") ? "\r\n" : "\n";
	const indent = lineIndent(source, ifNode.start);
	const unit = guessUnit(source, ifNode, indent);
	const inner = indent + unit;
	const bodyIndent = inner + unit;
	const lines: string[] = [`switch (${disc}) {`];
	for (const clause of clauses) {
		for (const label of clause.labels) {
			lines.push(`${inner}case ${label}:`);
		}
		pushConsequent(source, clause.consequent, bodyIndent, lines);
	}
	if (defaultNode) {
		lines.push(`${inner}default:`);
		pushConsequent(source, defaultNode, bodyIndent, lines);
	}
	lines.push(`${indent}}`);
	return lines.join(nl);
}

function pushConsequent(
	source: string,
	consequent: AnyNode,
	bodyIndent: string,
	lines: string[]
): void {
	const stmts =
		consequent.type === "BlockStatement"
			? (consequent.body as AnyNode[])
			: [consequent];
	let terminates = false;
	for (const stmt of stmts) {
		const text = source.slice(stmt.start, stmt.end).trim();
		if (!text) {
			continue;
		}
		for (const line of text.split(/\r?\n/)) {
			lines.push(bodyIndent + line.trim());
		}
		terminates = isTerminator(stmt);
	}
	if (!terminates) {
		lines.push(`${bodyIndent}break;`);
	}
}

function isTerminator(stmt: AnyNode): boolean {
	return (
		stmt.type === "ReturnStatement" ||
		stmt.type === "ThrowStatement" ||
		stmt.type === "BreakStatement" ||
		stmt.type === "ContinueStatement"
	);
}

function isFunctionNode(node: AnyNode | undefined | null): boolean {
	return (
		!!node &&
		(node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression")
	);
}

function checkMethodPropertyName(prop: AnyNode, ctx: AnalyzeCtx): void {
	if (prop.type !== "Property" && prop.type !== "MethodDefinition") {
		return;
	}
	if (prop.kind === "constructor") {
		return;
	}
	const isMethod =
		prop.kind === "method" ||
		prop.kind === "get" ||
		prop.kind === "set" ||
		isFunctionNode(prop.value);
	if (!isMethod) {
		return;
	}
	checkCamelName(ctx, prop.key as AnyNode, "camelMethod", "Метод");
}

function checkCamelName(
	ctx: AnalyzeCtx,
	node: AnyNode | undefined,
	kind: "camelLocal" | "camelParam" | "camelMethod",
	label: string,
	allowScreamingSnakeConst = false
): void {
	if (!node) {
		return;
	}
	const name =
		node.type === "Identifier"
			? (node.name as string)
			: node.type === "Literal" && typeof node.value === "string"
				? node.value
				: "";
	if (!name || name === "constructor" || name === "_") {
		return;
	}
	if (isJsCamelCase(name)) {
		checkIdSuffix(ctx, node, name, label);
		return;
	}
	if (allowScreamingSnakeConst && isScreamingSnakeCase(name)) {
		return;
	}
	const next = toJsCamel(name);
	ctx.issues.push({
		kind,
		start: node.start as number,
		end: node.end as number,
		message: `${label} «${name}»: ожидается camelCase`,
		severity: "warning",
		fix:
			next !== name
				? {
						title: `Переименовать в ${next}`,
						start: node.start as number,
						end: node.end as number,
						text: node.type === "Literal" ? JSON.stringify(next) : next
					}
				: undefined
	});
}

function isJsCamelCase(name: string): boolean {
	return /^_?[a-z][a-zA-Z0-9]*$/.test(name);
}

function isScreamingSnakeCase(name: string): boolean {
	return /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(name);
}

const ID_SUFFIX_RE = /(^|[a-z0-9])ID($|[A-Z])/;

function findIdSuffixIndex(name: string): number {
	const m = ID_SUFFIX_RE.exec(name);
	return m ? m.index + m[1].length : -1;
}

function checkIdSuffix(
	ctx: AnalyzeCtx,
	node: AnyNode,
	name: string,
	label: string
): void {
	const idx = findIdSuffixIndex(name);
	if (idx < 0) {
		return;
	}
	const next = name.slice(0, idx) + "Id" + name.slice(idx + 2);
	ctx.issues.push({
		kind: "idSuffix",
		start: node.start as number,
		end: node.end as number,
		message: `${label} «${name}»: используйте суффикс Id, не ID`,
		severity: "warning",
		fix: {
			title: `Переименовать в ${next}`,
			start: node.start as number,
			end: node.end as number,
			text: node.type === "Literal" ? JSON.stringify(next) : next
		}
	});
}

function toJsCamel(name: string): string {
	const priv = name.startsWith("_");
	const stripped = name.replace(/^_+/, "");
	if (!stripped) {
		return name;
	}
	const camel = stripped.charAt(0).toLowerCase() + stripped.slice(1);
	return priv ? `_${camel}` : camel;
}

function lineIndent(source: string, offset: number): string {
	const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
	let i = lineStart;
	while (i < source.length && (source[i] === " " || source[i] === "\t")) {
		i++;
	}
	return source.slice(lineStart, i);
}

function collectTrailingCommentIssues(source: string, comments: acorn.Comment[]): StyleIssue[] {
	const issues: StyleIssue[] = [];
	for (const comment of comments) {
		if (comment.type !== "Line") {
			continue;
		}
		const lineStart = source.lastIndexOf("\n", comment.start - 1) + 1;
		const before = source.slice(lineStart, comment.start);
		if (!before.trim()) {
			continue;
		}
		const indent = lineIndent(source, lineStart);
		const codeOnly = before.replace(/\s+$/, "");
		const commentText = source.slice(comment.start, comment.end);
		const nl = source.includes("\r\n") ? "\r\n" : "\n";
		issues.push({
			kind: "trailingComment",
			start: comment.start,
			end: comment.end,
			message: "Комментарий в конце строки кода: перенесите на отдельную строку",
			severity: "warning",
			fix: {
				title: "Перенести комментарий на отдельную строку выше",
				start: lineStart,
				end: comment.end,
				text: `${indent}${commentText}${nl}${codeOnly}`
			}
		});
	}
	return issues;
}

/** `@tag` lines in a `/** ... *​/` JSDoc comment — checked against
 * `KNOWN_JSDOC_TAGS`, flagged only when unambiguously a typo of a real one
 * (see `docTagCheck.ts`). Only matches at the start of a comment line (after
 * the conventional leading `*`), which also keeps this from misfiring on an
 * inline `{@link ...}` tag or an `@`-mention mid-sentence (an email address
 * in a comment, say) - both sit mid-line, never at the line start. */
function collectJsDocTagIssues(comments: acorn.Comment[]): StyleIssue[] {
	const issues: StyleIssue[] = [];
	const tagRe = /(^|\n)([ \t]*\*?[ \t]*)@([A-Za-z]+)\b/g;
	for (const comment of comments) {
		if (comment.type !== "Block" || !comment.value.startsWith("*")) {
			continue;
		}
		const valueStart = comment.start + 2;
		tagRe.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = tagRe.exec(comment.value))) {
			const tag = m[3];
			const suggestion = nearestKnownTag(tag, KNOWN_JSDOC_TAGS);
			if (!suggestion) {
				continue;
			}
			const tagStart = valueStart + m.index + m[1].length + m[2].length;
			const tagEnd = tagStart + 1 + tag.length;
			issues.push({
				kind: "jsDocTagTypo",
				start: tagStart,
				end: tagEnd,
				message: `Неизвестный JSDoc-тег «@${tag}» — похоже на опечатку, ожидается «@${suggestion}»`,
				severity: "warning",
				fix: {
					title: `Заменить на @${suggestion}`,
					start: tagStart,
					end: tagEnd,
					text: `@${suggestion}`
				}
			});
		}
	}
	return issues;
}

function guessUnit(source: string, ifNode: AnyNode, outer: string): string {
	const body = ifNode.consequent as AnyNode;
	const first =
		body?.type === "BlockStatement"
			? (body.body as AnyNode[])[0]
			: body;
	if (first) {
		const inner = lineIndent(source, first.start);
		if (inner.startsWith(outer) && inner.length > outer.length) {
			return inner.slice(outer.length);
		}
	}
	return outer.includes("\t") || !outer ? "\t" : "    ";
}
