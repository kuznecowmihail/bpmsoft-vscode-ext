import * as vscode from "vscode";

export function isJsFile(document: vscode.TextDocument): boolean {
	return document.languageId === "javascript" && document.uri.scheme === "file";
}

export function isCsharpFile(document: vscode.TextDocument): boolean {
	if (document.languageId === "csharp") {
		return document.uri.scheme === "file" || document.uri.scheme === "untitled";
	}
	return document.uri.scheme === "file" && /\.cs$/i.test(document.uri.fsPath);
}

export function isStyleFile(document: vscode.TextDocument): boolean {
	return isJsFile(document) || isCsharpFile(document);
}

export function debounceDocument(
	timers: Map<string, ReturnType<typeof setTimeout>>,
	document: vscode.TextDocument,
	run: (document: vscode.TextDocument) => void,
	delayMs = 300,
	accept: (document: vscode.TextDocument) => boolean = isJsFile
): void {
	if (!accept(document)) {
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
