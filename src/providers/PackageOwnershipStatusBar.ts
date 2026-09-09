import * as vscode from "vscode";
import { checkPackageOwnership, findPackageDir, readPackageDescriptor } from "../index/packageOwnershipCheck";
import { expectedMaintainers, namingPrefixes } from "../config";

/**
 * Bottom-of-window indicator for the active file's package — see
 * `packageOwnershipCheck.ts` for what's checked. Same silent-unless-there's-
 * a-problem convention as `GitFlowStatusBar`; sits right next to it
 * (priority 99 vs. 100).
 */
export class PackageOwnershipStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	}

	dispose(): void {
		this.item.dispose();
	}

	refresh(): void {
		const document = vscode.window.activeTextEditor?.document;
		if (!document || document.uri.scheme !== "file") {
			this.item.hide();
			return;
		}
		const packageDir = findPackageDir(document.uri.fsPath);
		const descriptor = packageDir ? readPackageDescriptor(packageDir) : undefined;
		if (!descriptor) {
			this.item.hide();
			return;
		}
		const issues = checkPackageOwnership(descriptor, {
			prefixes: namingPrefixes(),
			expectedMaintainers: expectedMaintainers()
		});
		if (!issues.length) {
			this.item.hide();
			return;
		}
		this.item.text = `$(warning) ${issues[0].message}`;
		this.item.tooltip = new vscode.MarkdownString(
			["**Package**", ...issues.map((i) => `- ${i.message}`)].join("\n")
		);
		this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
		this.item.show();
	}
}
