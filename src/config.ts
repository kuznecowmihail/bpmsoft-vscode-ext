import * as vscode from "vscode";

export function enablePlatformStubs(): boolean {
	return vscode.workspace
		.getConfiguration("bpmsoft")
		.get<boolean>("enablePlatformStubs", true);
}

export function namingDiagnosticsEnabled(): boolean {
	return vscode.workspace
		.getConfiguration("bpmsoft")
		.get<boolean>("namingDiagnostics", true);
}

/** Comma-separated `bpmsoft.namingPrefixes` setting, trimmed and split. Empty
 * (the default) disables the prefix check entirely — there's no one
 * universal prefix ("Nau" or otherwise) to assume. */
export function namingPrefixes(): string[] {
	const raw = vscode.workspace
		.getConfiguration("bpmsoft")
		.get<string>("namingPrefixes", "");
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}
