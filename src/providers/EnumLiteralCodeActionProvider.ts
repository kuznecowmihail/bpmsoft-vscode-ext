import * as vscode from "vscode";
import { SymbolIndex } from "../index/SymbolIndex";
import { parseJs } from "../parse/jsAst";
import { collectEnumHintSites } from "../parse/enumHintSites";
import { resolveGenericEnumField, resolveRuleEnumField } from "../parse/enumHints";

/**
 * QuickFix that replaces a coded numeric literal (`dataValueType`/`itemType`/
 * `contentType`/`comparisonType`, or a `rules`/`businessRules` rule's own
 * `ruleType`/`property`) with its resolved symbolic `BPMSoft.*`/
 * `BusinessRuleModule.enums.*` constant — the automatic-replace half of the
 * enum-hint feature (`EnumInlayHintsProvider.ts`/`HoverProvider.ts` show the
 * resolved name; this applies it). Shares `enumHintSites.ts`'s site list so
 * all three agree on exactly where a literal is resolvable.
 */
export class EnumLiteralCodeActionProvider implements vscode.CodeActionProvider {
	constructor(private readonly index: SymbolIndex) {}

	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection
	): vscode.CodeAction[] {
		const ast = parseJs(document.getText());
		if (!ast) {
			return [];
		}
		const offset = document.offsetAt(range.start);
		const site = collectEnumHintSites(ast).find(
			(s) => s.kind === "literal" && offset >= s.start && offset <= s.end
		);
		if (!site || site.kind !== "literal") {
			return [];
		}
		const resolved =
			site.scope === "generic"
				? resolveGenericEnumField(this.index, site.fieldName, site.rawValue)
				: resolveRuleEnumField(site.fieldName, site.rawValue, site.ruleTypeRaw);
		if (!resolved) {
			return [];
		}
		const action = new vscode.CodeAction(
			`Заменить ${site.rawValue} на ${resolved.symbol}`,
			vscode.CodeActionKind.QuickFix
		);
		action.isPreferred = true;
		action.edit = new vscode.WorkspaceEdit();
		action.edit.replace(
			document.uri,
			new vscode.Range(document.positionAt(site.start), document.positionAt(site.end)),
			resolved.symbol
		);
		return [action];
	}
}
