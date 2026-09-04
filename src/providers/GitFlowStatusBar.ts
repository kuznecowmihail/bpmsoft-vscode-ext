import * as vscode from "vscode";
import { execFile } from "child_process";
import { checkGitFlow, GitFlowSettings } from "../index/gitFlowCheck";

function findGitRoot(cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", ["rev-parse", "--show-toplevel"], { cwd }, (error, stdout) => {
			resolve(error ? undefined : stdout.trim() || undefined);
		});
	});
}

/**
 * Bottom-of-window (status bar) indicator for Git Flow conformance — see
 * `gitFlowCheck.ts` for what's actually checked and why. Silent when
 * everything's fine; shows the first violation's text with a warning icon
 * and the full list in the hover, same convention as VS Code's own
 * diagnostics-count status bar item.
 */
export class GitFlowStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private gitRoot: string | undefined;
	private gitRootResolved = false;
	/** Refreshes can overlap (window-focus + editor-change firing close
	 * together) — each spawns a few `git` child processes, so a slower
	 * earlier one finishing after a newer one must not clobber its result. */
	private refreshToken = 0;

	constructor(private readonly candidateRoots: string[]) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	}

	dispose(): void {
		this.item.dispose();
	}

	async refresh(): Promise<void> {
		const token = ++this.refreshToken;
		const config = vscode.workspace.getConfiguration("bpmsoft");
		if (!config.get<boolean>("gitFlowDiagnostics", true)) {
			this.item.hide();
			return;
		}
		const gitRoot = await this.resolveGitRoot();
		if (token !== this.refreshToken) {
			return;
		}
		if (!gitRoot) {
			this.item.hide();
			return;
		}
		const settings: GitFlowSettings = {
			mainBranch: config.get<string>("gitFlow.mainBranch", "main"),
			developBranch: config.get<string>("gitFlow.developBranch", "develop"),
			checkBranchParent: config.get<boolean>("gitFlow.checkBranchParent", true)
		};
		const issues = await checkGitFlow(gitRoot, settings);
		if (token !== this.refreshToken) {
			return;
		}
		if (!issues.length) {
			this.item.hide();
			return;
		}
		this.item.text = `$(warning) ${issues[0].message}`;
		this.item.tooltip = new vscode.MarkdownString(
			["**Git Flow**", ...issues.map((i) => `- ${i.message}`)].join("\n")
		);
		this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
		this.item.show();
	}

	private async resolveGitRoot(): Promise<string | undefined> {
		if (this.gitRootResolved) {
			return this.gitRoot;
		}
		for (const root of this.candidateRoots) {
			const found = await findGitRoot(root);
			if (found) {
				this.gitRoot = found;
				break;
			}
		}
		this.gitRootResolved = true;
		return this.gitRoot;
	}
}
