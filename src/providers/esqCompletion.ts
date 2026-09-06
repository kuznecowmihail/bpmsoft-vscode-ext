import * as vscode from "vscode";
import { IndexedMember } from "../parse/types";
import { EsqNameSpan } from "../parse/esqQuery";
import { EsqBracketContext } from "../parse/esqColumnPath";

export type { EsqBracketContext } from "../parse/esqColumnPath";
export { getEsqBracketContext } from "../parse/esqColumnPath";

/**
 * ESQ column-path completion building blocks shared by the JS
 * `CompletionProvider` and the C# `CsharpCompletionProvider` - both need the
 * exact same "which of the 3 `[Schema:Col:Col]` stages am I typing" /
 * "build a completion item that inserts the rest of a syntactically valid
 * segment" logic (see `esqColumnPath.ts` for the path grammar itself),
 * just triggered off different surrounding syntax (a `.method("...")` call
 * in JS, an `esqVar.AddColumn("...")` string-literal argument in C#).
 */

export const TRIGGER_SUGGEST: vscode.Command = {
	title: "Suggest",
	command: "editor.action.triggerSuggest"
};

export function toEntityNameItems(
	names: string[],
	ctx: EsqNameSpan,
	document: vscode.TextDocument
): vscode.CompletionItem[] {
	const typed = ctx.name.toLowerCase();
	const range = new vscode.Range(
		document.positionAt(ctx.nameStart),
		document.positionAt(ctx.nameEnd)
	);
	return names
		.filter((name) => !typed || name.toLowerCase().startsWith(typed))
		.map((name, i) => {
			const item = new vscode.CompletionItem(
				name,
				vscode.CompletionItemKind.Class
			);
			item.detail = `BPMSoft · entity`;
			item.sortText = `!${String(i).padStart(5, "0")}_${name}`;
			item.filterText = name;
			item.preselect = i === 0;
			item.insertText = ctx.quote ? name : `"${name}"`;
			item.range = range;
			return item;
		});
}

export function toEsqColumnItems(
	members: IndexedMember[],
	ctx: EsqNameSpan,
	parentPath: string[],
	document: vscode.TextDocument
): vscode.CompletionItem[] {
	const range = new vscode.Range(
		document.positionAt(ctx.nameStart),
		document.positionAt(ctx.nameEnd)
	);
	return members.map((m, i) => {
		const completed = parentPath.length
			? [...parentPath, m.name].join(".")
			: m.name;
		const item = new vscode.CompletionItem(
			m.name,
			vscode.CompletionItemKind.Field
		);
		item.detail = m.detail || `entity column`;
		item.sortText = `!${String(i).padStart(5, "0")}_${m.name}`;
		// `range` spans the *whole* path typed so far (see `EsqNameSpan`),
		// not just this last segment - VS Code filters an item by comparing
		// its own `filterText` against the document text from `range.start`
		// to the cursor, which for a multi-segment path is the whole
		// "SysUser.Ac" typed so far, not just "Ac". `filterText` has to be
		// the full path this item would produce (`completed`), or every
		// suggestion gets silently filtered out the moment the user types
		// past the first character of the segment being completed.
		item.filterText = completed;
		item.preselect = i === 0;
		if (m.caption) {
			item.documentation = new vscode.MarkdownString(
				m.documentation ? `*${m.caption}*\n\n${m.documentation}` : `*${m.caption}*`
			);
		} else if (m.documentation) {
			item.documentation = new vscode.MarkdownString(m.documentation);
		}
		item.insertText = ctx.quote ? completed : `"${completed}"`;
		item.range = range;
		return item;
	});
}

/** Completion for the 3 stages of typing a `[Schema:Col:Col]` reverse-link
 * segment (see `getEsqBracketContext`). Only the last stage
 * (`currentLinkColumn`) actually closes the bracket - `schema` and
 * `schemaLinkColumn` always append the next segment's leading `:` and
 * re-trigger suggest instead, so picking a schema/column from the list
 * always walks all the way to a real 3rd-column choice rather than silently
 * closing on the (implicit-`Id`) 2-part shorthand with no way back in. A
 * user who wants the shorthand can still just type `]` by hand instead of
 * accepting a suggestion. */
export function toEsqBracketItems(
	bracket: EsqBracketContext,
	candidates: { name: string; detail?: string; documentation?: string; kind: vscode.CompletionItemKind }[],
	ctx: EsqNameSpan,
	document: vscode.TextDocument
): vscode.CompletionItem[] {
	const range = new vscode.Range(
		document.positionAt(ctx.nameStart),
		document.positionAt(ctx.nameEnd)
	);
	const rebuild = (finalValue: string, closeBracket: boolean): string => {
		const allSegs = [...bracket.rawSegs, finalValue];
		// Not closing yet (just finished the schema-name stage) means there's
		// more to type - append the next segment's leading ":" so suggest can
		// immediately re-trigger for it, rather than leaving the bracket
		// dangling with nothing to prompt the next keystroke.
		const body = `${bracket.joinPrefix}[${allSegs.join(":")}${closeBracket ? "]" : ":"}`;
		return [...bracket.parentSegments, body].join(".");
	};
	return candidates.map((c, i) => {
		const item = new vscode.CompletionItem(c.name, c.kind);
		item.detail = c.detail;
		item.sortText = `!${String(i).padStart(5, "0")}_${c.name}`;
		item.preselect = i === 0;
		if (c.documentation) {
			item.documentation = new vscode.MarkdownString(c.documentation);
		}
		const closeBracket = bracket.stage === "currentLinkColumn";
		const completed = rebuild(c.name, closeBracket);
		// Same reasoning as `toEsqColumnItems` - `range` spans the whole
		// path typed so far, so `filterText` has to match that whole span
		// (what this item would fully insert), not just the candidate's own
		// bare name, or typing past the bracket's opening char filters
		// every item out.
		item.filterText = completed;
		item.insertText = ctx.quote ? completed : `"${completed}"`;
		item.range = range;
		if (!closeBracket) {
			item.command = TRIGGER_SUGGEST;
		}
		return item;
	});
}
