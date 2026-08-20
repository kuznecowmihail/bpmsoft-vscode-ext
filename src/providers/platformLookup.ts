import * as vscode from "vscode";
import type { SymbolIndex } from "../index/SymbolIndex";
import { IndexedModule } from "../index/types";

export function isPlatformPrefix(prefix: string): boolean {
	return (
		prefix === "BPMSoft" ||
		prefix.startsWith("BPMSoft.") ||
		prefix === "Ext" ||
		prefix.startsWith("Ext.")
	);
}

export function modulesFromExpr(
	index: SymbolIndex,
	filePath: string,
	expr: string
): IndexedModule[] {
	const root = expr.split(".")[0];
	const resolved = index.resolveLocalAlias(filePath, root) || root;
	const mods = index.getAllByName(resolved).concat(index.getAllByName(expr));
	return Array.from(new Map(mods.map((m) => [m.filePath, m])).values());
}

export function markdownHover(lines: string[]): vscode.Hover {
	return new vscode.Hover(new vscode.MarkdownString(lines.join("\n\n")));
}
