import { NamingIssue } from "./namingCommon";

/**
 * `Remove` isn't in naming-guidelines.md's own table (Create/Alter/Delete/
 * Update/Insert/Drop) but shows up as an established synonym for Delete/Drop
 * in real packages (e.g. `GoTicketFile_RemoveGoTicketIdFKConstraint`) —
 * treated as accepted rather than flagging already-conventional code.
 */
const KNOWN_OPERATIONS = ["Create", "Alter", "Delete", "Update", "Insert", "Drop", "Remove"];

/**
 * Checks a SQL Script schema's name against naming-guidelines.md §6:
 * `{Object}_{Operation}_{Description}`, with an optional `_Temp` suffix for
 * one-off scripts. Only the *shape* of the name is checked — never the SQL
 * body (that's semantic, not naming; see naming subsystem plan). No
 * package-prefix check here: unlike schemas/classes, `{Object}` is often a
 * stock/un-prefixed table or setting name (`SysSettings_Delete_CountryCode`),
 * so requiring a prefix would misfire on legitimate scripts.
 */
/**
 * The guide's own examples mix `{Object}_{Operation}_{Description}` (two
 * underscores, e.g. `Account_Alter_AddStatus`) with `{Object}_{Operation}
 * {Description}` run together (one underscore, e.g. `VwAccount_CreateView`,
 * and real code like `GoTicketFile_RemoveGoTicketIdFKConstraint`) — so this
 * only requires the segment right after the first `_` to *start* with a
 * known operation, not a second underscore.
 */
/** Each `_`-separated segment on its own, e.g. "SysWorkplace"/"CreateFunc"/
 * "NextNumber" — PascalCase (starts uppercase, letters/digits only), not
 * the *whole* name (which is never actually PascalCase itself, being
 * underscore-separated). Checked against 279 real scripts across two
 * installs before wiring this in: only 2 violate it (`Go_create_fn_...`,
 * `Go_create_tsp_...`, both a stray lowercase "create" segment) — a real,
 * low-noise check, unlike the {Object}/{Operation} order below. */
function findBadPascalCaseSegment(withoutTemp: string): string | undefined {
	return withoutTemp.split("_").find((segment) => segment && !/^[A-Z][A-Za-z0-9]*$/.test(segment));
}

export function checkSqlScriptNaming(code: string): NamingIssue[] {
	const issues: NamingIssue[] = [];
	const withoutTemp = code.endsWith("_Temp") ? code.slice(0, -"_Temp".length) : code;
	const firstUnderscore = withoutTemp.indexOf("_");
	const rest = firstUnderscore > 0 ? withoutTemp.slice(firstUnderscore + 1) : "";
	if (firstUnderscore <= 0 || !KNOWN_OPERATIONS.some((op) => rest.startsWith(op))) {
		issues.push({
			message: `SQL-скрипт «${code}»: ожидается шаблон {Object}_{Operation}{Description}, Operation — одно из ${KNOWN_OPERATIONS.join("/")}`
		});
	}
	const badSegment = findBadPascalCaseSegment(withoutTemp);
	if (badSegment !== undefined) {
		issues.push({
			message: `SQL-скрипт «${code}»: сегмент «${badSegment}» должен быть в PascalCase`
		});
	}
	return issues;
}
