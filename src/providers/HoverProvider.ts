import * as vscode from "vscode";
import { SymbolIndex } from "../index/SymbolIndex";
import { IndexedMember, schemaMessageDirectionLabel } from "../index/types";
import { getIdentifierAt, getMemberAccessPrefix, getThisGetSetContext, getThisLookupAccessContext, getThisSandboxMessageContext, getDiffBindToContext, rewriteThisRuntimePrefix } from "../parse/amdParser";
import {
	enablePlatformStubs,
	isPlatformPrefix,
	markdownHover,
	modulesFromExpr
} from "./platformLookup";

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

export class BpmsoftHoverProvider implements vscode.HoverProvider {
	constructor(private readonly index: SymbolIndex) {}

	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.Hover | undefined {
		const text = document.getText();
		const offset = document.offsetAt(position);
		const filePath = document.uri.fsPath;
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
}
