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

export function packageOwnershipDiagnosticsEnabled(): boolean {
	return vscode.workspace
		.getConfiguration("bpmsoft")
		.get<boolean>("packageOwnershipDiagnostics", true);
}

/** The package the team's `CurrentPackageId` system setting would normally
 * point at — we have no DB connection to read that setting directly, so
 * this is the manually-configured stand-in (see README's "Настройки
 * пакета" section). Reference only for now (shown in the Package Settings
 * view), not yet enforced as its own check — see the comment on
 * `checkPackageOwnership`. */
export function currentPackage(): string {
	return vscode.workspace.getConfiguration("bpmsoft").get<string>("currentPackage", "").trim();
}

/** Comma-separated `bpmsoft.expectedMaintainers` — stand-in for the team's
 * `Maintainer` system setting (also no DB access). Empty disables the
 * maintainer check, same convention as `namingPrefixes`. */
export function expectedMaintainers(): string[] {
	const raw = vscode.workspace
		.getConfiguration("bpmsoft")
		.get<string>("expectedMaintainers", "");
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

function commaList(key: string, fallback: string): string[] {
	const raw = vscode.workspace.getConfiguration("bpmsoft").get<string>(key, fallback);
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

export function entityNamingDiagnosticsEnabled(): boolean {
	return vscode.workspace
		.getConfiguration("bpmsoft")
		.get<boolean>("entityNamingDiagnostics", true);
}

/** Kept as its own toggle, separate from `entityNamingDiagnostics` — the
 * singular/plural heuristic is the noisiest of the entity-naming checks
 * (no dictionary, English has no reliable syntactic plural rule), so a team
 * that finds it too noisy can turn off just this one. */
export function entityNamingCheckSingular(): boolean {
	return vscode.workspace
		.getConfiguration("bpmsoft")
		.get<boolean>("entityNaming.checkSingularName", true);
}

export function entityNamingSingularExceptions(): string[] {
	return commaList("entityNaming.singularExceptions", "Settings,Permissions,Statistics");
}

export function entityNamingDateSuffixes(): string[] {
	return commaList("entityNaming.dateSuffixes", "On,Date");
}

export function entityNamingBooleanPrefixes(): string[] {
	return commaList("entityNaming.booleanPrefixes", "Is,Has,Can");
}
