import * as vscode from "vscode";
import * as path from "path";
import { AppConfigEntry, AppConfigEntryKind, discoverAppConfigEntries } from "../index/appConfigDiscovery";
import { discoverNlogConfigEntries } from "../index/nlogConfigDiscovery";
import { getDebuggingEnabled, getFileDesignModeEnabled, resolveWebHostConfigPath } from "../index/devModeSettings";
import { getWorkspaceConsoleStatus } from "../index/workspaceConsoleSetup";

export const EDIT_CONFIG_ENTRY_COMMAND = "bpmsoft.envConfig.edit";
export const TOGGLE_FILE_DESIGN_MODE_COMMAND = "bpmsoft.envConfig.toggleFileDesignMode";
export const TOGGLE_DEBUGGING_COMMAND = "bpmsoft.envConfig.toggleDebugging";
export const CONFIGURE_WORKSPACE_CONSOLE_COMMAND = "bpmsoft.envConfig.configureWorkspaceConsole";

const CONFIGURED_COLOR = new vscode.ThemeColor("charts.green");
const WARNING_COLOR = new vscode.ThemeColor("charts.yellow");

export type ConfigTreeNode =
	| { type: "root"; appRoot: string; label: string }
	| { type: "fileDesignMode"; appRoot: string }
	| { type: "debugging"; appRoot: string }
	| { type: "workspaceConsole"; appRoot: string }
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

/** One-line "what is this and why would I open it" per entry kind — shown in
 * the tree item's hover tooltip so a section is identifiable before opening
 * its wizard, not just by its (sometimes terse) label. */
function descriptionForKind(kind: AppConfigEntryKind): string {
	switch (kind) {
		case "connectionStringsFile":
			return "Строки подключения (БД, Redis, S3 и т.п.) — отдельный файл, на который ссылается BPMSoft.WebHost.dll.config.";
		case "xmlConnectionStrings":
			return "Строки подключения, заданные прямо внутри этого .dll.config (не через отдельный ConnectionStrings.config) — например у WorkspaceConsole свои, отличные от основного приложения.";
		case "appSettingsJson":
			return "Настройки ASP.NET Core (Kestrel-эндпоинты и сертификат, логирование, DataProtection и т.д.).";
		case "xmlAppSettings":
			return "Плоский список настроек приложения ключ → значение (флаги, тайм-ауты, лимиты) из <appSettings> этого .dll.config.";
		case "nlogVariables":
			return "Именованные переменные NLog (${ИмяПеременной}) — обычно здесь собирают общий формат строки лога из отдельных функций.";
		case "nlogExtensions":
			return "Сборки, из которых NLog подгружает типы таргетов, которых нет в его ядре (Kafka, ElasticSearch, Syslog, Loki и т.п.).";
		case "nlogTargets":
			return "Куда пишутся логи — файлы, консоль, БД, почта и т.д. Включая закомментированные вендором примеры.";
		case "nlogRules":
			return "Какой логгер в какой таргет и с каким уровнем пишет — проверяются по порядку сверху вниз.";
	}
}

function discoverAll(appRoot: string): AppConfigEntry[] {
	return [...discoverAppConfigEntries(appRoot), ...discoverNlogConfigEntries(appRoot)];
}

/** Synthetic status/action rows shown above the discovered config files for
 * one app root — computed fresh on every render so a toggle's effect (or a
 * file changed on disk) shows up immediately after `refresh()`. Each is
 * hidden entirely rather than shown "unavailable" when it doesn't apply
 * (no web-host config found, no WorkspaceConsole `<connectionStrings>` at
 * all, ...) — see `devModeSettings.ts`/`workspaceConsoleSetup.ts`. */
function statusNodesFor(appRoot: string): ConfigTreeNode[] {
	const nodes: ConfigTreeNode[] = [];
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
	return nodes;
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
				if (!appRoot) {
					return [];
				}
				return [...statusNodesFor(appRoot), ...discoverAll(appRoot).map((entry) => ({ type: "entry" as const, entry }))];
			}
			return this.appRoots.map((appRoot) => ({ type: "root", appRoot, label: path.basename(appRoot) }));
		}
		if (element.type === "root") {
			return [
				...statusNodesFor(element.appRoot),
				...discoverAll(element.appRoot).map((entry) => ({ type: "entry" as const, entry }))
			];
		}
		return [];
	}

	getTreeItem(node: ConfigTreeNode): vscode.TreeItem {
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
		if (node.type === "workspaceConsole") {
			return this.workspaceConsoleItem(node.appRoot);
		}
		const item = new vscode.TreeItem(node.entry.label, vscode.TreeItemCollapsibleState.None);
		item.tooltip = new vscode.MarkdownString(`${descriptionForKind(node.entry.kind)}\n\n\`${node.entry.filePath}\``);
		item.iconPath = new vscode.ThemeIcon(iconForKind(node.entry.kind));
		item.command = {
			command: EDIT_CONFIG_ENTRY_COMMAND,
			title: "Редактировать",
			arguments: [node.entry]
		};
		return item;
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
}
