import * as vscode from "vscode";
import { SymbolIndex } from "../index/SymbolIndex";
import { IndexedMember } from "../index/types";
import { getIdentifierAt, getMemberAccessPrefix, getThisGetSetContext, getThisLookupAccessContext, getThisSandboxMessageContext, getDiffBindToContext, getCallParentContext, rewriteThisRuntimePrefix } from "../parse/amdParser";
import { enablePlatformStubs, isPlatformPrefix, modulesFromExpr } from "./platformLookup";

function filePosLocation(
	filePath: string,
	position: { line: number; character: number }
): vscode.Location {
	return new vscode.Location(
		vscode.Uri.file(filePath),
		new vscode.Position(position.line, position.character)
	);
}

function memberLocation(member: IndexedMember | undefined): vscode.Location | undefined {
	if (!member?.filePath || !member.position) {
		return undefined;
	}
	return filePosLocation(member.filePath, member.position);
}

function hitLocation(hit: {
	module: { filePath: string };
	member: IndexedMember;
} | undefined): vscode.Location | undefined {
	if (!hit?.member.position) {
		return undefined;
	}
	return filePosLocation(hit.module.filePath, hit.member.position);
}

function locationKey(loc: vscode.Location): string {
	return `${loc.uri.fsPath}:${loc.range.start.line}:${loc.range.start.character}`;
}

function sameFile(a: string, b: string): boolean {
	return a.replace(/\\/g, "/") === b.replace(/\\/g, "/");
}

/** Schema `methods: {}` — JS already maps this.foo. Ext.define class config does not. */
function skipLocalMethod(
	kind: IndexedMember["kind"],
	filePath: string | undefined,
	current: string,
	schemaKind: string | undefined
): boolean {
	return (
		schemaKind === "page" &&
		kind === "method" &&
		!!filePath &&
		sameFile(filePath, current)
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
		const seen = new Set<string>();
		const pushUnique = (loc: vscode.Location | undefined) => {
			if (!loc) {
				return;
			}
			const key = locationKey(loc);
			if (seen.has(key)) {
				return;
			}
			seen.add(key);
			locations.push(loc);
		};
		const pushThisHits = (name: string, kind?: IndexedMember["kind"]) => {
			for (const hit of this.index.findThisMemberLocations(
				document.uri.fsPath,
				name,
				kind
			)) {
				pushUnique(hitLocation(hit));
			}
		};

		const getSet = getThisGetSetContext(text, offset);
		if (getSet?.name) {
			pushThisHits(getSet.name, "attribute");
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
				pushUnique(filePosLocation(hit.filePath, hit.position));
			}
			if (locations.length) {
				return locations;
			}
		}

		const bindTo = getDiffBindToContext(text, offset);
		if (bindTo?.name) {
			pushThisHits(bindTo.name, "method");
			pushThisHits(bindTo.name, "attribute");
			if (locations.length) {
				return locations;
			}
		}

		const ident = getIdentifierAt(text, offset);
		if (!ident) {
			return undefined;
		}

		if (ident.name === "callParent") {
			const callParent = getCallParentContext(text, offset);
			if (callParent) {
				const loc = hitLocation(
					this.index.findNearestParentMethod(
						document.uri.fsPath,
						callParent.methodName
					)
				);
				if (loc) {
					return loc;
				}
			}
		}
		const lookupAccess = getThisLookupAccessContext(text, offset);
		if (
			lookupAccess &&
			(ident.name === "value" || ident.name === "displayValue")
		) {
			pushThisHits(lookupAccess.attrName, "attribute");
			if (locations.length) {
				return locations;
			}
		}

		const leftExpr = getMemberAccessPrefix(text, ident.start);
		let handledThisMember = false;

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
			pushUnique(this.platformStubLocation(leftExpr, ident.name));
			if (locations.length) {
				return locations;
			}
		}

		if (leftExpr === "this" || leftExpr?.startsWith("this.")) {
			handledThisMember = true;
			const current = document.uri.fsPath;
			const schemaKind = this.index.ensureModule(current)?.kind;
			for (const hit of this.index.findThisMemberLocations(
				current,
				ident.name
			)) {
				if (
					skipLocalMethod(
						hit.member.kind,
						hit.module.filePath,
						current,
						schemaKind
					)
				) {
					continue;
				}
				pushUnique(hitLocation(hit));
			}
			if (!locations.length && leftExpr === "this") {
				const member = this.index
					.resolveThisMembers(current)
					.find((item) => item.name === ident.name);
				if (
					member &&
					!skipLocalMethod(
						member.kind,
						member.filePath,
						current,
						schemaKind
					)
				) {
					pushUnique(memberLocation(member));
				}
			}
		} else if (leftExpr && leftExpr !== ident.name) {
			pushUnique(this.platformStubLocation(leftExpr, ident.name));
			if (!locations.length) {
				for (const m of modulesFromExpr(
					this.index,
					document.uri.fsPath,
					leftExpr
				)) {
					const member = m.members.find((x) => x.name === ident.name);
					if (member?.position) {
						pushUnique(filePosLocation(m.filePath, member.position));
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
				pushUnique(filePosLocation(asModule.filePath, { line: 0, character: 0 }));
			}
		}

		if (!locations.length && !handledThisMember) {
			const line = document.lineAt(position.line).text;
			const before = line.slice(0, position.character);
			if (/\bthis\.[\w$]*$/.test(before)) {
				pushThisHits(ident.name);
			}
		}

		return locations.length ? locations : undefined;
	}

	private platformStubLocation(
		leftExpr: string,
		name: string
	): vscode.Location | undefined {
		const prefix = rewriteThisRuntimePrefix(leftExpr) || leftExpr;
		if (!isPlatformPrefix(prefix)) {
			return undefined;
		}
		const member = this.index
			.resolveMembers(prefix, enablePlatformStubs())
			.find((item) => item.name === name);
		return memberLocation(member);
	}
}
