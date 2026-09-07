import { NamingIssue } from "./namingCommon";

/** A raw hex-looking blob of 16+ chars — the shape of a stripped-down GUID
 * (`1ecde34cf83743188a3g82763a8ed267`-style) the platform sometimes appends
 * when it auto-names a Data schema, which naming-guidelines.md §5 asks to be
 * removed after the schema is created (its own bad example:
 * `SysModuleEdit_SysModuleEditManager_1ecde34cf83743188a3g82763a8ed267`). */
const GUID_SEGMENT_RE = /^[0-9a-f]{16,}$/i;

/**
 * Checks a `Data/{Name}/` schema's own Code against naming-guidelines.md §5
 * — PascalCase, English-only (digits/underscores allowed, they're part of
 * every real template: `Lookup_X`, `{Table}_Data`, `SysSettings_{Code}`, …),
 * and the `{TableName}_...` prefix template every real category (Lookup,
 * table data, SysSettings, SysSettingsValue, …) reduces to once `tableName`
 * (`descriptor.json`'s own `Descriptor.Schema.Name` — ground truth, not a
 * guess) is known. Doesn't check "reflects the table, not one record" (e.g.
 * `ContactType_Employee` vs `ContactType_Data`) — that's a judgment about
 * meaning, not syntax.
 */
export function checkDataSchemaCodeNaming(code: string, tableName: string): NamingIssue[] {
	const issues: NamingIssue[] = [];
	if (!/^[A-Za-z0-9_]+$/.test(code)) {
		issues.push({ message: `Data "${code}": code must contain only English letters, digits and underscores` });
	} else if (!/^[A-Z]/.test(code)) {
		issues.push({ message: `Data "${code}": code must be PascalCase` });
	}
	if (code !== tableName && !code.startsWith(`${tableName}_`)) {
		issues.push({
			message: `Data "${code}": code should start with its target table's own name ("${tableName}_...")`
		});
	}
	const guidSegment = code.split("_").find((segment) => GUID_SEGMENT_RE.test(segment));
	if (guidSegment) {
		issues.push({
			message: `Data "${code}": avoid a raw GUID/hash segment ("${guidSegment}") in the code — remove technical suffixes the platform may have auto-generated`
		});
	}
	return issues;
}

/** One `SysSettings` Data schema — `rowId` is its own seeded row's `Id`
 * (what a `SysSettingsValue` row's own `"SysSettings"` column points back
 * at), `undefined` if it couldn't be read. */
export interface SysSettingsOccurrence {
	code: string;
	filePath: string;
	rowId: string | undefined;
}

/** One `SysSettingsValue` Data schema — `referencedSysSettingsId` is its own
 * seeded row's `"SysSettings"` foreign-key value. */
export interface SysSettingsValueOccurrence {
	code: string;
	filePath: string;
	referencedSysSettingsId: string | undefined;
}

export interface SysSettingsPairingResult {
	/** A SysSettings row no SysSettingsValue row references — per the team's
	 * own experience (see CLAUDE.md), reading it (e.g. `SysSettings.GetValue`)
	 * can 400 without one. */
	missingValue: SysSettingsOccurrence[];
	/** A SysSettingsValue row whose "SysSettings" reference doesn't resolve
	 * to any SysSettings row found in the scanned packages — most often a
	 * genuine orphan, but can also be a legitimate value override for a
	 * stock/platform SysSettings whose own definition lives outside `Pkg`
	 * (not visible to this scan) — the caller should word the message to
	 * allow for that. */
	missingSettings: SysSettingsValueOccurrence[];
}

/**
 * Pairs every SysSettings/SysSettingsValue Data schema found across the
 * whole workspace by their seeded rows' real Id/foreign-key value — not by
 * folder-name string matching, which would miss a real mismatch whenever a
 * SysSettingsValue's own Code doesn't happen to mirror the setting's Code
 * (matches naming-guidelines.md's own advice to keep them in sync, but
 * doesn't require it to detect a real pairing gap).
 */
export function findSysSettingsPairingIssues(
	settings: SysSettingsOccurrence[],
	values: SysSettingsValueOccurrence[]
): SysSettingsPairingResult {
	const referencedIds = new Set(
		values.map((v) => v.referencedSysSettingsId).filter((id): id is string => !!id)
	);
	const settingsIds = new Set(settings.map((s) => s.rowId).filter((id): id is string => !!id));
	return {
		missingValue: settings.filter((s) => s.rowId && !referencedIds.has(s.rowId)),
		missingSettings: values.filter((v) => v.referencedSysSettingsId && !settingsIds.has(v.referencedSysSettingsId))
	};
}
