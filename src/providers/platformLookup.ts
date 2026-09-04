import * as vscode from "vscode";
import type { SymbolIndex } from "../index/SymbolIndex";
import { IndexedModule } from "../parse/types";

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

/** `supportHtml` is needed only by the image-preview hover — it uses a raw
 * `<img width=...>` tag to size the preview down, which plain Markdown
 * image syntax (`![]()`) has no way to do. Left off by default since every
 * other hover here is plain text and doesn't need VS Code's HTML-sanitizing
 * pass. */
export function markdownHover(lines: string[], supportHtml = false): vscode.Hover {
	const md = new vscode.MarkdownString(lines.join("\n\n"));
	md.supportHtml = supportHtml;
	return new vscode.Hover(md);
}
