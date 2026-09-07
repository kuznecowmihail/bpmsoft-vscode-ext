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
 * pass.
 *
 * `withEditLink`: enables the two `command:` URIs `editLocalizedStringLink`/
 * `editLocalizedImageLink` build (VS Code renders a Markdown `command:` link
 * as inert plain text unless the hosting `MarkdownString.isTrusted` opts in)
 * — scoped to exactly those two command ids rather than a blanket `true`, so
 * nothing else this codebase might one day put in a hover accidentally
 * becomes clickable-command-executing without its own explicit opt-in. */
export function markdownHover(lines: string[], supportHtml = false, withEditLink = false): vscode.Hover {
	const md = new vscode.MarkdownString(lines.join("\n\n"));
	md.supportHtml = supportHtml;
	if (withEditLink) {
		md.isTrusted = EDIT_LINK_ENABLED_COMMANDS;
	}
	return new vscode.Hover(md);
}

const EDIT_LINK_ENABLED_COMMANDS: NonNullable<vscode.MarkdownString["isTrusted"]> = {
	enabledCommands: ["bpmsoft.editLocalizedStrings", "bpmsoft.editLocalizedImages"]
};

/** Builds the `[✎ Редактировать](command:...)` line `stringHover`/`imageHover`
 * (`HoverProvider.ts`, `CsharpHoverProvider.ts`) append under a resolved
 * key's translations — the args shape matches what `LocalizationWizardPanel`
 * takes from either a `PackagesTreeProvider` tree node or this link:
 * `{path: schemaDir, name: schemaName, key}` (`extension.ts`'s
 * `resolveWizardSchema` reads `name`/`path`; the wizard command handlers
 * read `key` as the row to scroll to and filter down to on open). */
function editLocalizedKeyLink(command: "bpmsoft.editLocalizedStrings" | "bpmsoft.editLocalizedImages", schemaDir: string, schemaName: string, key: string): string {
	const args = encodeURIComponent(JSON.stringify({ path: schemaDir, name: schemaName, key }));
	return `[✎ Редактировать](command:${command}?${args})`;
}

export function editLocalizedStringLink(schemaDir: string, schemaName: string, key: string): string {
	return editLocalizedKeyLink("bpmsoft.editLocalizedStrings", schemaDir, schemaName, key);
}

export function editLocalizedImageLink(schemaDir: string, schemaName: string, key: string): string {
	return editLocalizedKeyLink("bpmsoft.editLocalizedImages", schemaDir, schemaName, key);
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
