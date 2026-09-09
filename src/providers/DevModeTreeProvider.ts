import * as vscode from "vscode";
import * as path from "path";
import { getDebuggingEnabled, getFileDesignModeEnabled, resolveWebHostConfigPath } from "../index/devModeSettings";
import { findWorkspaceConsoleDll, getWorkspaceConsoleStatus } from "../index/workspaceConsoleSetup";

export const TOGGLE_FILE_DESIGN_MODE_COMMAND = "bpmsoft.devMode.toggleFileDesignMode";
export const TOGGLE_DEBUGGING_COMMAND = "bpmsoft.devMode.toggleDebugging";
export const CONFIGURE_WORKSPACE_CONSOLE_COMMAND = "bpmsoft.devMode.configureWorkspaceConsole";
export const RUN_WORKSPACE_CONSOLE_OPERATION_COMMAND = "bpmsoft.devMode.runWorkspaceConsoleOperation";

const CONFIGURED_COLOR = new vscode.ThemeColor("charts.green");
const WARNING_COLOR = new vscode.ThemeColor("charts.yellow");

export type DevModeTreeNode =
	| { type: "root"; appRoot: string; label: string }
	| { type: "fileDesignMode"; appRoot: string }
	| { type: "debugging"; appRoot: string }
	| { type: "workspaceConsole"; appRoot: string }
	| { type: "workspaceConsoleRun"; appRoot: string; dllPath: string };

/** Status/action rows for one app root — hidden entirely (not shown
 * "unavailable") when they don't apply: no web-host config found, no
 * WorkspaceConsole `<connectionStrings>` at all, ... (see
 * `devModeSettings.ts`/`workspaceConsoleSetup.ts`). */
function nodesFor(appRoot: string): DevModeTreeNode[] {
	const nodes: DevModeTreeNode[] = [];
	const webHostConfig = resolveWebHostConfigPath(appRoot);
	if (webHostConfig) {
		if (getFileDesignModeEnabled(webHostConfig) !== undefined) {
			nodes.push({ type: "fileDesignMode", appRoot });
		}
		nodes.push({ type: "debugging", appRoot });
	}
	if (getWorkspaceConsoleStatus(appRoot).applicable) {
		nodes.push({ type: "workspaceConsole", appRoot });
	}
	const dllPath = findWorkspaceConsoleDll(appRoot);
	if (dllPath) {
		nodes.push({ type: "workspaceConsoleRun", appRoot, dllPath });
	}
	return nodes;
}

/**
 * A handful of one-click deployment toggles/status checks that live in the
 * same root config files as "Config Files" but aren't themselves a file to
 * browse/edit — kept in their own view so they don't get lost among the
 * (often much longer) list of ConnectionStrings/appSettings/nlog.config
 * entries: File System Design Mode, VS Code debugging, and whether
 * WorkspaceConsole's own connection strings match the app's main
 * ConnectionStrings.config.
 */
export class DevModeTreeProvider implements vscode.TreeDataProvider<DevModeTreeNode> {
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

	getChildren(element?: DevModeTreeNode): DevModeTreeNode[] {
		if (!element) {
			if (this.appRoots.length <= 1) {
				const appRoot = this.appRoots[0];
				return appRoot ? nodesFor(appRoot) : [];
			}
			return this.appRoots.map((appRoot) => ({ type: "root", appRoot, label: path.basename(appRoot) }));
		}
		if (element.type === "root") {
			return nodesFor(element.appRoot);
		}
		return [];
	}

	getTreeItem(node: DevModeTreeNode): vscode.TreeItem {
		if (node.type === "root") {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
			item.iconPath = new vscode.ThemeIcon("folder");
			return item;
		}
		if (node.type === "fileDesignMode") {
			return this.fileDesignModeItem(node.appRoot);
		}
		if (node.type === "debugging") {
			return this.debuggingItem(node.appRoot);
		}
		if (node.type === "workspaceConsoleRun") {
			return this.workspaceConsoleRunItem(node.appRoot, node.dllPath);
		}
		return this.workspaceConsoleItem(node.appRoot);
	}

