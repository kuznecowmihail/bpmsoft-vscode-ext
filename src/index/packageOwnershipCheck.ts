import * as fs from "fs";
import * as path from "path";

export interface PackageDescriptor {
	name: string;
	maintainer?: string;
}

export interface PackageOwnershipIssue {
	message: string;
}

export interface PackageOwnershipSettings {
	/** Reuses `bpmsoft.namingPrefixes` — the naming guideline treats "which
	 * stream a package belongs to" and "which prefix its schema names get"
	 * as the same convention (a package's own name follows the prefix too,
	 * e.g. `GoTracker`/`NauLogging`), so one setting covers both rather than
	 * asking for the prefix twice. */
	prefixes: string[];
	expectedMaintainers: string[];
}

/** `.../Pkg/{Package}/...` → `.../Pkg/{Package}` — works for any file inside
 * a package (schemas, SQL scripts, resources), not just `Schemas/`. */
export function findPackageDir(filePath: string): string | undefined {
	const normalized = filePath.replace(/\\/g, "/");
	const match = normalized.match(/^(.*\/Pkg\/[^/]+)\//);
	return match?.[1];
}

/** Package-level `descriptor.json` (`{Descriptor: {Name, Maintainer, ...}}`)
 * — confirmed real shape against `GoTracker`/`NauBusinessProcessesUtils` in
 * two real installs: `{"Descriptor": {"Name": "GoTracker", "Maintainer":
 * "YandexGo", ...}}`. Distinct from a *schema's own* `descriptor.json`
 * (`Pkg/{Package}/Schemas/{Schema}/descriptor.json`, no `Maintainer`) — this
 * one lives directly under the package folder. */
export function readPackageDescriptor(packageDir: string): PackageDescriptor | undefined {
	const descriptorPath = path.join(packageDir, "descriptor.json");
	let raw: string;
	try {
		raw = fs.readFileSync(descriptorPath, "utf8").replace(/^﻿/, "");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as { Descriptor?: { Name?: unknown; Maintainer?: unknown } };
		const name = parsed?.Descriptor?.Name;
		if (typeof name !== "string" || !name) {
			return undefined;
		}
		const maintainer = parsed?.Descriptor?.Maintainer;
		return { name, maintainer: typeof maintainer === "string" ? maintainer : undefined };
	} catch {
		return undefined;
	}
}

/**
 * "Разработка ведётся только в пакетах соответствующего стрима… Внесение
 * изменений в пакеты сторонних издателей запрещено или по согласованию" —
 * the two parts of the guideline that are actually checkable from a
 * package's own `descriptor.json`, without the BPMSoft system DB connection
 * (`CurrentPackageId`/`SchemaNamePrefix`/`Maintainer` system settings) this
 * extension doesn't have:
 * - the package's own name matches one of the configured stream prefixes
 * - the package's `Maintainer` is one of ours, not a third party's
 * `CurrentPackageId`'s equivalent (`bpmsoft.currentPackage`) isn't enforced
 * here — it names *one specific* package new objects should default into,
 * which isn't something a static per-file check can meaningfully validate
 * (legitimately editing other in-stream packages isn't a violation); it's
 * kept as a reference value in the Package Settings view instead.
 */
export function checkPackageOwnership(
	descriptor: PackageDescriptor,
	settings: PackageOwnershipSettings
): PackageOwnershipIssue[] {
	const issues: PackageOwnershipIssue[] = [];
	if (settings.prefixes.length && !settings.prefixes.some((prefix) => descriptor.name.startsWith(prefix))) {
		issues.push({
			message: `Package "${descriptor.name}" does not match the expected prefix (${settings.prefixes.join("/")})`
		});
	}
	if (
		settings.expectedMaintainers.length &&
		descriptor.maintainer &&
		!settings.expectedMaintainers.includes(descriptor.maintainer)
	) {
		issues.push({
			message: `Package "${descriptor.name}" belongs to a different maintainer (${descriptor.maintainer})`
		});
	}
	return issues;
}
