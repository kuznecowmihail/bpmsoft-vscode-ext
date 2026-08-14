import * as vscode from "vscode";
import { SymbolIndex } from "../index/SymbolIndex";
import { IndexedMember, MemberKind } from "../index/types";
import { getMemberAccessPrefix, getThisGetSetContext, getThisLookupAccessContext } from "../parse/amdParser";

const GLOBAL_IDENTIFIERS = [
	{
		name: "BPMSoft",
		detail: "BPMSoft global",
		documentation: "Глобальный объект платформы BPMSoft / Creatio"
	},
	{
		name: "Ext",
		detail: "Ext JS",
		documentation: "Ext.define / Ext.create"
	},
	{
		name: "define",
		detail: "AMD define",
		documentation: "define(\"ModuleName\", deps, factory)"
	}
];

function kindToCompletion(
	kind: MemberKind
): vscode.CompletionItemKind {
	switch (kind) {
		case "method":
			return vscode.CompletionItemKind.Method;
		case "enum":
			return vscode.CompletionItemKind.Enum;
		case "namespace":
			return vscode.CompletionItemKind.Module;
		case "const":
			return vscode.CompletionItemKind.Constant;
		case "attribute":
			return vscode.CompletionItemKind.Field;
		default:
			return vscode.CompletionItemKind.Property;
	}
}

function toItems(members: IndexedMember[]): vscode.CompletionItem[] {
	return members.map((m, i) => {
		const isAttr = m.kind === "attribute";
		const label = isAttr ? `$${m.name}` : m.name;
		const item = new vscode.CompletionItem(label, kindToCompletion(m.kind));
		item.detail = `BPMSoft · ${m.detail || m.kind}`;
		item.sortText = `!${String(i).padStart(5, "0")}_${m.name}`;
		item.filterText = isAttr ? `$${m.name} ${m.name}` : m.name;
		item.preselect = i === 0;
		if (m.documentation) {
			item.documentation = new vscode.MarkdownString(m.documentation);
		}
		if (m.kind === "method") {
			item.insertText = new vscode.SnippetString(`${m.name}($0)`);
		} else if (isAttr) {
			item.insertText = `$${m.name}`;
		}
		return item;
	});
}

function toGetSetItems(
	members: IndexedMember[],
	ctx: { method: "get" | "set"; quote?: string; nameStart: number; nameEnd: number },
	document: vscode.TextDocument
): vscode.CompletionItem[] {
	return members
		.filter((m) => m.kind === "attribute")
		.map((m, i) => {
			const item = new vscode.CompletionItem(
				m.name,
				vscode.CompletionItemKind.Field
			);
			item.detail = `BPMSoft · attribute`;
			item.sortText = `!${String(i).padStart(5, "0")}_${m.name}`;
			item.filterText = m.name;
			item.preselect = i === 0;
			if (m.documentation) {
				item.documentation = new vscode.MarkdownString(m.documentation);
			}
			if (!ctx.quote) {
				item.insertText =
					ctx.method === "set"
						? new vscode.SnippetString(`"${m.name}", $0`)
						: `"${m.name}"`;
			} else {
				item.insertText = m.name;
				item.range = new vscode.Range(
					document.positionAt(ctx.nameStart),
					document.positionAt(ctx.nameEnd)
				);
			}
			return item;
		});
}

function asList(items: vscode.CompletionItem[]): vscode.CompletionList | undefined {
	if (!items.length) {
		return undefined;
	}
	return new vscode.CompletionList(items, false);
}

function globalIdentifierItems(typed: string): vscode.CompletionItem[] {
	const q = typed.toLowerCase();
	return GLOBAL_IDENTIFIERS.filter((g) =>
		g.name.toLowerCase().startsWith(q)
	).map((g, i) => {
		const item = new vscode.CompletionItem(
			g.name,
			vscode.CompletionItemKind.Variable
		);
		item.detail = `BPMSoft · ${g.detail}`;
		item.documentation = new vscode.MarkdownString(g.documentation);
		item.sortText = `!${String(i).padStart(5, "0")}_${g.name}`;
		item.filterText = g.name;
		item.preselect = i === 0 && g.name === "BPMSoft";
		if (g.name === "BPMSoft") {
			item.insertText = new vscode.SnippetString("BPMSoft");
		}
		return item;
	});
}

export class BpmsoftCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private readonly index: SymbolIndex) {}

	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.CompletionList | undefined {
		const offset = document.offsetAt(position);
		const text = document.getText();
		const enableStubs = vscode.workspace
			.getConfiguration("bpmsoft")
			.get<boolean>("enablePlatformStubs", true);

		const linePrefix = document
			.lineAt(position.line)
			.text.slice(0, position.character);

		const lookupAccess = getThisLookupAccessContext(text, offset);
		if (lookupAccess) {
			const attr = this.index
				.resolveThisMembers(document.uri.fsPath)
				.find(
					(m) =>
						m.name === lookupAccess.attrName && m.kind === "attribute"
				);
			return asList(toItems(attr?.children || []));
		}

		const getSet = getThisGetSetContext(text, offset);
		if (getSet) {
			return asList(
				toGetSetItems(
					this.index.resolveThisMembers(document.uri.fsPath),
					getSet,
					document
				)
			);
		}

		// Member access: BPMSoft. / this. / Module. / this.$
		if (/\.[\w$]*$/.test(linePrefix)) {
			return this.memberCompletions(
				document,
				offset,
				text,
				linePrefix,
				enableStubs
			);
		}

		// Bare identifier: BPM| → BPMSoft
		const idMatch = linePrefix.match(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)$/);
		if (idMatch) {
			return asList(globalIdentifierItems(idMatch[1]));
		}

		return undefined;
	}

	private memberCompletions(
		document: vscode.TextDocument,
		offset: number,
		text: string,
		linePrefix: string,
		enableStubs: boolean
	): vscode.CompletionList | undefined {
		const dotMatch = linePrefix.match(/([A-Za-z_$][\w.$]*)\.[\w$]*$/);
		const rawPrefix =
			dotMatch?.[1] || getMemberAccessPrefix(text, offset);
		if (!rawPrefix) {
			return undefined;
		}

		if (rawPrefix === "this") {
			return asList(
				toItems(this.index.resolveThisMembers(document.uri.fsPath))
			);
		}
		if (rawPrefix.startsWith("this.")) {
			return undefined;
		}

		const parts = rawPrefix.split(".");
		const root = parts[0];
		const resolved =
			this.index.resolveLocalAlias(document.uri.fsPath, root) || root;
		const lookup =
			parts.length === 1
				? resolved
				: [resolved, ...parts.slice(1)].join(".");

		const members = this.index.resolveMembers(lookup, enableStubs);
		if (members.length) {
			return asList(toItems(members));
		}

		return asList(
			toItems(this.index.resolveMembers(rawPrefix, enableStubs))
		);
	}
}
