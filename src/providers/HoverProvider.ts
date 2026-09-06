import * as vscode from "vscode";
import { SymbolIndex } from "../index/SymbolIndex";
import { IndexedMember, schemaMessageDirectionLabel } from "../parse/types";
import { getIdentifierAt, getMemberAccessPrefix, getThisGetSetContext, getThisLookupAccessContext, getThisSandboxMessageContext, getDiffBindToContext, rewriteThisRuntimePrefix } from "../parse/amdParser";
import { getQueryColumnContext, getRootSchemaNameContext, resolveQueryClassNames, resolveQueryEntities } from "../parse/esqQuery";
import { enablePlatformStubs } from "../config";
import { columnHover, entityHover, isPlatformPrefix, markdownHover, modulesFromExpr } from "./platformLookup";
import { findSchemaDir } from "../index/schemaResourceLookup";
import { resolveLocalizedString, resolveLocalizedImage } from "../index/localizationLookup";

function memberHover(
	title: string,
	m: Pick<IndexedMember, "detail" | "documentation">,
	extra: string[] = []
): vscode.Hover {
	return markdownHover([
		title,
		...(m.detail ? [m.detail] : []),
		...(m.documentation ? ["", m.documentation] : []),
		...extra
	]);
}

export class HoverProvider implements vscode.HoverProvider {
	constructor(private readonly index: SymbolIndex) {}

	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.Hover | undefined {
		const text = document.getText();
		const offset = document.offsetAt(position);
		const filePath = document.uri.fsPath;

		const rootCtx = getRootSchemaNameContext(text, offset);
		if (rootCtx?.name) {
			const hover = this.entityHoverFor(rootCtx.name);
			if (hover) {
				return hover;
			}
		}

		const colCtx = getQueryColumnContext(text, offset);
		if (colCtx?.name) {
			const entities = resolveQueryEntities(text, offset, colCtx.queryIdent);
			const relOffset = offset - colCtx.nameStart;
			const target = this.index.resolveEsqTargetAtOffset(entities, colCtx.name, relOffset);
			if (target?.kind === "schema") {
				const hover = this.entityHoverFor(target.schemaName);
				if (hover) {
					return hover;
				}
			} else if (target?.kind === "column") {
				return columnHover(target.member.name, target.schemaName, target.member);
			}

			// Fell on path punctuation, or the granular walk couldn't
			// resolve a hop - fall back to the whole path's own final
			// column, same as before this method knew about cursor position.
			const resolved = this.index.resolveEsqColumnFull(entities, colCtx.name);
			if (resolved) {
				const extra: string[] = [];
				if (entities.length) {
					extra.push(`entities: ${entities.join(", ")}`);
				}
				if (resolved.hops.length) {
					extra.push(
						`join: ${resolved.hops.map((h) => `${h.joinType} → ${h.schemaName}`).join(", ")}`
					);
				}
				return columnHover(colCtx.name, entities[0] ?? "", resolved.member, extra);
			}
		}

		let thisMembers: IndexedMember[] | undefined;
		const membersOfThis = (): IndexedMember[] =>
			thisMembers ?? (thisMembers = this.index.resolveThisMembers(filePath));

		const getSet = getThisGetSetContext(text, offset);
		if (getSet?.name) {
			const m = membersOfThis().find(
				(x) => x.name === getSet.name && x.kind === "attribute"
			);
			if (m) {
				return memberHover(
					`**this.${getSet.method}("${m.name}")** *(attribute)*`,
					m
				);
			}
		}

		const sandboxMsg = getThisSandboxMessageContext(text, offset);
		if (sandboxMsg?.name) {
			const msg = this.index.resolveSchemaMessages(filePath)[sandboxMsg.name];
			if (msg) {
				return markdownHover([
					`**this.sandbox.${sandboxMsg.method}("${sandboxMsg.name}")** *(${schemaMessageDirectionLabel(msg.direction)})*`,
					...(msg.documentation ? ["", msg.documentation] : [])
				]);
			}
		}

		const bindTo = getDiffBindToContext(text, offset);
		if (bindTo?.name) {
			const m = membersOfThis().find(
				(x) =>
					x.name === bindTo.name &&
					(x.kind === "method" || x.kind === "attribute")
			);
			if (m) {
				const kindLabel = m.kind === "method" ? "method" : "attribute";
				return memberHover(`**bindTo: "${m.name}"** *(${kindLabel})*`, m);
			}
		}

		const ident = getIdentifierAt(text, offset);
		if (!ident) {
			return undefined;
		}

		const lookupAccess = getThisLookupAccessContext(text, offset);
		if (lookupAccess) {
			const attr = membersOfThis().find(
				(x) => x.name === lookupAccess.attrName && x.kind === "attribute"
			);
			const field = attr?.children?.find((c) => c.name === ident.name);
			if (attr && field) {
				return markdownHover([
					`**${field.name}** *(${attr.name} lookup/enum)*`,
					...(field.documentation ? ["", field.documentation] : []),
					...(attr.documentation ? ["", attr.documentation] : [])
				]);
			}
		}

		const left = getMemberAccessPrefix(text, ident.start);

		if (left) {
			const localization = this.resolveLocalizationHover(filePath, left, ident.name);
			if (localization) {
				return localization;
			}
		}

		if (left?.startsWith("this.")) {
			const nested = this.index.findThisPathMember(
				filePath,
				left.slice("this.".length),
				ident.name
			);
			if (nested) {
				return memberHover(`**${left}.${nested.name}** *(${nested.kind})*`, nested);
			}
		}

		const runtimePrefix = left
			? rewriteThisRuntimePrefix(left)
			: undefined;
		const globalLeft = runtimePrefix || left;
		if (globalLeft && isPlatformPrefix(globalLeft)) {
			const members = this.index.resolveMembers(globalLeft, enablePlatformStubs());
			const m = members.find((x) => x.name === ident.name);
			if (m) {
				const titleRoot = runtimePrefix ? `this.${globalLeft}` : globalLeft;
				return memberHover(
					`**${titleRoot}.${m.name}** *(${m.kind})*`,
					m,
					m.filePath ? [`\`${m.filePath}\``] : []
				);
			}
		}

		if (left === "this" || left?.startsWith("this.")) {
			const members = membersOfThis();
			const dollar = ident.name.startsWith("$") && ident.name.length > 1;
			const lookup = dollar ? ident.name.slice(1) : ident.name;
			const m = dollar
				? members.find((x) => x.name === lookup && x.kind === "attribute")
				: members.find((x) => x.name === ident.name);
			if (m) {
				const title =
					m.kind === "attribute" ? `**$${m.name}** *(attribute)*` : `**${m.name}** *(${m.kind})*`;
				return memberHover(title, m);
			}
		}

		if (left && left !== "this" && !left.startsWith("this.") && !left.includes(".")) {
			const classNames = resolveQueryClassNames(text, ident.start, left);
			const m = this.index.findQueryInstanceMember(classNames, ident.name);
			if (m) {
				return memberHover(
					`**${left}.${m.name}** *(${m.kind})*`,
					m,
					m.filePath ? [`\`${m.filePath}\``] : []
				);
			}
		}

		if (left && left !== ident.name) {
			for (const mod of modulesFromExpr(this.index, filePath, left)) {
				const m = mod.members.find((x) => x.name === ident.name);
				if (m) {
					return markdownHover([
						`**${mod.name}.${m.name}** *(${m.kind})*`,
						`\`${mod.filePath}\``,
						...(m.documentation ? ["", m.documentation] : [])
					]);
				}
			}
		}

		const modName =
			this.index.resolveLocalAlias(filePath, ident.name) || ident.name;
		const mods = this.index.getAllByName(modName);
		if (mods.length) {
			const mod = mods[0];
			const lines = [
				`**${mod.name}** *(${mod.kind})*`,
				`${mods.length} file(s) across packages`
			];
			for (const m of mods.slice(0, 8)) {
				lines.push(`- \`${m.filePath}\` (${m.members.length} members)`);
			}
			if (mods.length > 8) {
				lines.push(`- …and ${mods.length - 8} more`);
			}
			if (mod.alternateClassName) {
				lines.push(`alias: \`${mod.alternateClassName}\``);
			}
			return markdownHover(lines);
		}

		return undefined;
	}

