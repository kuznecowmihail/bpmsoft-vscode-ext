import * as vscode from "vscode";

export type PlainOutlineSortMode = "position" | "name" | "category";

interface PlainOutlineNode {
	symbol: vscode.DocumentSymbol;
	parent: PlainOutlineNode | undefined;
	filePath: string;
}

/**
 * Mirrors the standard VS Code Outline — same data (`DocumentSymbol[]` via
 * `vscode.executeDocumentSymbolProvider`, so it works for any language with
 * a registered symbol provider, not just our own JS parsing), same icons,
 * same Sort By/Follow Cursor semantics. Exists only because the *native*
 * Outline view can't be relocated into our own Activity Bar container (a
 * VS Code limitation, not something an extension can work around) — this is
 * a from-scratch equivalent living inside BPMSoft Explorer instead. See
 * `ViewModelOutlineProvider` for the BPMSoft-specific one (grouped by
 * mechanism — attributes/diff/rules/…, not by symbol kind); the two are
 * deliberately separate views for deliberately different content.
 */
export class PlainOutlineProvider implements vscode.TreeDataProvider<PlainOutlineNode> {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;
	private currentFilePath: string | undefined;
	private rootSymbols: vscode.DocumentSymbol[] = [];
	private sortMode: PlainOutlineSortMode = "position";
	/** Same rationale as `ViewModelOutlineProvider.expandedByFile` — VS Code
	 * doesn't remember tree expand state across a full `onDidChangeTreeData`
	 * refresh on its own, so switching files and back would otherwise
	 * re-collapse everything. Keyed by `symbol.name + line` since real
	 * `DocumentSymbol`s (unlike our own `IndexedMember` tree) don't get
	 * rebuilt as fresh objects on every call — but the *node wrappers* still
	 * are, so this still needs a string key rather than object identity. */
	private readonly expandedByFile = new Map<string, Set<string>>();

	setSortMode(mode: PlainOutlineSortMode): void {
		this.sortMode = mode;
		this.changeEmitter.fire();
	}

	async refresh(): Promise<void> {
		const document = vscode.window.activeTextEditor?.document;
		if (!document || document.uri.scheme !== "file") {
			this.currentFilePath = undefined;
			this.rootSymbols = [];
			this.changeEmitter.fire();
			return;
		}
		this.currentFilePath = document.uri.fsPath;
		// `refresh()` is always called fire-and-forget (`void
		// plainOutlineTree.refresh()`) — an uncaught rejection here (no
		// symbol provider registered for this language, a provider that
		// throws, …) would otherwise become an unhandled promise rejection,
		// which some Electron/Node builds escalate to a fatal crash of the
		// whole extension host process rather than just logging it.
		let symbols: vscode.DocumentSymbol[] | undefined;
		try {
			symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
				"vscode.executeDocumentSymbolProvider",
				document.uri
			);
		} catch {
			symbols = undefined;
		}
		// The command can resolve after the user has already switched to a
		// different file (or closed it) — a stale response overwriting
		// `rootSymbols` at that point would render the wrong file's outline.
		if (document.uri.fsPath !== vscode.window.activeTextEditor?.document.uri.fsPath) {
			return;
		}
		this.rootSymbols = symbols || [];
		this.changeEmitter.fire();
	}

	setExpanded(node: PlainOutlineNode, expanded: boolean): void {
		if (!this.currentFilePath) {
			return;
		}
		if (!expanded) {
			this.expandedByFile.get(this.currentFilePath)?.delete(nodeKey(node));
			return;
		}
		let set = this.expandedByFile.get(this.currentFilePath);
		if (!set) {
			set = new Set();
			this.expandedByFile.set(this.currentFilePath, set);
		}
		set.add(nodeKey(node));
	}

	private isExpanded(node: PlainOutlineNode): boolean {
		if (!this.currentFilePath) {
			return false;
		}
		return this.expandedByFile.get(this.currentFilePath)?.has(nodeKey(node)) ?? false;
	}

	getParent(node: PlainOutlineNode): PlainOutlineNode | undefined {
		return node.parent;
	}

	/** Deepest symbol whose `range` contains `position` — for Follow Cursor.
	 * Unlike `ViewModelOutlineProvider`'s approximation, real `DocumentSymbol`
	 * ranges make this an exact containment check. */
	findNodeAtPosition(position: vscode.Position): PlainOutlineNode | undefined {
		const search = (nodes: PlainOutlineNode[]): PlainOutlineNode | undefined => {
			for (const node of nodes) {
				if (node.symbol.range.contains(position)) {
					return search(this.getChildren(node)) ?? node;
				}
			}
			return undefined;
		};
		return search(this.getChildren());
	}

	getChildren(node?: PlainOutlineNode): PlainOutlineNode[] {
		const filePath = this.currentFilePath;
		if (!filePath) {
			return [];
		}
		const symbols = node ? node.symbol.children : this.rootSymbols;
		return sortSymbols(symbols, this.sortMode).map((symbol) => ({ symbol, parent: node, filePath }));
	}

	getTreeItem(node: PlainOutlineNode): vscode.TreeItem {
		const { symbol } = node;
		const collapsible = !symbol.children.length
			? vscode.TreeItemCollapsibleState.None
			: this.isExpanded(node)
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.Collapsed;
		const item = new vscode.TreeItem(symbol.name, collapsible);
		item.description = symbol.detail || undefined;
		item.iconPath = symbolKindIcon(symbol.kind);
		item.command = {
			command: "vscode.open",
			title: "Открыть",
			arguments: [vscode.Uri.file(node.filePath), { selection: symbol.selectionRange }]
		};
		return item;
	}
}

function nodeKey(node: PlainOutlineNode): string {
	return `${node.symbol.name}/${node.symbol.range.start.line}`;
}

function sortSymbols(symbols: vscode.DocumentSymbol[], mode: PlainOutlineSortMode): vscode.DocumentSymbol[] {
	if (mode === "position") {
		// `vscode.executeDocumentSymbolProvider` already returns children in
		// source order; avoid an unnecessary copy/sort in the default case.
		return symbols;
	}
	const sorted = [...symbols];
	if (mode === "name") {
		sorted.sort((a, b) => a.name.localeCompare(b.name));
	} else {
		// "Category": groups same-kind symbols together, same as the native
		// Outline — `SymbolKind`'s own declaration order is a reasonable
		// stand-in for its fixed category ordering.
		sorted.sort((a, b) => a.kind - b.kind || a.name.localeCompare(b.name));
	}
	return sorted;
}

/** VS Code's own codicon set has one `symbol-<kebab-case>` icon per
 * `SymbolKind` (`symbol-method`, `symbol-enum-member`, …) — the exact set
 * the native Outline itself uses — so this converts the enum's own PascalCase
 * name (`vscode.SymbolKind[kind]`) instead of hand-maintaining a 26-entry
 * table that could silently drift from a real codicon id. */
function symbolKindIcon(kind: vscode.SymbolKind): vscode.ThemeIcon {
	const name = vscode.SymbolKind[kind] as string | undefined;
	const kebab = (name || "misc").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
	return new vscode.ThemeIcon(`symbol-${kebab}`);
}
