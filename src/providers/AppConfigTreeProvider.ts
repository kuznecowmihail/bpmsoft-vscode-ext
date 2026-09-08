import * as vscode from "vscode";
import * as path from "path";
import { AppConfigEntry, AppConfigEntryKind, discoverAppConfigEntries } from "../index/appConfigDiscovery";
import { discoverNlogConfigEntries } from "../index/nlogConfigDiscovery";

export const EDIT_CONFIG_ENTRY_COMMAND = "bpmsoft.envConfig.edit";

export type ConfigTreeNode =
	| { type: "root"; appRoot: string; label: string }
	| { type: "entry"; entry: AppConfigEntry };

function iconForKind(kind: AppConfigEntryKind): string {
	switch (kind) {
		case "connectionStringsFile":
		case "xmlConnectionStrings":
			return "plug";
		case "appSettingsJson":
			return "json";
		case "xmlAppSettings":
			return "settings-gear";
		case "nlogVariables":
			return "symbol-variable";
		case "nlogExtensions":
			return "extensions";
		case "nlogTargets":
			return "output";
		case "nlogRules":
			return "list-ordered";
	}
}

function discoverAll(appRoot: string): AppConfigEntry[] {
	return [...discoverAppConfigEntries(appRoot), ...discoverNlogConfigEntries(appRoot)];
}

/**
 * Lists the deployment config files `appConfigDiscovery.ts` finds under each
 * open BPMSoft app root — `ConnectionStrings.config`, `appsettings.json`,
 * `BPMSoft.WebHost.dll.config`'s `appSettings`, `WorkspaceConsole\*.dll.config`'s
 * own `connectionStrings`/`appSettings`, ... — one flat list per root, grouped
 * under a root node only when more than one app root is open at once.
 */
export class AppConfigTreeProvider implements vscode.TreeDataProvider<ConfigTreeNode> {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	constructor(private appRoots: string[]) {}

	setAppRoots(appRoots: string[]): void {
		this.appRoots = appRoots;
		this.refresh();
	}

	refresh(): void {
		this.changeEmitter.fire();
	}

	getChildren(element?: ConfigTreeNode): ConfigTreeNode[] {
		if (!element) {
			if (this.appRoots.length <= 1) {
				const appRoot = this.appRoots[0];
				return appRoot ? discoverAll(appRoot).map((entry) => ({ type: "entry", entry })) : [];
			}
			return this.appRoots.map((appRoot) => ({ type: "root", appRoot, label: path.basename(appRoot) }));
		}
		if (element.type === "root") {
			return discoverAll(element.appRoot).map((entry) => ({ type: "entry", entry }));
		}
		return [];
	}

	getTreeItem(node: ConfigTreeNode): vscode.TreeItem {
		if (node.type === "root") {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
			item.iconPath = new vscode.ThemeIcon("folder");
			return item;
		}
		const item = new vscode.TreeItem(node.entry.label, vscode.TreeItemCollapsibleState.None);
		item.tooltip = node.entry.filePath;
		item.iconPath = new vscode.ThemeIcon(iconForKind(node.entry.kind));
		item.command = {
			command: EDIT_CONFIG_ENTRY_COMMAND,
			title: "Редактировать",
			arguments: [node.entry]
		};
		return item;
	}
}
