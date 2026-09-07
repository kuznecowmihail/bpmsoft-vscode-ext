import * as vscode from "vscode";
import { NamingFinding, NamingIssuesIndex } from "../index/NamingIssuesIndex";
import { PACKAGE_COLOR } from "./packageIcons";

const WARNING_COLOR = new vscode.ThemeColor("problemsWarningIcon.foreground");

type TreeNode =
	| { kind: "package"; name: string; findings: NamingFinding[] }
	| { kind: "finding"; finding: NamingFinding };

export class NamingIssuesTreeProvider implements vscode.TreeDataProvider<TreeNode> {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	constructor(private readonly namingIndex: NamingIssuesIndex) {
		namingIndex.onDidChangeFindings(() => this.changeEmitter.fire());
	}

	getTreeItem(node: TreeNode): vscode.TreeItem {
		if (node.kind === "package") {
			const item = new vscode.TreeItem(
				`${node.name} (${node.findings.length})`,
				vscode.TreeItemCollapsibleState.Collapsed
			);
			item.iconPath = new vscode.ThemeIcon("package", PACKAGE_COLOR);
			item.contextValue = "bpmsoftNamingPackage";
			return item;
		}
		const { finding } = node;
		const item = new vscode.TreeItem(finding.label, vscode.TreeItemCollapsibleState.None);
		item.description = finding.message;
		item.tooltip = finding.message;
		item.iconPath = new vscode.ThemeIcon("warning", WARNING_COLOR);
		item.contextValue = "bpmsoftNamingFinding";
		item.command = {
			command: "vscode.open",
			title: "Открыть",
			arguments: [
				vscode.Uri.file(finding.filePath),
				{ selection: new vscode.Range(finding.position, finding.position) }
			]
		};
		return item;
	}

	getChildren(node?: TreeNode): TreeNode[] {
		if (!node) {
			const byPackage = new Map<string, NamingFinding[]>();
			for (const finding of this.namingIndex.findings) {
				const list = byPackage.get(finding.packageName) || [];
				list.push(finding);
				byPackage.set(finding.packageName, list);
			}
			return [...byPackage.entries()]
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([name, findings]) => ({ kind: "package", name, findings }) as TreeNode);
		}
		if (node.kind === "package") {
			return node.findings.map((finding) => ({ kind: "finding", finding }) as TreeNode);
		}
		return [];
	}
}
