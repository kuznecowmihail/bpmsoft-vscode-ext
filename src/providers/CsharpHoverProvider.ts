import * as vscode from "vscode";
import { csharpStringLiteralAt } from "../parse/csharpStyleAnalyzer";
import { findSchemaDir } from "../index/schemaResourceLookup";
import { resolveLocalizedString } from "../index/localizationLookup";
import { columnHover, entityHover, markdownHover } from "./platformLookup";
import { SymbolIndex } from "../index/SymbolIndex";
import {
	collectCsharpEsqDeclarations,
	esqLiteralContentRange,
	findEsqDeclarationForOffset,
	getCsharpEsqColumnContext
} from "../parse/esqCsharp";
import { findEnclosingEntityEventListenerSchema, getEntityColumnContext } from "../parse/entityCsharp";
import { collectDbQueryChains, getDbQueryColumnContext } from "../parse/dbQueryCsharp";

/**
 * Four independent hover sources for `.cs` files:
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
 * 2. `Entity` CRUD — `entity.SetColumnValue("Col", ...)` /
 *    `.GetTypedColumnValue<T>("Col")` / `.GetColumnValue("Col")` resolve
 *    against the nearest enclosing `[EntityEventListener(SchemaName = "X")]`
 *    class attribute — see `entityCsharp.ts` for why that's the one
 *    reliably-traceable case, not every possible way an `Entity` reaches
 *    that call.
 *
 * 3. Direct-access query builders — `BPMSoft.Core.DB.Select`/`Insert`/
 *    `Update`/`Delete`, the fluent SQL builder API. Hovering the root
 *    schema name (`.From("Contact")`/`.Into("Contact")`, or `Update`'s own
 *    constructor argument) shows the entity; hovering a column argument to
 *    `.Column(...)`/`.Set(...)`/`.Where(...)` resolves it — see
 *    `dbQueryCsharp.ts` for why this needs its own detection (plain
 *    table/column names, fluent one-statement chains, no path DSL at all —
 *    a genuinely different API shape than `EntitySchemaQuery`).
 *
 * 4. Localization strings — a string-literal key (e.g.
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

		const entityColumnHover = this.resolveEntityColumnHover(text, offset);
		if (entityColumnHover) {
			return entityColumnHover;
		}

		const dbQueryHover = this.resolveDbQueryHover(text, offset);
		if (dbQueryHover) {
			return dbQueryHover;
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
			return this.entityHoverFor(onRootName.schemaName);
		}

		const colCtx = getCsharpEsqColumnContext(text, offset);
		if (!colCtx) {
			return undefined;
		}
		const decl = findEsqDeclarationForOffset(declarations, colCtx.varName, offset);
		if (!decl) {
			return undefined;
		}

		const relOffset = offset - esqLiteralContentRange(text, colCtx).start;
		const target = this.index.resolveEsqTargetAtOffset(
			[decl.schemaName],
			colCtx.path,
			relOffset
		);
		if (target?.kind === "schema") {
			const hover = this.entityHoverFor(target.schemaName);
			if (hover) {
				return hover;
			}
		} else if (target?.kind === "column") {
			return columnHover(target.member.name, target.schemaName, target.member);
		}

		// Fell on path punctuation, or the granular walk couldn't resolve a
		// hop - fall back to the whole path's own final column.
		const resolved = this.index.resolveEsqColumnFull([decl.schemaName], colCtx.path);
		if (!resolved) {
			return undefined;
		}
		const extra: string[] = [];
		if (resolved.hops.length) {
			extra.push(`join: ${resolved.hops.map((h) => `${h.joinType} → ${h.schemaName}`).join(", ")}`);
		}
		return columnHover(colCtx.path, decl.schemaName, resolved.member, extra);
	}

	/** Entity/schema hover shared by the root-name and mid-path (bracket
	 * `[Schema:...]`) cases - `undefined` when nothing is actually known
	 * about `schemaName`. */
	private entityHoverFor(schemaName: string): vscode.Hover | undefined {
		const def = this.index.findEntityDefinition(schemaName);
		const cols = this.index.resolveEntityColumns(schemaName);
		if (!def && !cols.length) {
			return undefined;
		}
		return entityHover(schemaName, {
			filePath: def?.filePath,
			caption: this.index.resolveEntityCaption(schemaName),
			columnCount: cols.length
		});
	}

	private resolveEntityColumnHover(text: string, offset: number): vscode.Hover | undefined {
		const colCtx = getEntityColumnContext(text, offset);
		if (!colCtx) {
			return undefined;
		}
		// A schema explicitly named right in the call (nameof(Schema.Column))
		// beats the ambient listener context when it's a real, known schema -
		// it's the more direct signal, and is sometimes a genuinely different
		// schema than the enclosing listener's own (a related entity reached
		// under an unrelated variable name). Only falls back to the listener
		// when there's no such qualifier, or it isn't a real schema at all.
		const schemaName =
			(colCtx.explicitSchemaName && this.index.findEntityDefinition(colCtx.explicitSchemaName)
				? colCtx.explicitSchemaName
				: undefined) ?? findEnclosingEntityEventListenerSchema(text, offset);
		if (!schemaName) {
			return undefined;
		}
		const member = this.index
			.resolveEntityColumns(schemaName)
			.find((m) => m.name === colCtx.columnName);
		if (!member) {
			return undefined;
		}
		return columnHover(colCtx.columnName, schemaName, member);
	}

	private resolveDbQueryHover(text: string, offset: number): vscode.Hover | undefined {
		const chains = collectDbQueryChains(text);

		const onSchemaName = chains.find(
			(c) =>
				c.schemaName !== undefined &&
				c.schemaNameStart !== undefined &&
				c.schemaNameEnd !== undefined &&
				offset >= c.schemaNameStart &&
				offset <= c.schemaNameEnd
		);
		if (onSchemaName) {
			return this.entityHoverFor(onSchemaName.schemaName!);
		}

		const colCtx = getDbQueryColumnContext(text, offset, chains);
		if (!colCtx) {
			return undefined;
		}
		const member = this.index
			.resolveEntityColumns(colCtx.schemaName)
			.find((m) => m.name === colCtx.columnName);
		if (!member) {
			return undefined;
		}
		return columnHover(colCtx.columnName, colCtx.schemaName, member);
	}
}
