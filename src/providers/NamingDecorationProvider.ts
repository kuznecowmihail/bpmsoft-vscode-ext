import * as vscode from "vscode";
import * as path from "path";
import { NamingIssuesIndex } from "../index/NamingIssuesIndex";

/**
 * Tints naming-issue nodes in the Packages tree via VS Code's own decoration
 * layer instead of a manually-set `description` string — a `description`
 * renders in the same (default) color as the label, so a naming warning
 * didn't visually read as a warning. `FileDecorationProvider` gives label
 * color + a badge for free, and applies to every `resourceUri`-bearing node
 * (schema/sqlScript/package/folder), not just the ones we'd remember to
 * hand-color.
 */
export class NamingDecorationProvider implements vscode.FileDecorationProvider {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	readonly onDidChangeFileDecorations = this.changeEmitter.event;

	constructor(private readonly namingIndex: NamingIssuesIndex) {
		namingIndex.onDidChangeFindings(() => this.changeEmitter.fire(undefined));
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		// Schema/SqlScript tree nodes carry the *directory* as resourceUri,
		// but findings are keyed on the descriptor.json inside it.
		const direct = [
			...this.namingIndex.getForPath(uri.fsPath),
			...this.namingIndex.getForPath(path.join(uri.fsPath, "descriptor.json"))
		];
		if (direct.length) {
			return {
				badge: "⚠",
				color: new vscode.ThemeColor("problemsWarningIcon.foreground"),
				tooltip: direct.map((f) => f.message).join("\n"),
				propagate: false
			};
		}
		if (this.namingIndex.hasIssuesUnder(uri.fsPath)) {
			return {
				badge: "⚠",
				color: new vscode.ThemeColor("problemsWarningIcon.foreground"),
				tooltip: "В этом пакете есть проблемы с неймингом",
				propagate: false
			};
		}
		return undefined;
	}
}