	/** Entity/schema hover (root ESQ argument, or a schema landed on mid-path
	 * via a `[Schema:...]` reverse-link segment) - `undefined` when nothing
	 * is actually known about `schemaName`, so callers can fall through to
	 * whatever else might explain the hover. */
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

/** `Resources.Strings.<key>` / `Resources.Images.<key>` (bare expression or
	 * inside a string literal like `bindTo: "Resources.Strings.Key"` —
	 * `left`/`ident` come from the same plain character-class scan either
	 * way, quotes just aren't in the identifier charset) resolve against the
	 * *current* schema's own resources. `<param>.localizableStrings.<key>` /
	 * `<param>.localizableImages.<key>` — the schema's own injected
	 * `"{Name}Resources"` AMD dependency, commonly aliased `resources` but
	 * not always — resolve against whichever schema that dependency actually
	 * names, which is frequently a *different* schema (a mixin, a base
	 * page, …) than the one being edited; `paramNames`/`dependencies`
	 * positional lookup (`resolveLocalAlias`) is what already backs the
	 * plain "jump to this dependency" hover/definition cases, so it's the
	 * right lookup here too. See `localizationLookup.ts` for the resolution
	 * rules (same XML item family, either access path per kind — images
	 * have real, documented gaps a string lookup doesn't). */
	private resolveLocalizationHover(
		filePath: string,
		left: string,
		key: string
	): vscode.Hover | undefined {
		const kind =
			left === "Resources.Strings" || /\.localizableStrings$/.test(left)
				? "strings"
				: left === "Resources.Images" || /\.localizableImages$/.test(left)
					? "images"
					: undefined;
		if (!kind) {
			return undefined;
		}
		const ownSchema = findSchemaDir(filePath);
		let schemaName: string | undefined;
		if (left === "Resources.Strings" || left === "Resources.Images") {
			schemaName = ownSchema?.schemaName;
		} else {
			const paramName = left.slice(0, left.lastIndexOf("."));
			const dep = this.index.resolveLocalAlias(filePath, paramName);
			schemaName = dep?.endsWith("Resources") ? dep.slice(0, -"Resources".length) : undefined;
		}
		if (!schemaName) {
			return undefined;
		}
		const schemaDir =
			schemaName === ownSchema?.schemaName
				? ownSchema.schemaDir
				: this.findSchemaDirByName(schemaName);
		if (!schemaDir) {
			return undefined;
		}
		return kind === "strings"
			? this.stringHover(schemaDir, schemaName, key)
			: this.imageHover(schemaDir, schemaName, key);
	}

