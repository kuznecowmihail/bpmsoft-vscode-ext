import * as vscode from "vscode";

export function enablePlatformStubs(): boolean {
	return vscode.workspace
		.getConfiguration("bpmsoft")
		.get<boolean>("enablePlatformStubs", true);
}
