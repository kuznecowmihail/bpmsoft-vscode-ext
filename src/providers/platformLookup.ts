import * as vscode from "vscode";
import type { SymbolIndex } from "../index/SymbolIndex";
import { IndexedMember, IndexedModule } from "../parse/types";

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

/**
 * Shared ESQ/entity hover formatting - a header naming the code element, an
 * italic subtitle line carrying its real (localized) title when one is known
 * (see `IndexedModule.caption`/`IndexedMember.caption`) so a hover doesn't
 * show only the code name, then a divider before the file/detail/
 * documentation body. Used by both the JS `HoverProvider` and
 * `CsharpHoverProvider` so ESQ entity/column hovers look the same regardless
 * of which language triggered them.
 *
 * Uses `#` (h1), not `###` - VS Code's hover widget renders `###`/h3 close
 * enough to plain bold text that it reads as no header at all in a compact
 * popup (confirmed against a real screenshot); `#` is visibly larger under
 * the hover widget's own stylesheet.
 */
export function entityHover(
	schemaName: string,
	info: { filePath?: string; caption?: string; columnCount?: number },
	extra: string[] = []
): vscode.Hover {
	const subtitle = info.caption ? `*${info.caption}* — entity` : "*entity*";
	const lines = [`# ${schemaName}`, subtitle, ...extra, "---"];
	if (info.filePath) {
		lines.push(`\`${info.filePath}\``);
	}
	if (info.columnCount !== undefined) {
		lines.push(`${info.columnCount} column(s)`);
	}
	return markdownHover(lines);
}

export function columnHover(
	columnName: string,
	schemaName: string,
	member: Pick<IndexedMember, "detail" | "documentation" | "caption">,
	extra: string[] = []
): vscode.Hover {
	const subtitle = member.caption
		? `*${member.caption}* — entity column · ${schemaName}`
		: `*entity column* · ${schemaName}`;
	// The subtitle already names the owning schema - a stock (conf/content)
	// column with nothing else to say gets a generic `entity ${schemaName}`
	// filler as its `detail` (SymbolIndex.getEntityModule's fallback), which
	// would just repeat that same name a second time. Only actually useful
	// `detail` text (e.g. "entity lookup") survives into the body.
	const detail = member.detail !== `entity ${schemaName}` ? member.detail : undefined;
	const lines = [
		`# ${columnName}`,
		subtitle,
		...extra,
		"---",
		...(detail ? [detail] : []),
		...(member.documentation ? [member.documentation] : [])
	];
	return markdownHover(lines);
}
