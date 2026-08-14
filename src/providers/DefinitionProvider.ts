import * as vscode from "vscode";
import { SymbolIndex } from "../index/SymbolIndex";
import { getIdentifierAt, getMemberAccessPrefix, getThisGetSetContext, getThisLookupAccessContext } from "../parse/amdParser";

export class BpmsoftDefinitionProvider implements vscode.DefinitionProvider {
	constructor(private readonly index: SymbolIndex) {}

	provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.Definition | undefined {
		const text = document.getText();
		const offset = document.offsetAt(position);
		const locations: vscode.Location[] = [];
		const getSet = getThisGetSetContext(text, offset);
		if (getSet?.name) {
			for (const hit of this.index.findThisMemberLocations(
				document.uri.fsPath,
				getSet.name,
				"attribute"
			)) {
				if (!hit.member.position) {
					continue;
				}
				locations.push(
					new vscode.Location(
						vscode.Uri.file(hit.module.filePath),
						new vscode.Position(
							hit.member.position.line,
							hit.member.position.character
						)
					)
				);
			}
			if (locations.length) {
				return locations;
			}
		}

		const ident = getIdentifierAt(text, offset);
		if (!ident) {
			return undefined;
		}
		const lookupAccess = getThisLookupAccessContext(text, offset);
		if (
			lookupAccess &&
			(ident.name === "value" || ident.name === "displayValue")
		) {
			for (const hit of this.index.findThisMemberLocations(
				document.uri.fsPath,
				lookupAccess.attrName,
				"attribute"
			)) {
				if (!hit.member.position) {
					continue;
				}
				locations.push(
					new vscode.Location(
						vscode.Uri.file(hit.module.filePath),
						new vscode.Position(
							hit.member.position.line,
							hit.member.position.character
						)
					)
				);
			}
			if (locations.length) {
				return locations;
			}
		}

		const leftExpr = getMemberAccessPrefix(text, ident.start);

		if (leftExpr === "this" || leftExpr?.startsWith("this")) {
			for (const hit of this.index.findThisMemberLocations(
				document.uri.fsPath,
				ident.name
			)) {
				if (!hit.member.position) {
					continue;
				}
				locations.push(
					new vscode.Location(
						vscode.Uri.file(hit.module.filePath),
						new vscode.Position(
							hit.member.position.line,
							hit.member.position.character
						)
					)
				);
			}
		} else if (leftExpr && leftExpr !== ident.name) {
			for (const m of this.resolveModulesFromExpr(
				document.uri.fsPath,
				leftExpr
			)) {
				const member = m.members.find((x) => x.name === ident.name);
				if (member?.position) {
					locations.push(
						new vscode.Location(
							vscode.Uri.file(m.filePath),
							new vscode.Position(
								member.position.line,
								member.position.character
							)
						)
					);
				}
			}
		}

		const asModules = this.index.getAllByName(
			this.index.resolveLocalAlias(document.uri.fsPath, ident.name) ||
				ident.name
		);
		for (const asModule of asModules) {
			locations.push(
				new vscode.Location(
					vscode.Uri.file(asModule.filePath),
					new vscode.Position(0, 0)
				)
			);
		}

		if (!locations.length) {
			const line = document.lineAt(position.line).text;
			const before = line.slice(0, position.character);
			if (/\bthis\.[\w$]*$/.test(before)) {
				for (const hit of this.index.findThisMemberLocations(
					document.uri.fsPath,
					ident.name
				)) {
					if (!hit.member.position) {
						continue;
					}
					locations.push(
						new vscode.Location(
							vscode.Uri.file(hit.module.filePath),
							new vscode.Position(
								hit.member.position.line,
								hit.member.position.character
							)
						)
					);
				}
			}
		}

		return locations.length ? locations : undefined;
	}

	private resolveModulesFromExpr(filePath: string, expr: string) {
		const root = expr.split(".")[0];
		const resolved =
			this.index.resolveLocalAlias(filePath, root) || root;
		const mods = this.index
			.getAllByName(resolved)
			.concat(this.index.getAllByName(expr));
		const unique = new Map(mods.map((m) => [m.filePath, m]));
		return Array.from(unique.values());
	}
}