	private stringHover(schemaDir: string, schemaName: string, key: string): vscode.Hover | undefined {
		const localized = resolveLocalizedString(schemaDir, schemaName, key);
		if (!localized) {
			return undefined;
		}
		return markdownHover([
			`**${key}** *(Resources.Strings, ${schemaName})*`,
			...localized.values.map((v) => `**${v.culture}:** ${v.value}`)
		]);
	}

	private imageHover(schemaDir: string, schemaName: string, key: string): vscode.Hover | undefined {
		const images = resolveLocalizedImage(schemaDir, schemaName, key);
		if (!images) {
			return undefined;
		}
		// Same image reused across every culture is the common case - group
		// by content so it's shown once, not once per culture.
		const byContent = new Map<string, { mimeType: string; cultures: string[] }>();
		for (const img of images) {
			const entry = byContent.get(img.base64);
			if (entry) {
				entry.cultures.push(img.culture);
			} else {
				byContent.set(img.base64, { mimeType: img.mimeType, cultures: [img.culture] });
			}
		}
		const lines = [`**${key}** *(Resources.Images, ${schemaName})*`];
		for (const [base64, { mimeType, cultures }] of byContent) {
			lines.push(cultures.join(", "));
			// Plain Markdown image syntax has no size control, and these are
			// UI icons - rendered at native size (often the SVG's own large
			// viewBox) they can dwarf the rest of the hover. An HTML <img>
			// with a fixed width (height follows automatically) needs
			// supportHtml on the MarkdownString.
			lines.push(`<img src="data:${mimeType};base64,${base64}" width="32" />`);
		}
		return markdownHover(lines, true);
	}

	private findSchemaDirByName(schemaName: string): string | undefined {
		for (const mod of this.index.getAllByName(schemaName)) {
			const dir = findSchemaDir(mod.filePath)?.schemaDir;
			if (dir) {
				return dir;
			}
		}
		return undefined;
	}
}
