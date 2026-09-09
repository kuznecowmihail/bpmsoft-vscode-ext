/**
 * "Is WorkspaceConsole's own `<connectionStrings>` in sync with the app's
 * main `ConnectionStrings.config`" check + one-click fix. WorkspaceConsole
 * (`BPMSoft.Tools.WorkspaceConsole.dll.config`) never reads the app root's
 * own `ConnectionStrings.config` (see `appConfigDiscovery.ts`'s own doc) — it
 * has its own inline block — so it's easy for the two to drift. A real,
 * live example of exactly this drift was found in both installs sampled
 * during development: WorkspaceConsole's own `db` entry pointing at a
 * different database/credentials than the app's real `ConnectionStrings.config`
 * (a stale template value, never updated after the environment was set up).
 *
 * "Configured" is judged only by the connection-string *names*
 * WorkspaceConsole's own file(s) already declare that also happen to exist
 * in the main file — e.g. `BPMSoft.Tools.Common.dll.config`'s own legacy
 * `mssqlCore`/`mssqlSolution`/... names never appear in
 * `ConnectionStrings.config` at all (confirmed in a real install), so they're
 * correctly left alone rather than flagged as "wrong" or overwritten with
 * nothing.
 */

import * as fs from "fs";
import * as path from "path";
import { CONNECTION_STRINGS_SPEC, EditResult, hasXmlAddBlock, listXmlAddEntries, setXmlAddEntryValue } from "./dotnetConfigEditor";

export interface WorkspaceConsoleMismatch {
	filePath: string;
	fileLabel: string;
	name: string;
	mainValue: string;
	consoleValue: string;
}

export interface WorkspaceConsoleStatus {
	/** false when there's no main `ConnectionStrings.config`, or no
	 * `WorkspaceConsole\*.dll.config` with its own `<connectionStrings>` at
	 * all — the whole feature doesn't apply to this app root. */
	applicable: boolean;
	configured: boolean;
	mismatches: WorkspaceConsoleMismatch[];
}

function findWorkspaceConsoleConfigFiles(appRoot: string): string[] {
	const dir = path.join(appRoot, "WorkspaceConsole");
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((n) => n.toLowerCase().endsWith(".dll.config"))
		.map((n) => path.join(dir, n))
		.filter((p) => hasXmlAddBlock(p, CONNECTION_STRINGS_SPEC));
}

export function getWorkspaceConsoleStatus(appRoot: string): WorkspaceConsoleStatus {
	const mainFile = path.join(appRoot, "ConnectionStrings.config");
	if (!fs.existsSync(mainFile)) {
		return { applicable: false, configured: true, mismatches: [] };
	}
	const consoleFiles = findWorkspaceConsoleConfigFiles(appRoot);
	if (consoleFiles.length === 0) {
		return { applicable: false, configured: true, mismatches: [] };
	}
	const mainByName = new Map((listXmlAddEntries(mainFile, CONNECTION_STRINGS_SPEC) ?? []).map((e) => [e.name, e.value]));
	const mismatches: WorkspaceConsoleMismatch[] = [];
	for (const filePath of consoleFiles) {
		const entries = listXmlAddEntries(filePath, CONNECTION_STRINGS_SPEC) ?? [];
		for (const entry of entries) {
			const mainValue = mainByName.get(entry.name);
			if (mainValue !== undefined && mainValue !== entry.value) {
				mismatches.push({
					filePath,
					fileLabel: path.basename(filePath),
					name: entry.name,
					mainValue,
					consoleValue: entry.value
				});
			}
		}
	}
	return { applicable: true, configured: mismatches.length === 0, mismatches };
}

/** The actual runnable DLL (`dotnet <this> -operation=...`) — distinct from
 * `BPMSoft.Tools.Common.dll`, which sits in the same folder and also ends in
 * `.dll` but has no `Main`. `undefined` when the folder doesn't exist/doesn't
 * apply (mirrors `getWorkspaceConsoleStatus`'s own "not applicable" check). */
export function findWorkspaceConsoleDll(appRoot: string): string | undefined {
	const dir = path.join(appRoot, "WorkspaceConsole");
	const preferred = path.join(dir, "BPMSoft.Tools.WorkspaceConsole.dll");
	if (fs.existsSync(preferred)) {
		return preferred;
	}
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return undefined;
	}
	const fallback = names.find((n) => /WorkspaceConsole\.dll$/i.test(n) && !/\.Common\.dll$/i.test(n));
	return fallback ? path.join(dir, fallback) : undefined;
}

export function autoConfigureWorkspaceConsole(appRoot: string): EditResult {
	const status = getWorkspaceConsoleStatus(appRoot);
	for (const m of status.mismatches) {
		const result = setXmlAddEntryValue(m.filePath, CONNECTION_STRINGS_SPEC, m.name, m.mainValue);
		if (!result.ok) {
			return result;
		}
	}
	return { ok: true };
}
