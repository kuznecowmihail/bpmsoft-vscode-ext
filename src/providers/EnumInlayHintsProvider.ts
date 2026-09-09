import * as vscode from "vscode";
import { SymbolIndex } from "../index/SymbolIndex";
import { parseJs } from "../parse/jsAst";
import { collectEnumHintSites, EnumHintSite } from "../parse/enumHintSites";
import { resolveGenericEnumField, resolveRuleEnumField } from "../parse/enumHints";
import { describeRule } from "../parse/businessRuleDescription";
import { isJsFile } from "./jsDocuments";
import { enumInlayHintsEnabled } from "../config";

/**
 * Always-visible inline hints decoding "magic number" enum fields
 * (`dataValueType`/`itemType`/`contentType`/`comparisonType`, and
 * `rules`/`businessRules` `ruleType`/`property`) and, at each
 * `rules`/`businessRules` rule-id key, a short "what this rule does"
 * summary (full description in the hint's own tooltip).
 *
 * Uses VS Code's dedicated `InlayHint` rendering layer rather than a
 * `TextEditorDecorationType` — a different layer from the one GitLens's
 * current-line blame annotation uses, and anchored at the token itself
 * rather than end-of-line, so it renders unconditionally (not tied to
 * selection the way GitLens's blame is) without colliding with it.
 */
export class EnumInlayHintsProvider implements vscode.InlayHintsProvider {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeInlayHints = this.changeEmitter.event;

	constructor(private readonly index: SymbolIndex) {}

	refresh(): void {
		this.changeEmitter.fire();
	}

	provideInlayHints(document: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
		if (!isJsFile(document) || !enumInlayHintsEnabled()) {
			return [];
		}
		const source = document.getText();
		const ast = parseJs(source);
		if (!ast) {
			return [];
		}
		// The AST walk itself still covers the whole file (a hint site's
		// enclosing structure isn't cheap to scope to a range up front), but
		// filtering the results to the requested viewport range keeps the
		// `InlayHint` construction/marshalling cost proportional to what's
		// actually visible rather than the whole file.
		const rangeStart = document.offsetAt(range.start);
		const rangeEnd = document.offsetAt(range.end);
		const sites = collectEnumHintSites(ast).filter((s) => s.end >= rangeStart && s.start <= rangeEnd);
		const hints: vscode.InlayHint[] = [];
		const resolveComparisonType = (raw: string) => this.index.resolvePlatformEnumMemberName("ComparisonType", raw);
		for (const site of sites) {
			const hint = this.buildHint(document, site, resolveComparisonType);
			if (hint) {
				hints.push(hint);
			}
		}
		return hints;
	}

	private buildHint(
		document: vscode.TextDocument,
		site: EnumHintSite,
		resolveComparisonType: (raw: string) => string | undefined
	): vscode.InlayHint | undefined {
		if (site.kind === "literal") {
			const resolved =
				site.scope === "generic"
					? resolveGenericEnumField(this.index, site.fieldName, site.rawValue)
					: resolveRuleEnumField(site.fieldName, site.rawValue, site.ruleTypeRaw);
			if (!resolved) {
				return undefined;
			}
			const hint = new vscode.InlayHint(
				document.positionAt(site.end),
				resolved.symbol,
				vscode.InlayHintKind.Type
			);
			hint.paddingLeft = true;
			return hint;
		}
		const description = describeRule(site.ruleObj, resolveComparisonType);
		const hint = new vscode.InlayHint(
			document.positionAt(site.end),
			description.short,
			vscode.InlayHintKind.Type
		);
		hint.paddingLeft = true;
		hint.tooltip = new vscode.MarkdownString(description.full);
		return hint;
	}
}
