import * as vscode from "vscode";
import { NAMING_DIAG_SOURCE } from "./NamingDiagnostics";
import { extractNamingSubject } from "../parse/namingCommon";

/** Quick fix on any naming-guidelines.md squiggly (`NamingDiagnostics`):
 * "Пометить как ложное срабатывание" — same underlying command/setting
 * (`bpmsoft.naming.ignoredNames`) as the equivalent context-menu action on a
 * finding in the "BPMSoft: Naming Issues" tree view. */
export class NamingCodeActionProvider implements vscode.CodeActionProvider {
	provideCodeActions(
		_document: vscode.TextDocument,
		_range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext
	): vscode.CodeAction[] {
		const actions: vscode.CodeAction[] = [];
		for (const diag of context.diagnostics) {
			if (diag.source !== NAMING_DIAG_SOURCE) {
				continue;
			}
			const name = extractNamingSubject(diag.message);
			if (!name) {
				continue;
			}
			const action = new vscode.CodeAction(
				`Пометить «${name}» как ложное срабатывание`,
				vscode.CodeActionKind.QuickFix
			);
			action.diagnostics = [diag];
			action.command = {
				command: "bpmsoft.naming.markFalsePositive",
				title: "Пометить как ложное срабатывание",
				arguments: [name]
			};
			actions.push(action);
		}
		return actions;
	}
}
