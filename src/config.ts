import * as vscode from "vscode";

export function enablePlatformStubs(): boolean {
	return vscode.workspace
		.getConfiguration("bpmsoft")
		.get<boolean>("enablePlatformStubs", true);
}

/** Always-on inline enum/business-rule hints (`EnumInlayHintsProvider.ts`) —
 * a separate toggle from `enablePlatformStubs` since it also covers the
 * hardcoded `dataValueType`/`itemType`/rule fields, which work regardless of
 * that setting. */
export function enumInlayHintsEnabled(): boolean {
	return vscode.workspace.getConfiguration("bpmsoft").get<boolean>("enumInlayHints", true);
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

export function processNamingDiagnosticsEnabled(): boolean {
	return vscode.workspace
		.getConfiguration("bpmsoft")
		.get<boolean>("processNamingDiagnostics", true);
}

export function processUserTaskNamingDiagnosticsEnabled(): boolean {
	return vscode.workspace
		.getConfiguration("bpmsoft")
		.get<boolean>("processUserTaskNamingDiagnostics", true);
}

const DEFAULT_ACTION_VERBS =
	"Add,Apply,Assign,Build,Calculate,Call,Cancel,Change,Check,Clear,Clone,Close,Complete,Confirm," +
	"Convert,Create,Delete,Disable,Enable,Execute,Export,Find,Generate,Get,Import,Load,Log,Merge," +
	"Move,Normalize,Notify,Parse,Process,Publish,Read,Register,Reject,Reload,Remove,Reset,Run,Save," +
	"Search,Send,Set,Show,Split,Start,Stop,Sync,Unregister,Update,Validate,Verify,Write";

export function processUserTaskActionVerbs(): string[] {
	return commaList("processUserTask.actionVerbs", DEFAULT_ACTION_VERBS);
}

export function csharpNamingDiagnosticsEnabled(): boolean {
	return vscode.workspace
		.getConfiguration("bpmsoft")
		.get<boolean>("csharpNamingDiagnostics", true);
}

export function csharpNamingRoleSuffixes(): string[] {
	return commaList(
		"csharpNaming.roleSuffixes",
		"Service,EventListener,Helper,Utils,Manager,Handler,Repository,Client,Connector,Job,Process"
	);
}

export function dataNamingDiagnosticsEnabled(): boolean {
	return vscode.workspace
		.getConfiguration("bpmsoft")
		.get<boolean>("dataNamingDiagnostics", true);
}

/** A `_Temp` SQL script (naming-guidelines.md §6) is meant to be removed
 * from the package after its one-time run on target environments — this is
 * a nudge, not an authoritative check (no visibility into what's actually
 * been deployed where), so it's phrased as "older than N days, worth a
 * look" rather than a hard violation. `0` disables it. */
export function sqlTempScriptMaxAgeDays(): number {
	return vscode.workspace.getConfiguration("bpmsoft").get<number>("sqlTempScriptMaxAgeDays", 30);
}

/** Schema/process/data/class names excluded from every naming-guidelines.md
 * check — for a confirmed false positive (a check that's structurally
 * correct but doesn't fit this particular real name, e.g. "Old" used as a
 * legitimate business qualifier rather than a stale-code marker). Set via
 * the "Пометить как ложное срабатывание" quick action on a naming finding,
 * or edited directly. */
export function namingIgnoredNames(): string[] {
	return vscode.workspace
		.getConfiguration("bpmsoft")
		.get<string[]>("naming.ignoredNames", []);
}
