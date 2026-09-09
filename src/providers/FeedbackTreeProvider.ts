import * as vscode from "vscode";

interface FeedbackContact {
	readonly name: string;
	readonly url: string;
}

const CONTACTS: FeedbackContact[] = [
	{ name: "Денис Манаков", url: "https://mattermost.nau.io/nau/messages/@dmanakov" },
	{ name: "Михаил Лисицын", url: "https://mattermost.nau.io/nau/messages/@m.lisitsin" }
];

/**
 * Static rows in the BPMSoft Settings view container linking straight to a
 * Mattermost DM with either maintainer — there's no issue tracker for this
 * extension, so this is the only place to report a bug or suggest a feature.
 */
export class FeedbackTreeProvider implements vscode.TreeDataProvider<FeedbackContact> {
	getChildren(): FeedbackContact[] {
		return CONTACTS;
	}

	getTreeItem(contact: FeedbackContact): vscode.TreeItem {
		const item = new vscode.TreeItem(contact.name, vscode.TreeItemCollapsibleState.None);
		item.description = "Mattermost";
		item.iconPath = new vscode.ThemeIcon("comment-discussion");
		item.tooltip = `Написать в Mattermost: ${contact.url}`;
		item.command = {
			command: "vscode.open",
			title: "Написать в Mattermost",
			arguments: [vscode.Uri.parse(contact.url)]
		};
		return item;
	}
}
