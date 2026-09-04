export interface NamingIssue {
	message: string;
}

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
export function checkSqlScriptNaming(scriptName: string): NamingIssue[] {
	const withoutTemp = scriptName.endsWith("_Temp")
		? scriptName.slice(0, -"_Temp".length)
		: scriptName;
	const firstUnderscore = withoutTemp.indexOf("_");
	const rest = firstUnderscore > 0 ? withoutTemp.slice(firstUnderscore + 1) : "";
	if (firstUnderscore <= 0 || !KNOWN_OPERATIONS.some((op) => rest.startsWith(op))) {
		return [
			{
				message: `SQL-скрипт «${scriptName}»: ожидается шаблон {Object}_{Operation}{Description}, Operation — одно из ${KNOWN_OPERATIONS.join("/")}`
			}
		];
	}
	return [];
}
