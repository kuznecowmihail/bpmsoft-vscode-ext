import * as vscode from "vscode";
import { SymbolIndex } from "../index/SymbolIndex";
import { IndexedMember } from "../parse/types";
import {
	collectCsharpEsqDeclarations,
	findEsqDeclarationForOffset,
	getCsharpEsqColumnCompletionContext,
	getCsharpEsqRootNameCompletionContext
} from "../parse/esqCsharp";
import {
	EsqBracketContext,
	getEsqBracketContext,
	toEntityNameItems,
	toEsqBracketItems,
	toEsqColumnItems
} from "./esqCompletion";
import { EsqNameSpan } from "../parse/esqQuery";

/**
 * ESQ completion for `.cs` files - the C# counterpart of the JS
 * `CompletionProvider`'s own ESQ column-path completion, built on the exact
 * same `esqCompletion.ts` item builders (dotted-path member suggestions,
 * `[Schema:Col:Col]` reverse-link 3-stage completion) so both languages
 * suggest and insert identically; only the "where's the cursor, what string
 * literal is it in" detection differs (see `esqCsharp.ts` - token-based, no
 * C# AST here).
 *
 * Two contexts, mirroring `CsharpHoverProvider.resolveEsqHover`:
 * 1. The root-schema-name argument of
 *    `new EntitySchemaQuery(EntitySchemaManager, "Con|")` - entity names.
 * 2. A column-path argument to `.AddColumn("SysUser.Ac|")` /
 *    `.CreateFilterWithParameters(...)` / etc. - dotted-path member
 *    completion and bracket-stage completion, resolved against whichever
 *    `EntitySchemaQuery` declaration `esqVar` refers to at this offset.
 */
export class CsharpCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private readonly index: SymbolIndex) {}

	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.CompletionList | undefined {
		const offset = document.offsetAt(position);
		const text = document.getText();

		const rootCtx = getCsharpEsqRootNameCompletionContext(text, offset);
		if (rootCtx) {
			const ctx = toNameSpan(rootCtx);
			return asList(
				toEntityNameItems(this.index.listEntityNames(rootCtx.typed), ctx, document),
				true
			);
		}

		const colCtx = getCsharpEsqColumnCompletionContext(text, offset);
		if (!colCtx) {
			return undefined;
		}
		const declarations = collectCsharpEsqDeclarations(text);
		const decl = findEsqDeclarationForOffset(declarations, colCtx.varName, offset);
		if (!decl) {
			return undefined;
		}
		const entities = [decl.schemaName];
		const ctx = toNameSpan(colCtx);

		const bracketCtx = getEsqBracketContext(colCtx.typed);
		if (bracketCtx) {
			return asList(this.esqBracketItems(bracketCtx, entities, ctx, document), true);
		}

		const endsDot = colCtx.typed.endsWith(".");
		const parts = colCtx.typed.split(".");
		const parentPath = endsDot ? parts.filter(Boolean) : parts.slice(0, -1).filter(Boolean);
		const prefix = endsDot ? "" : parts[parts.length - 1] || "";
		const members = parentPath.length
			? this.membersAt(entities, parentPath.join("."))
			: this.index.resolveEntityColumns(decl.schemaName);
		const filtered = prefix
			? members.filter((m) => m.name.toLowerCase().startsWith(prefix.toLowerCase()))
			: members;
		return asList(toEsqColumnItems(filtered, ctx, parentPath, document), true);
	}

	private membersAt(entities: string[], pathSoFar: string): IndexedMember[] {
		const schema = this.index.resolveEsqPathSchema(entities, pathSoFar);
		return schema ? this.index.resolveEntityColumns(schema) : [];
	}

	/** Same bracket-stage candidate resolution as the JS `CompletionProvider`
	 * - see `SymbolIndex.resolveEsqBracketCandidates` for the actual
	 * filtering rules. */
	private currentSchemaCandidates(bracket: EsqBracketContext, entities: string[]): string[] {
		if (!bracket.parentSegments.length) {
			return entities;
		}
		const resolved = this.index.resolveEsqPathSchema(entities, bracket.parentSegments.join("."));
		return resolved ? [resolved] : [];
	}

	private esqBracketItems(
		bracket: EsqBracketContext,
		entities: string[],
		ctx: EsqNameSpan,
		document: vscode.TextDocument
	): vscode.CompletionItem[] {
		const result = this.index.resolveEsqBracketCandidates(
			bracket,
			this.currentSchemaCandidates(bracket, entities)
		);
		if (result.kind === "schema") {
			const candidates = result.names.map((name) => {
				const caption = this.index.resolveEntityCaption(name);
				return {
					name,
					kind: vscode.CompletionItemKind.Class,
					detail: "BPMSoft · entity (reverse join)",
					documentation: caption ? `*${caption}*` : undefined
				};
			});
			return toEsqBracketItems(bracket, candidates, ctx, document);
		}
		const candidates = result.members.map((m) => ({
			name: m.name,
			kind: vscode.CompletionItemKind.Field,
			detail: m.detail || "entity column",
			documentation: m.caption
				? `*${m.caption}*${m.documentation ? `\n\n${m.documentation}` : ""}`
				: m.documentation
		}));
		return toEsqBracketItems(bracket, candidates, ctx, document);
	}
}

function toNameSpan(ctx: { typed: string; contentStart: number; contentEnd: number }): EsqNameSpan {
	return {
		quote: '"',
		name: ctx.typed,
		nameStart: ctx.contentStart,
		nameEnd: ctx.contentEnd
	};
}

function asList(
	items: vscode.CompletionItem[],
	incomplete = false
): vscode.CompletionList | undefined {
	return items.length ? new vscode.CompletionList(items, incomplete) : undefined;
}
