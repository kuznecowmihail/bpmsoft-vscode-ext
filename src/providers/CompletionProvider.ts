import * as vscode from "vscode";
import { SymbolIndex } from "../index/SymbolIndex";
import { IndexedMember, MemberKind, IndexedSchemaMessage, schemaMessageDirectionLabel } from "../parse/types";
import { getMemberAccessPrefix, getThisGetSetContext, getThisLookupAccessContext, getThisSandboxMessageContext, getDiffBindToContext, getOverrideInsertContext, formatOverrideSnippet, collectLocalMethodKeys, rewriteThisRuntimePrefix } from "../parse/amdParser";
import { getRootSchemaNameContext, getQueryColumnContext, resolveQueryEntities, resolveQueryClassNames, getConstructorConfigContext, EsqNameSpan } from "../parse/esqQuery";
import { enablePlatformStubs } from "../config";
import {
	EsqBracketContext,
	getEsqBracketContext,
	toEntityNameItems,
	toEsqBracketItems,
	toEsqColumnItems,
	toConstructorConfigItems,
	TRIGGER_SUGGEST
} from "./esqCompletion";

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

function toItems(
	members: IndexedMember[],
	opts?: { thisPath?: string }
): vscode.CompletionItem[] {
	const thisPath = opts?.thisPath;
	return members.map((m, i) => {
		const isAttr = m.kind === "attribute";
		const label = isAttr ? `$${m.name}` : m.name;
		const item = new vscode.CompletionItem(label, kindToCompletion(m.kind));
		item.detail = `BPMSoft · ${m.detail || m.kind}`;
		item.sortText = `!${String(i).padStart(5, "0")}_${m.name}`;
		item.filterText = isAttr
			? `$${m.name} ${m.name}`
			: m.name.startsWith("_") && m.name.length > 1
				? `${m.name} ${m.name.slice(1)}`
				: m.name;
		item.preselect = i === 0;
		if (m.documentation) {
			item.documentation = new vscode.MarkdownString(m.documentation);
		}
		if (thisPath === "" && m.name === "sandbox") {
			item.insertText = new vscode.SnippetString("sandbox.");
			item.command = TRIGGER_SUGGEST;
		} else if (
			thisPath === "sandbox" &&
			(m.name === "publish" || m.name === "subscribe")
		) {
			item.insertText = new vscode.SnippetString(`${m.name}($0)`);
			item.command = TRIGGER_SUGGEST;
		} else if (m.kind === "method") {
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

function toSandboxMessageItems(
	messages: IndexedSchemaMessage[],
	ctx: { quote?: string; name: string; nameStart: number; nameEnd: number },
	document: vscode.TextDocument
): vscode.CompletionItem[] {
	const typed = ctx.name.toLowerCase();
	const range = new vscode.Range(
		document.positionAt(ctx.nameStart),
		document.positionAt(ctx.nameEnd)
	);
	return messages
		.filter(
			(msg) => !typed || msg.name.toLowerCase().startsWith(typed)
		)
		.map((msg, i) => {
			const item = new vscode.CompletionItem(
				msg.name,
				vscode.CompletionItemKind.Event
			);
			item.detail = `BPMSoft · ${schemaMessageDirectionLabel(msg.direction)}`;
			item.sortText = `!${String(i).padStart(5, "0")}_${msg.name}`;
			item.filterText = msg.name;
			item.preselect = i === 0;
			item.insertText = ctx.quote ? msg.name : `"${msg.name}"`;
			item.range = range;
			if (msg.documentation) {
				item.documentation = new vscode.MarkdownString(msg.documentation);
			}
			return item;
		});
}

function toBindToItems(
	members: IndexedMember[],
	ctx: { quote?: string; name: string; nameStart: number; nameEnd: number },
	document: vscode.TextDocument
): vscode.CompletionItem[] {
	const typed = ctx.name.toLowerCase();
	const range = new vscode.Range(
		document.positionAt(ctx.nameStart),
		document.positionAt(ctx.nameEnd)
	);
	return members
		.filter(
			(m) =>
				(m.kind === "method" || m.kind === "attribute") &&
				(!typed || m.name.toLowerCase().startsWith(typed))
		)
		.map((m, i) => {
			const item = new vscode.CompletionItem(
				m.name,
				m.kind === "method"
					? vscode.CompletionItemKind.Method
					: vscode.CompletionItemKind.Field
			);
			item.detail = `BPMSoft · ${m.kind === "method" ? "method" : "attribute"}`;
			item.sortText = `!${m.kind === "method" ? "m" : "a"}${String(i).padStart(5, "0")}_${m.name}`;
			item.filterText = m.name;
			item.preselect = i === 0;
			item.insertText = ctx.quote ? m.name : `"${m.name}"`;
			item.range = range;
			if (m.documentation) {
				item.documentation = new vscode.MarkdownString(m.documentation);
			}
			return item;
		});
}

function completionKey(item: vscode.CompletionItem): string {
	const label = typeof item.label === "string" ? item.label : item.label.label;
	return `${item.kind}:${label}:${item.detail ?? ""}`;
}

function uniqueItems(items: vscode.CompletionItem[]): vscode.CompletionItem[] {
	const seen = new Set<string>();
	const out: vscode.CompletionItem[] = [];
	for (const item of items) {
		const key = completionKey(item);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push(item);
	}
	return out;
}

function asList(
	items: vscode.CompletionItem[],
	incomplete = false
): vscode.CompletionList | undefined {
	const unique = uniqueItems(items);
	if (!unique.length) {
		return undefined;
	}
	return new vscode.CompletionList(unique, incomplete);
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

export class CompletionProvider implements vscode.CompletionItemProvider {
	constructor(private readonly index: SymbolIndex) {}

	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.CompletionList | undefined {
		const offset = document.offsetAt(position);
		const text = document.getText();

		const rootCtx = getRootSchemaNameContext(text, offset);
		if (rootCtx) {
			return asList(
				toEntityNameItems(
					this.index.listEntityNames(rootCtx.name),
					rootCtx,
					document
				),
				true
			);
		}

		const colCtx = getQueryColumnContext(text, offset);
		if (colCtx) {
			const entities = resolveQueryEntities(text, offset, colCtx.queryIdent);
			if (entities.length) {
				const bracketCtx = getEsqBracketContext(colCtx.name);
				if (bracketCtx) {
					return asList(
						this.esqBracketItems(bracketCtx, entities, colCtx, document),
						true
					);
				}

				const endsDot = colCtx.name.endsWith(".");
				const parts = colCtx.name.split(".");
				const parentPath = endsDot
					? parts.filter(Boolean)
					: parts.slice(0, -1).filter(Boolean);
				const prefix = endsDot ? "" : parts[parts.length - 1] || "";
				let members: IndexedMember[];
				if (!parentPath.length) {
					const byName = new Map<string, IndexedMember>();
					for (const e of entities) {
						for (const m of this.index.resolveEntityColumns(e)) {
							byName.set(m.name, m);
						}
					}
					members = [...byName.values()];
				} else {
					const next = this.index.resolveEsqPathSchema(entities, parentPath.join("."));
					members = next ? this.index.resolveEntityColumns(next) : [];
				}
				const filtered = prefix
					? members.filter((m) =>
							m.name.toLowerCase().startsWith(prefix.toLowerCase())
						)
					: members;
				return asList(
					toEsqColumnItems(filtered, colCtx, parentPath, document),
					true
				);
			}
		}

		const ctorConfigCtx = getConstructorConfigContext(text, offset);
		if (ctorConfigCtx) {
			const members = this.index.resolveQueryInstanceMembers([ctorConfigCtx.className]);
			const list = asList(
				toConstructorConfigItems(members, ctorConfigCtx, document),
				true
			);
			if (list) {
				return list;
			}
		}

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

		const sandboxMsg = getThisSandboxMessageContext(text, offset);
		if (sandboxMsg) {
			return asList(
				toSandboxMessageItems(
					this.index.resolveSandboxMessages(
						document.uri.fsPath,
						sandboxMsg.method
					),
					sandboxMsg,
					document
				),
				true
			);
		}

		const bindTo = getDiffBindToContext(text, offset);
		if (bindTo) {
			return asList(
				toBindToItems(
					this.index.resolveThisMembers(document.uri.fsPath),
					bindTo,
					document
				),
				true
			);
		}

		const linePrefix = document
			.lineAt(position.line)
			.text.slice(0, position.character);
		if (/\.[\w$]*$/.test(linePrefix)) {
			return this.memberCompletions(document, offset, text, linePrefix);
		}

		const overrideCtx = getOverrideInsertContext(text, offset);
		if (overrideCtx) {
			return asList(
				this.overrideCompletions(document, overrideCtx)
			);
		}

		// Bare identifier: BPM| → BPMSoft
		const idMatch = linePrefix.match(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)$/);
		if (idMatch) {
			return asList(globalIdentifierItems(idMatch[1]));
		}

		return undefined;
	}

	/** The schema this bracket hops *from* - `parentSegments` resolved
	 * (whatever schema an earlier part of the same path already landed on)
	 * when non-empty, else the root query entity/entities. Needed by every
	 * stage of `SymbolIndex.resolveEsqBracketCandidates`: it's the "must
	 * actually link back to here" filter target for `schema`/
	 * `schemaLinkColumn`, and the candidate source itself for
	 * `currentLinkColumn`. */
	private currentSchemaCandidates(bracket: EsqBracketContext, entities: string[]): string[] {
		if (!bracket.parentSegments.length) {
			return entities;
		}
		const resolved = this.index.resolveEsqPathSchema(entities, bracket.parentSegments.join("."));
		return resolved ? [resolved] : [];
	}

	private esqBracketItems(
		bracket: EsqBracketContext,
		entities: string[],
		colCtx: EsqNameSpan,
		document: vscode.TextDocument
	): vscode.CompletionItem[] {
		const result = this.index.resolveEsqBracketCandidates(
			bracket,
			this.currentSchemaCandidates(bracket, entities)
		);
		if (result.kind === "schema") {
			const candidates = result.names.map((name) => {
				const caption = this.index.resolveEntityCaption(name);
				return {
					name,
					kind: vscode.CompletionItemKind.Class,
					detail: "BPMSoft · entity (reverse join)",
					documentation: caption ? `*${caption}*` : undefined
				};
			});
			return toEsqBracketItems(bracket, candidates, colCtx, document);
		}
		const candidates = result.members.map((m) => ({
			name: m.name,
			kind: vscode.CompletionItemKind.Field,
			detail: m.detail || "entity column",
			documentation: m.caption
				? `*${m.caption}*${m.documentation ? `\n\n${m.documentation}` : ""}`
				: m.documentation
		}));
		return toEsqBracketItems(bracket, candidates, colCtx, document);
	}

	private memberCompletions(
		document: vscode.TextDocument,
		offset: number,
		text: string,
		linePrefix: string
	): vscode.CompletionList | undefined {
		const dotMatch = linePrefix.match(/([A-Za-z_$][\w.$]*)\.[\w$]*$/);
		const rawPrefix =
			dotMatch?.[1] || getMemberAccessPrefix(text, offset);
		if (!rawPrefix) {
			return undefined;
		}

		if (rawPrefix === "this") {
			return asList(
				toItems(this.index.resolveThisMembers(document.uri.fsPath), {
					thisPath: ""
				})
			);
		}

		const enableStubs = enablePlatformStubs();
		const runtimePrefix = rewriteThisRuntimePrefix(rawPrefix);
		if (runtimePrefix) {
			return asList(
				toItems(this.index.resolveMembers(runtimePrefix, enableStubs))
			);
		}

		if (rawPrefix.startsWith("this.")) {
			const thisPath = rawPrefix.slice("this.".length);
			return asList(
				toItems(
					this.index.resolveThisPathMembers(
						document.uri.fsPath,
						thisPath
					),
					{ thisPath }
				)
			);
		}

		if (!rawPrefix.includes(".")) {
			const classNames = resolveQueryClassNames(text, offset, rawPrefix);
			if (classNames.length) {
				const members = this.index.resolveQueryInstanceMembers(classNames);
				if (members.length) {
					return asList(toItems(members));
				}
			}
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

	private overrideCompletions(
		document: vscode.TextDocument,
		ctx: { typed: string; identStart: number; identEnd: number }
	): vscode.CompletionItem[] {
		const typed = ctx.typed.toLowerCase();
		const localKeys = collectLocalMethodKeys(
			document.getText(),
			ctx.identStart,
			ctx.identEnd
		);
		const methods = this.index
			.resolveOverridableMethods(document.uri.fsPath)
			.filter((m) => !localKeys.has(m.name));
		const range = new vscode.Range(
			document.positionAt(ctx.identStart),
			document.positionAt(ctx.identEnd)
		);
		return methods
			.filter((m) => !typed || m.name.toLowerCase().startsWith(typed))
			.map((m, i) => {
				const item = new vscode.CompletionItem(
					m.name,
					vscode.CompletionItemKind.Snippet
				);
				item.detail = `override · ${m.owner}`;
				item.sortText = `!ov${String(i).padStart(5, "0")}_${m.name}`;
				item.filterText = m.name;
				item.preselect = i === 0;
				item.insertText = new vscode.SnippetString(
					formatOverrideSnippet(m.owner, m.name, m.params)
				);
				item.range = range;
				const doc = [
					`@inheritdoc ${m.owner}#${m.name}`,
					"@override",
					...(m.documentation ? ["", m.documentation] : [])
				].join("\n");
				item.documentation = new vscode.MarkdownString(doc);
				return item;
			});
	}
}
