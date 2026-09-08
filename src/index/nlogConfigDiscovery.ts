/**
 * Finds the nlog.config-shaped units a "Config Files" wizard can edit, and
 * which physical file backs each of their four editable sections (Variables,
 * Extensions, Targets, Rules).
 *
 * Confirmed by inspecting two real installs: the root `nlog.config` carries
 * `<rules>` itself and an `<include file="nlog.targets.config" />` for the
 * rest (`<variable>`, `<extensions>`, `<targets>`) — resolved here the same
 * way NLog itself resolves it (relative to the including file's own
 * directory). `WorkspaceConsole\BPMSoft.Tools.WorkspaceConsole.nlog.config`
 * is a second, fully separate unit with no `<include>` of its own — all four
 * sections live directly in that one file.
 */

import * as fs from "fs";
import * as path from "path";
import { readFileSafe } from "../fsUtils";
import { AppConfigEntry } from "./appConfigDiscovery";
import { findContainerSpan } from "./nlogXml";

function resolveIncludedFiles(nlogConfigPath: string): string[] {
	const text = readFileSafe(nlogConfigPath);
	if (!text) {
		return [];
	}
	const dir = path.dirname(nlogConfigPath);
	const files: string[] = [];
	const re = /<include\b[^>]*\bfile\s*=\s*"([^"]+)"[^>]*\/>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const resolved = path.isAbsolute(m[1]) ? m[1] : path.join(dir, m[1]);
		if (fs.existsSync(resolved)) {
			files.push(resolved);
		}
	}
	return files;
}

/** First file (in load order: the root file, then its includes in the order
 * declared) that actually has the section — a section absent from a given
 * file simply isn't reported, rather than assumed present. */
function findSectionFile(candidateFiles: string[], containerTag: string): string | undefined {
	for (const file of candidateFiles) {
		const text = readFileSafe(file);
		if (text && findContainerSpan(text, containerTag)) {
			return file;
		}
	}
	return undefined;
}

/** `<variable>` has no dedicated container tag of its own (it's a direct
 * child of `<nlog>` alongside `<extensions>`/`<targets>`/`<rules>`/`<include>`),
 * so its presence is checked directly rather than via `findContainerSpan`. */
function findVariablesFile(candidateFiles: string[]): string | undefined {
	for (const file of candidateFiles) {
		const text = readFileSafe(file);
		if (text && /<variable\b/.test(text)) {
			return file;
		}
	}
	return undefined;
}

function buildEntriesForUnit(rootFile: string, label: string, appRoot: string): AppConfigEntry[] {
	const candidates = [rootFile, ...resolveIncludedFiles(rootFile)];
	const out: AppConfigEntry[] = [];

	const varFile = findVariablesFile(candidates);
	if (varFile) {
		out.push({ kind: "nlogVariables", filePath: varFile, label: `${label} — Variables`, appRoot });
	}
	const extFile = findSectionFile(candidates, "extensions");
	if (extFile) {
		out.push({ kind: "nlogExtensions", filePath: extFile, label: `${label} — Extensions`, appRoot });
	}
	const targetsFile = findSectionFile(candidates, "targets");
	if (targetsFile) {
		out.push({ kind: "nlogTargets", filePath: targetsFile, label: `${label} — Targets`, appRoot });
	}
	const rulesFile = findSectionFile(candidates, "rules");
	if (rulesFile) {
		out.push({ kind: "nlogRules", filePath: rulesFile, label: `${label} — Rules`, appRoot });
	}
	return out;
}

export function discoverNlogConfigEntries(appRoot: string): AppConfigEntry[] {
	const out: AppConfigEntry[] = [];

	const rootFile = path.join(appRoot, "nlog.config");
	if (fs.existsSync(rootFile)) {
		out.push(...buildEntriesForUnit(rootFile, "nlog.config", appRoot));
	}

	const workspaceConsoleDir = path.join(appRoot, "WorkspaceConsole");
	let names: string[];
	try {
		names = fs.readdirSync(workspaceConsoleDir);
	} catch {
		names = [];
	}
	for (const name of names) {
		if (!name.toLowerCase().endsWith(".nlog.config")) {
			continue;
		}
		out.push(...buildEntriesForUnit(path.join(workspaceConsoleDir, name), `WorkspaceConsole\\${name}`, appRoot));
	}

	return out;
}
