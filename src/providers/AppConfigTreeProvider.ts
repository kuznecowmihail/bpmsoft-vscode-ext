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
		item.tooltip = new vscode.MarkdownString(`${descriptionForKind(node.entry.kind)}\n\n\`${node.entry.filePath}\``);
		item.iconPath = new vscode.ThemeIcon(iconForKind(node.entry.kind));
		item.command = {
			command: EDIT_CONFIG_ENTRY_COMMAND,
			title: "Редактировать",
			arguments: [node.entry]
		};
		return item;
	}
}
