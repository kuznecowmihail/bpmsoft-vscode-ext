import * as vscode from "vscode";

export function isJsFile(document: vscode.TextDocument): boolean {
	return document.languageId === "javascript" && document.uri.scheme === "file";
}

export function debounceDocument(
	timers: Map<string, ReturnType<typeof setTimeout>>,
	document: vscode.TextDocument,
	run: (document: vscode.TextDocument) => void,
	delayMs = 300
): void {
	if (!isJsFile(document)) {
		return;
	}
	const key = document.uri.toString();
	const prev = timers.get(key);
	if (prev) {
		clearTimeout(prev);
	}
	timers.set(
		key,
		setTimeout(() => {
			timers.delete(key);
			run(document);
		}, delayMs)
	);
}

export function clearDebounceTimers(
	timers: Map<string, ReturnType<typeof setTimeout>>
): void {
	for (const timer of timers.values()) {
		clearTimeout(timer);
	}
	timers.clear();
}
