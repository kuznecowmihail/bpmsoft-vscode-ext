import { tokenize, Token } from "./csharpStyleAnalyzer";
import { matchForwardParen, firstDirectLiteralArg, CsharpLiteralArg } from "./esqCsharp";

/**
 * C#-side "direct access" query builder detection —
 * `BPMSoft.Core.DB.Select`/`Insert`/`Update`/`Delete`, the fluent SQL
 * builder API (confirmed via `BPMSoft.Core.dll` reflection and real usage:
 * 252/27/49/30 occurrences of `new Select/Insert/Update/Delete(` across one
 * install's own owned packages). Unlike `EntitySchemaQuery`, these use
 * plain table/column *names* directly — no path DSL, no join-type prefix —
 * and are almost always used as one continuous fluent chain terminated by
 * `;` (`new Select(uc).From("Contact").Column("Name").GetEntityCollection()`),
 * rarely split across statements the way ESQ commonly is.
 *
 * Real schema-setting shape per type, confirmed via reflection + usage:
 * - `Select`/`Delete`: `.From("SchemaName")`
 * - `Insert`: `.Into("SchemaName")`
 * - `Update`: the *constructor's* second argument, `new Update(uc,
 *   "SchemaName")` — `Update` has no `.From`/`.Into` method at all.
 *
 * Real column-referencing shape: `.Column("Col")` (`Select`), `.Set("Col",
 * value)` (`Insert`/`Update`), `.Where("Col")` (confirmed in real code:
 * `.Where("Id").IsEqual(...)`). The two-argument `.Column(alias, "Col")`
 * form (for a column on a *joined* table, not the root schema) isn't
 * resolved — tracking join aliases is out of scope, same "don't guess"
 * stance as everywhere else.
 */

const QUERY_TYPES = new Set(["Select", "Insert", "Update", "Delete"]);
const SCHEMA_METHODS = new Set(["From", "Into"]);
const COLUMN_METHODS = new Set(["Column", "Set", "Where"]);

interface ChainStep {
	method: string;
	openParen: number;
	closeParen: number;
}

export interface DbQueryChain {
	queryType: string;
	schemaName?: string;
	schemaNameStart?: number;
	schemaNameEnd?: number;
	/** Character-offset span this chain covers (from `new` through its last
	 * recognized `.Method(...)` step) — used to test whether a given
	 * document offset's enclosing call belongs to this chain. */
	start: number;
	end: number;
	columnSteps: ChainStep[];
}

/** Walks `.Method(...)` steps immediately following `afterCloseParenIdx`
 * (a constructor's or a previous step's own closing paren) for as long as
 * the pattern holds — stops at the first token that isn't `.` followed by
 * a call (a cast, `;`, end of the chain, …). */
function walkChainSteps(tokens: Token[], afterCloseParenIdx: number): { endIdx: number; steps: ChainStep[] } {
	const steps: ChainStep[] = [];
	let i = afterCloseParenIdx + 1;
	while (
		tokens[i]?.value === "." &&
		(tokens[i + 1]?.kind === "ident" || tokens[i + 1]?.kind === "kw") &&
		tokens[i + 2]?.value === "("
	) {
		const method = tokens[i + 1].value;
		const openParen = i + 2;
		const closeParen = matchForwardParen(tokens, openParen);
		if (closeParen < 0) {
			break;
		}
		steps.push({ method, openParen, closeParen });
		i = closeParen + 1;
	}
	return { endIdx: i - 1, steps };
}

export function collectDbQueryChains(source: string): DbQueryChain[] {
	const { tokens } = tokenize(source);
	const chains: DbQueryChain[] = [];
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].value !== "new" || !QUERY_TYPES.has(tokens[i + 1]?.value) || tokens[i + 2]?.value !== "(") {
			continue;
		}
		const queryType = tokens[i + 1].value;
		const ctorOpen = i + 2;
		const ctorClose = matchForwardParen(tokens, ctorOpen);
		if (ctorClose < 0) {
			continue;
		}
		let schemaArg: CsharpLiteralArg | undefined;
		if (queryType === "Update") {
			// The only real schema-setting shape for Update: its own
			// constructor's second argument. (userConnection, the first arg,
			// is a plain identifier - never a string/nameof - so scanning the
			// whole constructor arg list for the first literal/nameof lands on
			// the schema name without needing to count argument positions.)
			schemaArg = firstDirectLiteralArg(tokens, ctorOpen, ctorClose);
		}
		const { endIdx, steps } = walkChainSteps(tokens, ctorClose);
		if (!schemaArg) {
			for (const step of steps) {
				if (!SCHEMA_METHODS.has(step.method)) {
					continue;
				}
				const arg = firstDirectLiteralArg(tokens, step.openParen, step.closeParen);
				if (arg) {
					schemaArg = arg;
					break;
				}
			}
		}
		chains.push({
			queryType,
			schemaName: schemaArg?.value,
			schemaNameStart: schemaArg?.start,
			schemaNameEnd: schemaArg?.end,
			start: tokens[i].start,
			end: tokens[endIdx]?.end ?? tokens[ctorClose].end,
			columnSteps: steps.filter((s) => COLUMN_METHODS.has(s.method))
		});
	}
	return chains;
}

export interface DbQueryColumnContext {
	schemaName: string;
	columnName: string;
	start: number;
	end: number;
}

/** `<chain>.Column("X")` / `.Set("X", ...)` / `.Where("X")` at `offset` —
 * `undefined` unless `offset` falls on that step's own qualifying argument
 * *and* the chain it belongs to has a resolvable root schema. */
export function getDbQueryColumnContext(
	source: string,
	offset: number,
	chains: DbQueryChain[]
): DbQueryColumnContext | undefined {
	const { tokens } = tokenize(source);
	for (const chain of chains) {
		if (!chain.schemaName || offset < chain.start || offset > chain.end) {
			continue;
		}
		for (const step of chain.columnSteps) {
			if (offset < tokens[step.openParen].start || offset > tokens[step.closeParen].end) {
				continue;
			}
			const arg = firstDirectLiteralArg(tokens, step.openParen, step.closeParen);
			if (!arg || offset < arg.start || offset > arg.end) {
				return undefined;
			}
			return { schemaName: chain.schemaName, columnName: arg.value, start: arg.start, end: arg.end };
		}
	}
	return undefined;
}
