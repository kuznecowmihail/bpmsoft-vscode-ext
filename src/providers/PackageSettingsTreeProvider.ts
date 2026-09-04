import * as vscode from "vscode";
import { currentPackage, expectedMaintainers, namingPrefixes } from "../config";

export const EDIT_PACKAGE_SETTING_COMMAND = "bpmsoft.packageSettings.edit";

const CONFIGURED_COLOR = new vscode.ThemeColor("charts.green");

interface PackageSettingField {
	/** Also the `bpmsoft.<key>` configuration key — kept 1:1 so there's no
	 * separate lookup table to keep in sync. */
	key: "currentPackage" | "namingPrefixes" | "expectedMaintainers";
	label: string;
	prompt: string;
	placeholder: string;
	getValue: () => string;
}

/**
 * Stand-ins for the three BPMSoft system settings the naming guideline's
 * "Пакеты" section asks a dev to set up before starting work (`CurrentPackageId`
 * / `SchemaNamePrefix` / `Maintainer`) — this extension has no DB connection
 * to read or write those directly, so these are manually entered here
 * instead and used by `PackageOwnershipStatusBar`'s checks (prefix and
 * maintainer; `currentPackage` is reference-only, see
 * `packageOwnershipCheck.ts` for why).
 */
const FIELDS: PackageSettingField[] = [
	{
		key: "currentPackage",
		label: "Текущий пакет",
		prompt: "Имя пакета — аналог системной настройки «Текущий пакет» (CurrentPackageId)",
		placeholder: "например GoTracker",
		getValue: currentPackage
	},
	{
		key: "namingPrefixes",
		label: "Префикс пакетов/схем",
		prompt: "Префикс(ы) через запятую — аналог «Префикс названия объекта» (SchemaNamePrefix)",
		placeholder: "например Go или Nau,Go",
		getValue: () => namingPrefixes().join(", ")
	},
	{
		key: "expectedMaintainers",
		label: "Издатель",
		prompt: "Издатель(и) через запятую — аналог системной настройки «Издатель» (Maintainer)",
		placeholder: "например YandexGo",
		getValue: () => expectedMaintainers().join(", ")
	}
];

export class PackageSettingsTreeProvider implements vscode.TreeDataProvider<PackageSettingField> {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	refresh(): void {
		this.changeEmitter.fire();
	}

	getChildren(): PackageSettingField[] {
		return FIELDS;
	}

	getTreeItem(field: PackageSettingField): vscode.TreeItem {
		const value = field.getValue();
		const item = new vscode.TreeItem(field.label, vscode.TreeItemCollapsibleState.None);
		item.description = value || "не задано";
		item.tooltip = field.prompt;
		item.iconPath = new vscode.ThemeIcon(value ? "check" : "circle-large-outline", value ? CONFIGURED_COLOR : undefined);
		item.command = {
			command: EDIT_PACKAGE_SETTING_COMMAND,
			title: "Изменить",
			arguments: [field]
		};
		return item;
	}
}

export async function editPackageSetting(field: PackageSettingField): Promise<boolean> {
	const input = await vscode.window.showInputBox({
		title: field.label,
		prompt: field.prompt,
		placeHolder: field.placeholder,
		value: field.getValue()
	});
	if (input === undefined) {
		return false;
	}
	await vscode.workspace
		.getConfiguration("bpmsoft")
		.update(field.key, input.trim(), vscode.ConfigurationTarget.Workspace);
	return true;
}
