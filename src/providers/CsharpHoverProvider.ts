import * as vscode from "vscode";
import { csharpStringLiteralAt } from "../parse/csharpStyleAnalyzer";
import { findSchemaDir } from "../index/schemaResourceLookup";
import { resolveLocalizedString } from "../index/localizationLookup";
import { markdownHover } from "./platformLookup";

/**
 * Hover on a string-literal localization key (e.g. `GetLocalizableStringValue(
 * userConnection, "SomeKey")`, or the raw `"LocalizableStrings.SomeKey.Value"`
 * form) shows the actual RU/EN text from that schema's own resource XML —
 * see `localizationLookup.ts` for the resolution rule shared with the JS
 * `HoverProvider`.
 *
 * Deliberately scoped to "this schema's own resources": real C# helper
 * methods for this vary per file (different names, some take an explicit
 * `resourceManagerName` pointing at a *different* schema's resources — no
 * single call shape to key off reliably, unlike JS's fixed AMD dependency
 * convention). Resolving against the current file's own schema covers the
 * common single-key-argument case; a cross-schema `resourceManagerName`
 * argument isn't followed — no hint rather than a wrong one.
 */
export class CsharpHoverProvider implements vscode.HoverProvider {
	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.Hover | undefined {
		const schema = findSchemaDir(document.uri.fsPath);
		if (!schema) {
			return undefined;
		}
		const text = document.getText();
		const offset = document.offsetAt(position);
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
}
