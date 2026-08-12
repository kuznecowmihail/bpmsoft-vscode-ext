import * as vscode from "vscode";
import { SymbolIndex } from "../index/SymbolIndex";
import { getIdentifierAt, getMemberAccessPrefix } from "../parse/amdParser";

export class BpmsoftHoverProvider implements vscode.HoverProvider {
	constructor(private readonly index: SymbolIndex) {}

	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.Hover | undefined {
		const text = document.getText();
		const offset = document.offsetAt(position);
		const ident = getIdentifierAt(text, offset);
		if (!ident) {
			return undefined;
		}

		const left = getMemberAccessPrefix(text, ident.start);
		const lines: string[] = [];

		if (left === "this" || left?.startsWith("this")) {
			const members = this.index.resolveThisMembers(document.uri.fsPath);
			const m = members.find((x) => x.name === ident.name);
			if (m) {
				lines.push(`**${m.name}** *(${m.kind})*`);
				if (m.detail) {
					lines.push(m.detail);
				}
				if (m.documentation) {
					lines.push("", m.documentation);
				}
				return new vscode.Hover(new vscode.MarkdownString(lines.join("\n\n")));
			}
		}

		if (left === "BPMSoft" || left?.startsWith("BPMSoft.")) {
			const enableStubs = vscode.workspace
				.getConfiguration("bpmsoft")
				.get<boolean>("enablePlatformStubs", true);
			const members = this.index.resolveMembers(left, enableStubs);
			const m = members.find((x) => x.name === ident.name);
			if (m) {
				lines.push(
					`**BPMSoft.${left === "BPMSoft" ? m.name : left.slice(9) + "." + m.name}** *(${m.kind})*`
				);
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
