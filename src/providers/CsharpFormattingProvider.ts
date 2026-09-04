import * as vscode from "vscode";
import { formatCsharpSource } from "../parse/csharpFormatter";
import { formattingEnabled, isCsharpFormatTarget } from "./formattingTargets";

export class CsharpFormattingProvider implements vscode.DocumentFormattingEditProvider {
	provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
		if (!formattingEnabled() || !isCsharpFormatTarget(document.uri.fsPath)) {
			return [];
		}
		const original = document.getText();
		const text = formatCsharpSource(original);
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
