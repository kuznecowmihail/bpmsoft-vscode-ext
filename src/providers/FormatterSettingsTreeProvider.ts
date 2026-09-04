import * as vscode from "vscode";

export const SET_DEFAULT_FORMATTER_COMMAND = "bpmsoft.setDefaultFormatter";

interface FormatterLang {
	languageId: string;
	displayName: string;
}

const LANGS: FormatterLang[] = [
	{ languageId: "javascript", displayName: "JavaScript" },
	{ languageId: "csharp", displayName: "C#" },
	{ languageId: "sql", displayName: "SQL" }
];

/**
 * A row per formattable language in the BPMSoft view container, showing
 * whether this extension is already `editor.defaultFormatter` for that
 * language and letting the user set it with one click — registering our
 * DocumentFormattingEditProvider isn't enough on its own if another
 * formatter extension is installed and already holds that slot (or none is
 * set and VS Code prompts instead of just running ours).
 */
export class FormatterSettingsTreeProvider implements vscode.TreeDataProvider<FormatterLang> {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	constructor(private readonly extensionId: string) {}

	refresh(): void {
		this.changeEmitter.fire();
	}

	getChildren(): FormatterLang[] {
		return LANGS;
	}

	getTreeItem(lang: FormatterLang): vscode.TreeItem {
		const current = currentDefaultFormatter(lang.languageId);
		const isDefault = current === this.extensionId;
		const item = new vscode.TreeItem(lang.displayName, vscode.TreeItemCollapsibleState.None);
		item.description = isDefault
			? "BPMSoft (по умолчанию)"
			: current
				? `сейчас: ${current}`
				: "форматтер не задан";
		item.iconPath = new vscode.ThemeIcon(isDefault ? "check" : "circle-large-outline");
		item.tooltip = isDefault
			? "BPMSoft уже используется как форматтер по умолчанию для этого языка"
			: "Нажмите, чтобы сделать BPMSoft форматтером по умолчанию для этого языка (настройка рабочей области)";
		if (!isDefault) {
			item.command = {
				command: SET_DEFAULT_FORMATTER_COMMAND,
				title: "Сделать BPMSoft форматтером по умолчанию",
				arguments: [lang.languageId]
			};
		}
		return item;
	}
}

function currentDefaultFormatter(languageId: string): string | undefined {
	return vscode.workspace
		.getConfiguration("editor", { languageId })
		.get<string>("defaultFormatter");
}

export async function setDefaultFormatter(
	extensionId: string,
	languageId?: string
): Promise<void> {
	const targets = languageId ? [languageId] : LANGS.map((l) => l.languageId);
	for (const id of targets) {
		const config = vscode.workspace.getConfiguration("editor", { languageId: id });
		await config.update(
			"defaultFormatter",
			extensionId,
			vscode.ConfigurationTarget.Workspace,
			true
		);
	}
}
