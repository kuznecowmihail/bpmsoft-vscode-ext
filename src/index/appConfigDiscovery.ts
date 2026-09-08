/**
 * Finds the app-root deployment config files a "Config Files" wizard can
 * edit — `ConnectionStrings.config`, `appsettings.json`, and any `*.dll.config`
 * (root or `WorkspaceConsole\`) carrying an inline `<connectionStrings>` and/or
 * `<appSettings>` block. These live at `BpmsoftAppLayout.appRoot`
 * (`workspaceLayout.ts`) — the deployed app root, not `BPMSoft.Configuration\Pkg`.
 *
 * Confirmed by inspecting two real installs: only `BPMSoft.WebHost.dll.config`
 * (root) has `<appSettings>`; `WorkspaceConsole\BPMSoft.Tools.WorkspaceConsole.dll.config`
 * and `WorkspaceConsole\BPMSoft.Tools.Common.dll.config` have their own inline
 * `<connectionStrings>` distinct from the root `ConnectionStrings.config` (the
 * Workspace Console never reads that file — it points at a different DB by
 * design, e.g. during a rebuild). Every other `BPMSoft.*.dll.config` sampled
 * had neither block, so they're not worth a dedicated entry.
 */

import * as fs from "fs";
import * as path from "path";
import { APP_SETTINGS_SPEC, CONNECTION_STRINGS_SPEC, hasXmlAddBlock } from "./dotnetConfigEditor";

export type AppConfigEntryKind =
	| "connectionStringsFile"
	| "appSettingsJson"
	| "xmlConnectionStrings"
	| "xmlAppSettings";

export interface AppConfigEntry {
	kind: AppConfigEntryKind;
	filePath: string;
	label: string;
	appRoot: string;
}

function scanDllConfigs(dir: string, labelPrefix: string, appRoot: string, out: AppConfigEntry[]): void {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.toLowerCase().endsWith(".dll.config")) {
			continue;
		}
		const filePath = path.join(dir, name);
		if (hasXmlAddBlock(filePath, CONNECTION_STRINGS_SPEC)) {
			out.push({ kind: "xmlConnectionStrings", filePath, label: `${labelPrefix}${name} — ConnectionStrings`, appRoot });
		}
		if (hasXmlAddBlock(filePath, APP_SETTINGS_SPEC)) {
			out.push({ kind: "xmlAppSettings", filePath, label: `${labelPrefix}${name} — appSettings`, appRoot });
		}
	}
}

export function discoverAppConfigEntries(appRoot: string): AppConfigEntry[] {
	const out: AppConfigEntry[] = [];

	const connectionStringsFile = path.join(appRoot, "ConnectionStrings.config");
	if (fs.existsSync(connectionStringsFile)) {
		out.push({ kind: "connectionStringsFile", filePath: connectionStringsFile, label: "ConnectionStrings.config", appRoot });
	}

	const appSettingsJson = path.join(appRoot, "appsettings.json");
	if (fs.existsSync(appSettingsJson)) {
		out.push({ kind: "appSettingsJson", filePath: appSettingsJson, label: "appsettings.json", appRoot });
	}

	scanDllConfigs(appRoot, "", appRoot, out);
	scanDllConfigs(path.join(appRoot, "WorkspaceConsole"), "WorkspaceConsole\\", appRoot, out);

	return out;
}
