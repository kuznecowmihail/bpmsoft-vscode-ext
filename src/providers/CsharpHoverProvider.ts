import * as vscode from "vscode";
import { csharpStringLiteralAt } from "../parse/csharpStyleAnalyzer";
import { findSchemaDir } from "../index/schemaResourceLookup";
import { resolveLocalizedString } from "../index/localizationLookup";
import { markdownHover } from "./platformLookup";
import { SymbolIndex } from "../index/SymbolIndex";
import {
	collectCsharpEsqDeclarations,
	findEsqDeclarationForOffset,
	getCsharpEsqColumnContext
} from "../parse/esqCsharp";

/**
 * Two independent hover sources for `.cs` files:
 *
 * 1. `EntitySchemaQuery` — hovering the root-schema-name string literal in
 *    `new EntitySchemaQuery(EntitySchemaManager, "Contact")` shows the
 *    entity; hovering a column-path argument to `.AddColumn(...)` /
 *    `.CreateFilterWithParameters(...)` / etc. resolves it the same way the
 *    JS side does (`esqColumnPath.ts` — join-type prefixes, reverse-link
 *    `[Schema:Col:Col]` segments, multi-hop). See `esqCsharp.ts` for the
 *    token-based declaration/call-site detection (no C# AST here, unlike
 *    JS's real scope tree).
 *
 * 2. Localization strings — a string-literal key (e.g.
 *    `GetLocalizableStringValue(userConnection, "SomeKey")`, or the raw
 *    `"LocalizableStrings.SomeKey.Value"` form) shows the actual RU/EN text
 *    from that schema's own resource XML — see `localizationLookup.ts` for
 *    the resolution rule shared with the JS `HoverProvider`. Deliberately
 *    scoped to "this schema's own resources": real C# helper methods for
 *    this vary per file (different names, some take an explicit
 *    `resourceManagerName` pointing at a *different* schema's resources —
 *    no single call shape to key off reliably, unlike JS's fixed AMD
 *    dependency convention).
 */
export class CsharpHoverProvider implements vscode.HoverProvider {
	constructor(private readonly index: SymbolIndex) {}

	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.Hover | undefined {
		const text = document.getText();
		const offset = document.offsetAt(position);

		const esqHover = this.resolveEsqHover(text, offset);
		if (esqHover) {
			return esqHover;
		}

		const schema = findSchemaDir(document.uri.fsPath);
		if (!schema) {
			return undefined;
		}
		const literal = csharpStringLiteralAt(text, offset);
		if (!literal?.value) {
			return undefined;
		}
		// Accept both the bare key ("SomeKey") and the fully-qualified XML
		// item name some code builds directly ("LocalizableStrings.SomeKey.Value").
		const key = literal.value.replace(/^LocalizableStrings\.(.+)\.Value$/, "$1");
		const localized = resolveLocalizedString(schema.schemaDir, schema.schemaName, key);
		if (!localized) {
			return undefined;
		}
		return markdownHover([
			`**${key}** *(Resources.Strings, ${schema.schemaName})*`,
			...localized.values.map((v) => `**${v.culture}:** ${v.value}`)
		]);
	}

	private resolveEsqHover(text: string, offset: number): vscode.Hover | undefined {
		const declarations = collectCsharpEsqDeclarations(text);

		// Hovering the root-schema-name literal itself, e.g. the "Contact" in
		// new EntitySchemaQuery(EntitySchemaManager, "Contact").
		const onRootName = declarations.find(
			(d) => offset >= d.nameLiteralStart && offset <= d.nameLiteralEnd
		);
		if (onRootName) {
			const def = this.index.findEntityDefinition(onRootName.schemaName);
			const cols = this.index.resolveEntityColumns(onRootName.schemaName);
			if (def || cols.length) {
				const lines = [`**${onRootName.schemaName}** *(entity)*`];
				if (def) {
					lines.push(`\`${def.filePath}\``);
				}
				if (cols.length) {
					lines.push(`${cols.length} column(s)`);
				}
				return markdownHover(lines);
			}
			return undefined;
		}

		const colCtx = getCsharpEsqColumnContext(text, offset);
		if (!colCtx) {
			return undefined;
		}
		const decl = findEsqDeclarationForOffset(declarations, colCtx.varName, offset);
		if (!decl) {
			return undefined;
		}
		const resolved = this.index.resolveEsqColumnFull([decl.schemaName], colCtx.path);
		if (!resolved) {
			return undefined;
		}
		const lines = [
			`**${colCtx.path}** *(entity column, ${decl.schemaName})*`,
			...(resolved.member.detail ? [resolved.member.detail] : []),
			...(resolved.member.documentation ? ["", resolved.member.documentation] : [])
		];
		if (resolved.hops.length) {
			lines.push(`join: ${resolved.hops.map((h) => `${h.joinType} → ${h.schemaName}`).join(", ")}`);
		}
		return markdownHover(lines);
	}
}
