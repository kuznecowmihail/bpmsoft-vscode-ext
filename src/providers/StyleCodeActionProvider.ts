import * as vscode from "vscode";
import { collectStyleIssues } from "../parse/styleAnalyzer";
import { DIAG_SOURCE } from "./MissingMemberDiagnostics";

export class StyleCodeActionProvider implements vscode.CodeActionProvider {
	provideCodeActions(
		document: vscode.TextDocument,
		_range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext
	): vscode.CodeAction[] {
		const diags = context.diagnostics.filter(
			(d) =>
				d.source === DIAG_SOURCE &&
				String(d.code ?? "").startsWith("bpmsoft.style.")
		);
		if (!diags.length) {
			return [];
		}
		const issues = collectStyleIssues(document.getText());
		const actions: vscode.CodeAction[] = [];
		for (const diag of diags) {
			const start = document.offsetAt(diag.range.start);
			const end = document.offsetAt(diag.range.end);
			const issue = issues.find(
				(item) => item.start === start && item.end === end && item.fix
			);
			if (!issue?.fix) {
				continue;
			}
			const action = new vscode.CodeAction(
				issue.fix.title,
				vscode.CodeActionKind.QuickFix
			);
			action.diagnostics = [diag];
			action.isPreferred = true;
			action.edit = new vscode.WorkspaceEdit();
			action.edit.replace(
				document.uri,
				new vscode.Range(
					document.positionAt(issue.fix.start),
					document.positionAt(issue.fix.end)
				),
				issue.fix.text
			);
			actions.push(action);
		}
		return actions;
	}
}
