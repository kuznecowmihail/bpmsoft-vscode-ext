import * as vscode from "vscode";
import { SymbolIndex } from "../index/SymbolIndex";
import { IndexedMember } from "../index/types";
import { getIdentifierAt, getMemberAccessPrefix, getThisGetSetContext, getThisLookupAccessContext, getThisSandboxMessageContext, getDiffBindToContext, rewriteThisRuntimePrefix } from "../parse/amdParser";

function memberLocation(member: IndexedMember | undefined): vscode.Location | undefined {
	if (!member?.filePath || !member.position) {
		return undefined;
	}
	return new vscode.Location(
		vscode.Uri.file(member.filePath),
		new vscode.Position(member.position.line, member.position.character)
	);
}

function hitLocation(hit: {
	module: { filePath: string };
	member: IndexedMember;
}): vscode.Location | undefined {
	if (!hit.member.position) {
		return undefined;
	}
	return new vscode.Location(
		vscode.Uri.file(hit.module.filePath),
		new vscode.Position(hit.member.position.line, hit.member.position.character)
	);
}

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
			this.pushThisHits(locations, document.uri.fsPath, getSet.name, "attribute");
			if (locations.length) {
				return locations;
			}
		}

		const sandboxMsg = getThisSandboxMessageContext(text, offset);
		if (sandboxMsg?.name) {
			for (const hit of this.index.findSchemaMessageLocations(
				document.uri.fsPath,
				sandboxMsg.name
			)) {
				this.pushUnique(
					locations,
					new vscode.Location(
						vscode.Uri.file(hit.filePath),
						new vscode.Position(hit.position.line, hit.position.character)
					)
				);
			}
			if (locations.length) {
				return locations;
			}
		}

		const bindTo = getDiffBindToContext(text, offset);
		if (bindTo?.name) {
			this.pushThisHits(locations, document.uri.fsPath, bindTo.name, "method");
			this.pushThisHits(locations, document.uri.fsPath, bindTo.name, "attribute");
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
			this.pushThisHits(
				locations,
				document.uri.fsPath,
				lookupAccess.attrName,
				"attribute"
			);
			if (locations.length) {
				return locations;
			}
		}

		const leftExpr = getMemberAccessPrefix(text, ident.start);

		if (leftExpr?.startsWith("this.")) {
			const loc = memberLocation(
				this.index.findThisPathMember(
					document.uri.fsPath,
					leftExpr.slice("this.".length),
					ident.name
				)
			);
			if (loc) {
				return loc;
			}
			this.pushUnique(
				locations,
				this.platformStubLocation(leftExpr, ident.name)
			);
			if (locations.length) {
				return locations;
			}
		}

		if (leftExpr === "this" || leftExpr?.startsWith("this.")) {
			this.pushThisHits(locations, document.uri.fsPath, ident.name);
			if (!locations.length && leftExpr === "this") {
				this.pushUnique(
					locations,
					memberLocation(
						this.index
							.resolveThisMembers(document.uri.fsPath)
							.find((m) => m.name === ident.name)
					)
				);
			}
		} else if (leftExpr && leftExpr !== ident.name) {
			this.pushUnique(
				locations,
				this.platformStubLocation(leftExpr, ident.name)
			);
			if (!locations.length) {
				for (const m of this.resolveModulesFromExpr(
					document.uri.fsPath,
					leftExpr
				)) {
					const member = m.members.find((x) => x.name === ident.name);
					if (member?.position) {
						this.pushUnique(
							locations,
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
		}

		if (!locations.length) {
			const asModules = this.index.getAllByName(
				this.index.resolveLocalAlias(document.uri.fsPath, ident.name) ||
					ident.name
			);
			for (const asModule of asModules) {
				this.pushUnique(
					locations,
					new vscode.Location(
						vscode.Uri.file(asModule.filePath),
						new vscode.Position(0, 0)
					)
				);
			}
		}

		if (!locations.length) {
			const line = document.lineAt(position.line).text;
			const before = line.slice(0, position.character);
			if (/\bthis\.[\w$]*$/.test(before)) {
				this.pushThisHits(locations, document.uri.fsPath, ident.name);
			}
		}

		return locations.length ? locations : undefined;
	}

	private pushThisHits(
		locations: vscode.Location[],
		filePath: string,
		name: string,
		kind?: IndexedMember["kind"]
	): void {
		for (const hit of this.index.findThisMemberLocations(filePath, name, kind)) {
			this.pushUnique(locations, hitLocation(hit));
		}
	}

	private pushUnique(
		locations: vscode.Location[],
		loc: vscode.Location | undefined
	): void {
		if (!loc) {
			return;
		}
		const key = `${loc.uri.fsPath}:${loc.range.start.line}:${loc.range.start.character}`;
		if (
			locations.some(
				(item) =>
					`${item.uri.fsPath}:${item.range.start.line}:${item.range.start.character}` ===
					key
			)
		) {
			return;
		}
		locations.push(loc);
	}

	private platformStubLocation(
		leftExpr: string,
		name: string
	): vscode.Location | undefined {
		const enableStubs = vscode.workspace
			.getConfiguration("bpmsoft")
			.get<boolean>("enablePlatformStubs", true);
		const prefix = rewriteThisRuntimePrefix(leftExpr) || leftExpr;
		if (
			prefix !== "BPMSoft" &&
			!prefix.startsWith("BPMSoft.") &&
			prefix !== "Ext" &&
			!prefix.startsWith("Ext.")
		) {
			return undefined;
		}
		const member = this.index
			.resolveMembers(prefix, enableStubs)
			.find((item) => item.name === name);
		return memberLocation(member);
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
