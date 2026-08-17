import * as vscode from "vscode";
import { SymbolIndex } from "../index/SymbolIndex";
import { getIdentifierAt, getMemberAccessPrefix, getThisGetSetContext, getThisLookupAccessContext, rewriteThisRuntimePrefix } from "../parse/amdParser";

export class BpmsoftHoverProvider implements vscode.HoverProvider {
	constructor(private readonly index: SymbolIndex) {}

	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.Hover | undefined {
		const text = document.getText();
		const offset = document.offsetAt(position);
		const getSet = getThisGetSetContext(text, offset);
		if (getSet?.name) {
			const members = this.index.resolveThisMembers(document.uri.fsPath);
			const m = members.find(
				(x) => x.name === getSet.name && x.kind === "attribute"
			);
			if (m) {
				const lines = [
					`**this.${getSet.method}("${m.name}")** *(attribute)*`,
					...(m.detail ? [m.detail] : []),
					...(m.documentation ? ["", m.documentation] : [])
				];
				return new vscode.Hover(new vscode.MarkdownString(lines.join("\n\n")));
			}
		}

		const ident = getIdentifierAt(text, offset);
		if (!ident) {
			return undefined;
		}

		const lookupAccess = getThisLookupAccessContext(text, offset);
		if (lookupAccess) {
			const members = this.index.resolveThisMembers(document.uri.fsPath);
			const attr = members.find(
				(x) => x.name === lookupAccess.attrName && x.kind === "attribute"
			);
			const field = attr?.children?.find((c) => c.name === ident.name);
			if (attr && field) {
				const lines = [
					`**${field.name}** *(${attr.name} lookup/enum)*`,
					...(field.documentation ? ["", field.documentation] : []),
					...(attr.documentation ? ["", attr.documentation] : [])
				];
				return new vscode.Hover(new vscode.MarkdownString(lines.join("\n\n")));
			}
		}

		const left = getMemberAccessPrefix(text, ident.start);
		const lines: string[] = [];
		const enableStubs = vscode.workspace
			.getConfiguration("bpmsoft")
			.get<boolean>("enablePlatformStubs", true);

		if (left?.startsWith("this.")) {
			const nested = this.index.findThisPathMember(
				document.uri.fsPath,
				left.slice("this.".length),
				ident.name
			);
			if (nested) {
				const titlePath = `${left}.${nested.name}`;
				lines.push(`**${titlePath}** *(${nested.kind})*`);
				if (nested.detail) {
					lines.push(nested.detail);
				}
				if (nested.documentation) {
					lines.push("", nested.documentation);
				}
				return new vscode.Hover(new vscode.MarkdownString(lines.join("\n\n")));
			}
		}

		const runtimePrefix = left
			? rewriteThisRuntimePrefix(left)
			: undefined;
		const globalLeft = runtimePrefix || left;
		if (
			globalLeft === "BPMSoft" ||
			globalLeft?.startsWith("BPMSoft.") ||
			globalLeft === "Ext" ||
			globalLeft?.startsWith("Ext.")
		) {
			const members = this.index.resolveMembers(globalLeft, enableStubs);
			const m = members.find((x) => x.name === ident.name);
			if (m) {
				const titleRoot = runtimePrefix ? `this.${globalLeft}` : globalLeft;
				lines.push(
					`**${titleRoot}.${m.name}** *(${m.kind})*`
				);
				if (m.documentation) {
					lines.push("", m.documentation);
				}
				return new vscode.Hover(new vscode.MarkdownString(lines.join("\n\n")));
			}
		}

		if (left === "this" || left?.startsWith("this")) {
			const members = this.index.resolveThisMembers(document.uri.fsPath);
			const dollar = ident.name.startsWith("$") && ident.name.length > 1;
			const lookup = dollar ? ident.name.slice(1) : ident.name;
			const m = dollar
				? members.find((x) => x.name === lookup && x.kind === "attribute")
				: members.find((x) => x.name === ident.name);
			if (m) {
				const title =
					m.kind === "attribute" ? `**$${m.name}** *(attribute)*` : `**${m.name}** *(${m.kind})*`;
				lines.push(title);
				if (m.detail) {
					lines.push(m.detail);
				}
				if (m.documentation) {
					lines.push("", m.documentation);
				}
				return new vscode.Hover(new vscode.MarkdownString(lines.join("\n\n")));
			}
		}

		if (left && left !== ident.name) {
			const root = left.split(".")[0];
			const resolved =
				this.index.resolveLocalAlias(document.uri.fsPath, root) || root;
			const mods = this.index
				.getAllByName(resolved)
				.concat(this.index.getAllByName(left));
			const unique = new Map(mods.map((m) => [m.filePath, m]));
			for (const mod of unique.values()) {
				const m = mod.members.find((x) => x.name === ident.name);
				if (m) {
					lines.push(`**${mod.name}.${m.name}** *(${m.kind})*`);
					lines.push(`\`${mod.filePath}\``);
					if (m.documentation) {
						lines.push("", m.documentation);
					}
					return new vscode.Hover(new vscode.MarkdownString(lines.join("\n\n")));
				}
			}
		}

		const modName =
			this.index.resolveLocalAlias(document.uri.fsPath, ident.name) ||
			ident.name;
		const mods = this.index.getAllByName(modName);
		if (mods.length) {
			const mod = mods[0];
			lines.push(`**${mod.name}** *(${mod.kind})*`);
			lines.push(`${mods.length} file(s) across packages`);
			for (const m of mods.slice(0, 8)) {
				lines.push(`- \`${m.filePath}\` (${m.members.length} members)`);
			}
			if (mods.length > 8) {
				lines.push(`- …and ${mods.length - 8} more`);
			}
			if (mod.alternateClassName) {
				lines.push(`alias: \`${mod.alternateClassName}\``);
			}
			return new vscode.Hover(new vscode.MarkdownString(lines.join("\n\n")));
		}

		return undefined;
	}
}
