import { tokenize, Token, decodeCsharpStringLiteral } from "./csharpStyleAnalyzer";

/** C#-side `EntitySchemaQuery` detection — the real, confirmed-by-usage
 * shape is `new EntitySchemaQuery(<EntitySchemaManager>, "<SchemaName>")`
 * assigned to a local (`var esq = new EntitySchemaQuery(UserConnection.
 * EntitySchemaManager, "Contact")`), then `<esqVar>.AddColumn("path")` /
 * `.CreateFilterWithParameters(...)` / etc. — mirrors the JS side's
 * `esqBinds.ts`, but token-based (no C# AST available here) rather than
 * scope-tree-based.
 *
 * Deliberate scope, confirmed against real code: only resolves when the
 * declaration and its column-path calls sit in the *same* method/block, and
 * only when the constructor's root-schema argument is a plain string
 * literal. Two real patterns fall outside that and get no hover rather
 * than a guess: (1) building the query in one method and passing the
 * already-constructed `EntitySchemaQuery` as a *typed parameter* to others
 * (`private void AddFilter(EntitySchemaQuery messageQuery, ...)` — the
 * schema is only known at the original construction site, in a different
 * method/scope entirely); (2) constructing via an already-resolved
 * `EntitySchema` variable (`new EntitySchemaQuery(esnMessageSchema)`, a
 * real constructor overload) rather than the `(manager, "Name")` shape —
 * the schema name would need tracing back through wherever that variable
 * was itself assigned. Coverage swept across two real installs' owned C#:
 * root-schema-name hovers resolve 100% of the time (the literal is always
 * self-contained); column-path hovers resolve 65.8%/6.5% respectively — the
 * lower number specifically traced to one real file built entirely around
 * pattern (1) above. */

/** Every C# method whose call carries a column path as a plain string
 * literal argument, confirmed against real usage (`AddColumn` and
 * `CreateFilterWithParameters` dominate; the rest are real but rare).
 * Deliberately not keyed to a fixed argument *index* — `CreateFilter`/
 * `CreateFilterWithParameters` have several overloads that put the column
 * path at a different position depending on which non-string arguments
 * (an enum member access, a bare bool) precede it. Instead, resolution
 * takes the *first plain string literal* among the call's own direct
 * arguments — enum members (`FilterComparisonType.Equal`) and bool
 * literals are never string literals, so this lands on the column path
 * across every real overload without hardcoding each one. */
const COLUMN_PATH_METHODS = new Set([
	"AddColumn",
	"CreateFilter",
	"CreateFilterWithParameters",
	"CreateIsNullFilter",
	"CreateIsNotNullFilter",
	"CreateExistsFilter",
	"CreateNotExistsFilter",
	"CreateInnerJoinFilter",
	"CreateLeftExclusiveFilter",
	"RemoveColumn"
]);

export interface CsharpEsqDeclaration {
	varName: string;
	schemaName: string;
	/** Character offsets of the block this declaration is visible within
	 * (the `{ }` it was declared inside) — not a full C# scope model, just
	 * "textually within the same block, after the declaration." */
	scopeStart: number;
	scopeEnd: number;
	nameLiteralStart: number;
	nameLiteralEnd: number;
}

export interface CsharpEsqColumnContext {
	varName: string;
	path: string;
	start: number;
	end: number;
}

function matchForwardParen(tokens: Token[], openIdx: number): number {
	let depth = 0;
	for (let j = openIdx; j < tokens.length; j++) {
		if (tokens[j].value === "(") {
			depth++;
		} else if (tokens[j].value === ")") {
			depth--;
			if (depth === 0) {
				return j;
			}
		}
	}
	return -1;
}

function matchForwardBrace(tokens: Token[], openIdx: number): number {
	let depth = 0;
	for (let j = openIdx; j < tokens.length; j++) {
		if (tokens[j].value === "{") {
			depth++;
		} else if (tokens[j].value === "}") {
			depth--;
			if (depth === 0) {
				return j;
			}
		}
	}
	return -1;
}

/** The `{ }` block token `idx` sits inside — found by scanning backward for
 * the nearest unmatched `{`, then matching it forward. Falls back to the
 * whole file when nothing encloses it (a top-level statement, or malformed
 * input) rather than failing outright. */
function enclosingBlock(tokens: Token[], idx: number): { start: number; end: number } {
	let depth = 0;
	let openIdx = -1;
	for (let j = idx - 1; j >= 0; j--) {
		if (tokens[j].value === "}") {
			depth++;
		} else if (tokens[j].value === "{") {
			if (depth === 0) {
				openIdx = j;
				break;
			}
			depth--;
		}
	}
	if (openIdx < 0) {
		return { start: 0, end: tokens.length ? tokens.length - 1 : 0 };
	}
	const closeIdx = matchForwardBrace(tokens, openIdx);
	return { start: openIdx, end: closeIdx < 0 ? tokens.length - 1 : closeIdx };
}

