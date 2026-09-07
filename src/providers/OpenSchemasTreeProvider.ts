import * as vscode from "vscode";
import * as path from "path";
import { resolvePackageItem, PackageItemRef } from "../index/schemaResourceLookup";
import { topFolderIcon } from "./packageIcons";

type OpenSchemasNode =
	| { kind: "item"; ref: PackageItemRef; files: string[] }
	| { kind: "file"; path: string; label: string };

/**
 * "Open Editors", but grouped by package item — one BPMSoft schema is
 * normally 5 files (descriptor.json, .js, .less, metadata.json,
 * properties.json; see README "Откуда берётся this."), so a flat file list
 * scatters them. Covers any package item (Schemas/SqlScripts/Data/Resources),
 * not just Schemas — anything else open just doesn't show up here (Explorer's
 * Open Editors still covers those).
 *
 * Grouping key is `package + itemType + itemName`, not just the item name —
 * two different packages can both ship a same-named schema (e.g. a stock
 * `BasePageV2` and a package's own override), and those must NOT merge into
 * one group.
 */
export class OpenSchemasTreeProvider implements vscode.TreeDataProvider<OpenSchemasNode> {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	refresh(): void {
		this.changeEmitter.fire();
	}

	getChildren(node?: OpenSchemasNode): OpenSchemasNode[] {
		if (!node) {
			return this.getItemGroups();
		}
		if (node.kind === "item") {
			return node.files.map(
				(filePath) =>
					({ kind: "file", path: filePath, label: path.basename(filePath) }) as OpenSchemasNode
			);
		}
		return [];
	}

	getTreeItem(node: OpenSchemasNode): vscode.TreeItem {
		if (node.kind === "item") {
			const item = new vscode.TreeItem(node.ref.itemName, vscode.TreeItemCollapsibleState.Expanded);
			item.iconPath = topFolderIcon(node.ref.itemType);
			item.description = `${node.ref.packageName} · ${node.files.length}`;
			return item;
		}
		const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
		item.resourceUri = vscode.Uri.file(node.path);
		item.command = { command: "vscode.open", title: "Открыть", arguments: [item.resourceUri] };
		return item;
	}

	private getItemGroups(): OpenSchemasNode[] {
		const byKey = new Map<string, { ref: PackageItemRef; files: Set<string> }>();
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (!(tab.input instanceof vscode.TabInputText)) {
					continue;
				}
				const fsPath = tab.input.uri.fsPath;
				const ref = resolvePackageItem(fsPath);
				if (!ref) {
					continue;
				}
				const key = `${ref.packageName}::${ref.itemType}::${ref.itemName}`;
				const entry = byKey.get(key) || { ref, files: new Set<string>() };
				entry.files.add(fsPath);
				byKey.set(key, entry);
			}
		}
		return [...byKey.values()]
			.sort((a, b) => a.ref.itemName.localeCompare(b.ref.itemName))
			.map(
				({ ref, files }) =>
					({ kind: "item", ref, files: [...files].sort() }) as OpenSchemasNode
			);
	}
}
