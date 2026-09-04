import * as vscode from "vscode";
import { formatSqlSource } from "../parse/sqlFormatter";
import { formattingEnabled, isSqlScriptFormatTarget } from "./formattingTargets";

export class SqlFormattingProvider implements vscode.DocumentFormattingEditProvider {
	provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
		if (!formattingEnabled() || !isSqlScriptFormatTarget(document.uri.fsPath)) {
			return [];
		}
		const original = document.getText();
		const text = formatSqlSource(original);
		if (text === original) {
			return [];
		}
		const fullRange = new vscode.Range(
			document.positionAt(0),
			document.positionAt(original.length)
		);
		return [vscode.TextEdit.replace(fullRange, text)];
	}
}