/** The first *direct* (not nested inside another call within the same
 * argument list — e.g. `AddColumn(esq.CreateAggregationColumn(..., "Id"))`
 * must not pick up that inner call's own "Id" argument) plain string
 * literal among `(openParen, closeParen)`'s own arguments. */
function firstDirectStringArg(tokens: Token[], openParen: number, closeParen: number): Token | undefined {
	let depth = 0;
	for (let j = openParen; j <= closeParen; j++) {
		const v = tokens[j].value;
		if (v === "(") {
			depth++;
			continue;
		}
		if (v === ")") {
			depth--;
			continue;
		}
		if (depth !== 1) {
			continue;
		}
		if (tokens[j].kind === "str" && !tokens[j].value.startsWith("'")) {
			return tokens[j];
		}
	}
	return undefined;
}

/** Every `var esq = new EntitySchemaQuery(<manager>, "<SchemaName>")` in the
 * file, with the block it's visible in. */
export function collectCsharpEsqDeclarations(source: string): CsharpEsqDeclaration[] {
	const { tokens } = tokenize(source);
	const out: CsharpEsqDeclaration[] = [];
	for (let i = 0; i < tokens.length; i++) {
		if (
			tokens[i].value !== "new" ||
			tokens[i + 1]?.value !== "EntitySchemaQuery" ||
			tokens[i + 2]?.value !== "("
		) {
			continue;
		}
		if (tokens[i - 1]?.value !== "=") {
			continue;
		}
		const varTok = tokens[i - 2];
		if (!varTok || varTok.kind !== "ident") {
			continue;
		}
		const openParen = i + 2;
		const closeParen = matchForwardParen(tokens, openParen);
		if (closeParen < 0) {
			continue;
		}
		const nameTok = firstDirectStringArg(tokens, openParen, closeParen);
		const schemaName = nameTok && decodeCsharpStringLiteral(nameTok.value);
		if (!nameTok || !schemaName) {
			continue;
		}
		const block = enclosingBlock(tokens, i - 2);
		out.push({
			varName: varTok.value,
			schemaName,
			scopeStart: tokens[block.start]?.start ?? 0,
			scopeEnd: tokens[block.end]?.end ?? source.length,
			nameLiteralStart: nameTok.start,
			nameLiteralEnd: nameTok.end
		});
	}
	return out;
}

/** Which declaration (if any) a given `varName` used at `offset` refers to
 * — the one whose block contains `offset` and whose own declaration sits
 * before it; if several same-named declarations qualify (shadowing across
 * sibling blocks, or reuse of the name later in the same method), the
 * textually nearest preceding one wins. */
export function findEsqDeclarationForOffset(
	declarations: CsharpEsqDeclaration[],
	varName: string,
	offset: number
): CsharpEsqDeclaration | undefined {
	let best: CsharpEsqDeclaration | undefined;
	for (const decl of declarations) {
		if (
			decl.varName !== varName ||
			decl.nameLiteralStart > offset ||
			offset < decl.scopeStart ||
			offset > decl.scopeEnd
		) {
			continue;
		}
		if (!best || decl.nameLiteralStart > best.nameLiteralStart) {
			best = decl;
		}
	}
	return best;
}

/** `<esqVar>.AddColumn("path")` (or any other `COLUMN_PATH_METHODS` call)
 * at `offset` — `undefined` unless `offset` actually falls on that call's
 * own qualifying string-literal argument (not merely somewhere in its
 * argument list). */
export function getCsharpEsqColumnContext(source: string, offset: number): CsharpEsqColumnContext | undefined {
	const { tokens } = tokenize(source);
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok.kind !== "ident" || !COLUMN_PATH_METHODS.has(tok.value)) {
			continue;
		}
		if (tokens[i - 1]?.value !== "." || tokens[i + 1]?.value !== "(") {
			continue;
		}
		const varTok = tokens[i - 2];
		if (!varTok || varTok.kind !== "ident") {
			continue;
		}
		const openParen = i + 1;
		const closeParen = matchForwardParen(tokens, openParen);
		if (closeParen < 0 || offset < tokens[openParen].start || offset > tokens[closeParen].end) {
			continue;
		}
		// offset is inside THIS call's own parens - resolve strictly against
		// it (success or not) rather than continuing to scan other calls.
		const pathTok = firstDirectStringArg(tokens, openParen, closeParen);
		if (!pathTok || offset < pathTok.start || offset > pathTok.end) {
			return undefined;
		}
		const path = decodeCsharpStringLiteral(pathTok.value);
		return path ? { varName: varTok.value, path, start: pathTok.start, end: pathTok.end } : undefined;
	}
	return undefined;
}
