import * as vscode from "vscode";
import { formatJsSource } from "../parse/jsFormatter";
import { formattingEnabled, isJsFormatTarget } from "./formattingTargets";

export class JsFormattingProvider implements vscode.DocumentFormattingEditProvider {
	async provideDocumentFormattingEdits(
		document: vscode.TextDocument
	): Promise<vscode.TextEdit[]> {
		if (!formattingEnabled() || !isJsFormatTarget(document.uri.fsPath)) {
			return [];
		}
		const original = document.getText();
		const text = await formatJsSource(original);
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