	private fileDesignModeItem(appRoot: string): vscode.TreeItem {
		const filePath = resolveWebHostConfigPath(appRoot)!;
		const enabled = getFileDesignModeEnabled(filePath) ?? false;
		const item = new vscode.TreeItem("Режим разработки в файловой системе", vscode.TreeItemCollapsibleState.None);
		item.description = enabled ? "Включен" : "Выключен";
		item.iconPath = new vscode.ThemeIcon(enabled ? "check" : "circle-large-outline", enabled ? CONFIGURED_COLOR : undefined);
		item.tooltip = new vscode.MarkdownString(
			"Позволяет редактировать схемы прямо файлами в `Pkg\\` без пересборки через мастер Configuration — " +
				"`<fileDesignMode enabled=\"true\"/>`. Несовместим со статическим клиентским контентом, поэтому " +
				"включение одновременно выключает `UseStaticFileContent` (и наоборот при выключении).\n\n" +
				`\`${filePath}\`\n\nКлик — ${enabled ? "выключить" : "включить"}.`
		);
		item.command = { command: TOGGLE_FILE_DESIGN_MODE_COMMAND, title: "Переключить", arguments: [appRoot] };
		return item;
	}

	private debuggingItem(appRoot: string): vscode.TreeItem {
		const filePath = resolveWebHostConfigPath(appRoot)!;
		const enabled = getDebuggingEnabled(filePath);
		const item = new vscode.TreeItem("Отладка в VS Code", vscode.TreeItemCollapsibleState.None);
		item.description = enabled ? "Включена" : "Выключена";
		item.iconPath = new vscode.ThemeIcon(enabled ? "check" : "circle-large-outline", enabled ? CONFIGURED_COLOR : undefined);
		item.tooltip = new vscode.MarkdownString(
			"`LoadAssemblyFromByteArray` (см. `_enableDebugging.bat`/`_disableDebugging.bat`) — при `true` сборки " +
				"грузятся из массива байт в памяти (не блокируют файл, но отладчик не может сопоставить их с исходным " +
				"кодом); при `false`/отсутствии — обычная загрузка с диска, отладка работает.\n\n" +
				`\`${filePath}\`\n\nКлик — ${enabled ? "выключить" : "включить"}.`
		);
		item.command = { command: TOGGLE_DEBUGGING_COMMAND, title: "Переключить", arguments: [appRoot] };
		return item;
	}

	private workspaceConsoleItem(appRoot: string): vscode.TreeItem {
		const status = getWorkspaceConsoleStatus(appRoot);
		if (status.configured) {
			const item = new vscode.TreeItem("Workspace Console настроена", vscode.TreeItemCollapsibleState.None);
			item.iconPath = new vscode.ThemeIcon("check", CONFIGURED_COLOR);
			item.tooltip = "Строки подключения WorkspaceConsole совпадают с главным ConnectionStrings.config.";
			return item;
		}
		const item = new vscode.TreeItem("Workspace Console не настроена", vscode.TreeItemCollapsibleState.None);
		item.description = `${status.mismatches.length} расхожд.`;
		item.iconPath = new vscode.ThemeIcon("warning", WARNING_COLOR);
		item.tooltip = new vscode.MarkdownString(
			"Строки подключения WorkspaceConsole отличаются от главного `ConnectionStrings.config` " +
				"(WorkspaceConsole никогда не читает этот файл напрямую — у него свой инлайновый `<connectionStrings>`):\n\n" +
				status.mismatches.map((m) => `- **${m.name}** (${m.fileLabel})`).join("\n") +
				"\n\nКлик — настроить автоматически (скопировать значения из ConnectionStrings.config)."
		);
		item.command = { command: CONFIGURE_WORKSPACE_CONSOLE_COMMAND, title: "Настроить автоматически", arguments: [appRoot] };
		return item;
	}

	private workspaceConsoleRunItem(appRoot: string, dllPath: string): vscode.TreeItem {
		const item = new vscode.TreeItem("Операции Workspace Console…", vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon("terminal");
		item.tooltip = new vscode.MarkdownString(
			"Собрать команду `dotnet BPMSoft.Tools.WorkspaceConsole.dll -operation=...` для любой из " +
				"поддерживаемых операций (сборка, установка пакетов, работа с рабочими пространствами, " +
				"лицензии, шифрование и т.д.) и открыть её в терминале — команда только подставляется, " +
				"выполняется вручную по Enter.\n\n" +
				`\`${dllPath}\``
		);
		item.command = { command: RUN_WORKSPACE_CONSOLE_OPERATION_COMMAND, title: "Открыть", arguments: [appRoot, dllPath] };
		return item;
	}
}
