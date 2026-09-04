import * as vscode from "vscode";
import { collectStyleIssues, SUPPRESSIBLE_RULE_IDS, StyleIssue } from "../parse/styleAnalyzer";
import { collectCsharpStyleIssues } from "../parse/csharpStyleAnalyzer";
import { DIAG_SOURCE } from "./MissingMemberDiagnostics";
import { isCsharpFile } from "./jsDocuments";

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
		const issues = isCsharpFile(document)
			? collectCsharpStyleIssues(document.getText())
			: collectStyleIssues(document.getText());
		const actions: vscode.CodeAction[] = [];
		for (const diag of diags) {
			const start = document.offsetAt(diag.range.start);
			const end = document.offsetAt(diag.range.end);
			const issue = issues.find((item) => item.start === start && item.end === end);
			if (!issue) {
				continue;
			}
			if (issue.fix) {
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
			const ruleId = SUPPRESSIBLE_RULE_IDS[issue.kind];
			if (ruleId) {
				actions.push(buildSuppressAction(document, diag, issue, ruleId));
			}
		}
		return actions;
	}
}

function buildSuppressAction(
	document: vscode.TextDocument,
	diag: vscode.Diagnostic,
	issue: StyleIssue,
	ruleId: string
): vscode.CodeAction {
	const action = new vscode.CodeAction(
		"Не проблема (больше не показывать здесь)",
		vscode.CodeActionKind.QuickFix
	);
	action.diagnostics = [diag];
	const startPos = document.positionAt(issue.start);
	const line = document.lineAt(startPos.line);
	const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
	const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
	action.edit = new vscode.WorkspaceEdit();
	action.edit.insert(
		document.uri,
		new vscode.Position(startPos.line, 0),
		`${indent}// bpmsoft-ignore: ${ruleId}${eol}`
	);
	return action;
}
