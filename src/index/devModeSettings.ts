/**
 * Two dev-convenience toggles that live in the app's root web-host config
 * (same file as ConnectionStrings/appSettings) but aren't a wizard-table kind
 * of setting — surfaced as one-click tree items instead:
 *
 * - **File System Design Mode** (`<fileDesignMode enabled="..."/>`, confirmed
 *   present in exactly this self-closing single-attribute shape in both real
 *   installs' `BPMSoft.WebHost.dll.config`). BPMSoft's own "Настройка BPMSoft
 *   для работы в файловой системе" instructions say enabling it also
 *   requires turning OFF `UseStaticFileContent` (an ordinary `<appSettings>`
 *   `<add>`, reused from `dotnetConfigEditor.ts`) — precompiled static client
 *   content is incompatible with editing schemas as loose files on disk.
 * - **VS Code debugging** (`LoadAssemblyFromByteArray` appSetting) — per this
 *   project's own `_enableDebugging.bat`/`_disableDebugging.bat` convenience
 *   scripts (`value="false"` enables debugging, `"true"` disables it —
 *   loading an assembly from an in-memory byte array instead of straight off
 *   disk avoids a file lock but also hides it from the debugger's file<->
 *   symbol mapping). This key was not actually present in either real install
 *   sampled during development (the .bat scripts' own plain-text `-replace`
 *   silently no-ops when it's missing) — upserted here instead of blindly
 *   text-replaced, so the toggle still works the first time it's used.
 */

import * as fs from "fs";
import * as path from "path";
import {
	APP_SETTINGS_SPEC,
	EditResult,
	addXmlAddEntry,
	getSelfClosingElementAttr,
	listXmlAddEntries,
	setSelfClosingElementAttr,
	setXmlAddEntryValue
} from "./dotnetConfigEditor";

/** `BPMSoft.WebHost.dll.config` for a .NET 8 deploy, `Web.config` for .NET
 * Framework — undefined if the app root has neither. */
export function resolveWebHostConfigPath(appRoot: string): string | undefined {
	const dllConfig = path.join(appRoot, "BPMSoft.WebHost.dll.config");
	if (fs.existsSync(dllConfig)) {
		return dllConfig;
	}
	const webConfig = path.join(appRoot, "Web.config");
	return fs.existsSync(webConfig) ? webConfig : undefined;
}

function upsertAppSetting(filePath: string, key: string, value: string): EditResult {
	const existing = listXmlAddEntries(filePath, APP_SETTINGS_SPEC);
	if (existing?.some((e) => e.name === key)) {
		return setXmlAddEntryValue(filePath, APP_SETTINGS_SPEC, key, value);
	}
	return addXmlAddEntry(filePath, APP_SETTINGS_SPEC, key, value);
}

/** `undefined` when `<fileDesignMode>` isn't found — the caller should hide
 * the toggle rather than guess at a state. */
export function getFileDesignModeEnabled(filePath: string): boolean | undefined {
	const value = getSelfClosingElementAttr(filePath, "fileDesignMode", "enabled");
	return value === undefined ? undefined : value.toLowerCase() === "true";
}

export function setFileDesignMode(filePath: string, enabled: boolean): EditResult {
	const result = setSelfClosingElementAttr(filePath, "fileDesignMode", "enabled", enabled ? "true" : "false");
	if (!result.ok) {
		return result;
	}
	return upsertAppSetting(filePath, "UseStaticFileContent", enabled ? "false" : "true");
}

/** No `undefined` case — an absent `LoadAssemblyFromByteArray` key behaves
 * the same as `value="false"` (assemblies load from disk, debugging works). */
export function getDebuggingEnabled(filePath: string): boolean {
	const entry = listXmlAddEntries(filePath, APP_SETTINGS_SPEC)?.find((e) => e.name === "LoadAssemblyFromByteArray");
	return entry ? entry.value.toLowerCase() !== "true" : true;
}

export function setDebugging(filePath: string, enabled: boolean): EditResult {
	return upsertAppSetting(filePath, "LoadAssemblyFromByteArray", enabled ? "false" : "true");
}
