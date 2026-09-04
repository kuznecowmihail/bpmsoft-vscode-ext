export interface NamingIssue {
	message: string;
}

export interface EntityNamingSettings {
	/** Same `bpmsoft.namingPrefixes` used for client schemas — the guideline
	 * treats object/column code prefix as the same team/stream convention. */
	prefixes: string[];
	checkSingularName: boolean;
	/** Entities that are legitimately plural by meaning (`Settings`,
	 * `Permissions`, `Statistics`, …) — from the guideline's own examples,
	 * user-extendable. */
	singularExceptions: string[];
	/** Acceptable suffixes for DATE/DATE_TIME/TIME columns
	 * (`CreatedOn`/`ModifiedOn` → "On", `StartDate` → "Date"). */
	dateSuffixes: string[];
	/** Acceptable verb/assertion prefixes for BOOLEAN columns
	 * (`IsActive`/`HasAttachment`/`CanEdit`). */
	booleanPrefixes: string[];
}

/** "Tbl"/"Entity"/"Field" as a prefix or suffix — a database-ish/technical
 * name for something that should just be the business name. Checked as a
 * PascalCase-boundary affix (case-sensitive), not a substring match, so
 * e.g. "Entitlement" doesn't false-positive on "Entity". */
const TECHNICAL_AFFIXES = ["Tbl", "Entity", "Field"];

export interface EntityColumnInfo {
	/** Own Code, e.g. "GoStatus" — with the team prefix still on it. */
	name: string;
	/** `IndexedMember.dataValueType`-shaped: `"BPMSoft.DataValueType.X"` (or
	 * already-bare `"X"`) — normalized to the bare enum name internally. */
	dataValueType?: string;
	isLookup: boolean;
}

function dataValueTypeName(raw: string | undefined): string | undefined {
	return raw?.split(".").pop();
}

/** The team-prefix-stripped "business name" (`NauCustomer` → `Customer`) —
 * exported so the caller can compute an entity's own business name once and
 * pass it into `checkEntityColumnNaming`'s redundant-repetition check. */
export function stripPrefix(name: string, prefixes: string[]): string {
	const matched = prefixes.find((p) => name.startsWith(p));
	return matched ? name.slice(matched.length) : name;
}

/** "Tbl"/"Entity"/"Field" as a prefix or suffix — shared with
 * `processUserTaskNamingAnalyzer.ts`'s parameter check, same rationale. */
export function hasTechnicalAffix(name: string): string | undefined {
	return TECHNICAL_AFFIXES.find((affix) => name.startsWith(affix) || name.endsWith(affix));
}

/** Crude heuristic, not a real pluralization check (English has none without
 * a dictionary): ends in a lowercase "s" that isn't part of a common
 * non-plural ending (`Status`, `Address`, `Analysis`, …). Deliberately noisy
 * — `checkSingularName` and `singularExceptions` exist so a team can tune or
 * disable it rather than live with false positives. */
function looksPlural(name: string, exceptions: string[]): boolean {
	if (exceptions.includes(name)) {
		return false;
	}
	return /[a-z]s$/.test(name) && !/(ss|us|is)$/.test(name);
}

/**
 * Checks an object's (`EntitySchemaManager` schema) own Code against
 * naming-guidelines.md §2 — PascalCase, English-only, team prefix,
 * singular, no technical affixes. Doesn't check the Title/Caption (see
 * `checkEntityCaptionCoverage`) or cross-package uniqueness (needs to see
 * every occurrence at once — see `findEntityCodeCollisions`).
 */
export function checkEntityCodeNaming(name: string, settings: EntityNamingSettings): NamingIssue[] {
	const issues: NamingIssue[] = [];
	if (!/^[A-Za-z0-9]+$/.test(name)) {
		issues.push({ message: `Object "${name}": code must contain only English letters and digits` });
	} else if (!/^[A-Z]/.test(name)) {
		issues.push({ message: `Object "${name}": code must be PascalCase` });
	}
	if (settings.prefixes.length && !settings.prefixes.some((p) => name.startsWith(p))) {
		issues.push({ message: `Object "${name}": expected prefix (${settings.prefixes.join("/")})` });
	}
	if (settings.checkSingularName && looksPlural(name, settings.singularExceptions)) {
		issues.push({ message: `Object "${name}": code should be singular` });
	}
	const affix = hasTechnicalAffix(name);
	if (affix) {
		issues.push({ message: `Object "${name}": avoid the technical affix "${affix}"` });
	}
	return issues;
}

/** Entity has (or is missing) its own ru-RU/en-US `Caption` — the
 * guideline's "минимум русский и английский" for the Title. Caller resolves
 * which resource files/captions actually exist (`Resources/{Entity}.Entity/
 * resource.{culture}.xml`'s top-level `Item Name="Caption"`, confirmed real
 * shape against `GoTicket.Entity`). */
export function checkEntityCaptionCoverage(
	name: string,
	hasRuCaption: boolean,
	hasEnCaption: boolean
): NamingIssue[] {
	const issues: NamingIssue[] = [];
	if (!hasRuCaption) {
		issues.push({ message: `Object "${name}": missing a Russian title (ru-RU Caption)` });
	}
	if (!hasEnCaption) {
		issues.push({ message: `Object "${name}": missing an English title (en-US Caption)` });
	}
	return issues;
}

/**
 * Checks one custom column's Code against naming-guidelines.md §2 — prefix,
 * no technical affixes, boolean verb-prefix, date-type suffix, no redundant
 * "Id" on a lookup (see the module doc below for why), and no redundant
 * repetition of the owning entity's own business name.
 */
export function checkEntityColumnNaming(
	entityBusinessName: string,
	column: EntityColumnInfo,
	settings: EntityNamingSettings
): NamingIssue[] {
	const issues: NamingIssue[] = [];
	if (settings.prefixes.length && !settings.prefixes.some((p) => column.name.startsWith(p))) {
		issues.push({ message: `Column "${column.name}": expected prefix (${settings.prefixes.join("/")})` });
	}
	const businessName = stripPrefix(column.name, settings.prefixes);
	const affix = hasTechnicalAffix(businessName);
	if (affix) {
		issues.push({ message: `Column "${column.name}": avoid the technical affix "${affix}"` });
	}

	const typeName = dataValueTypeName(column.dataValueType);
	if (typeName === "BOOLEAN" && !settings.booleanPrefixes.some((p) => businessName.startsWith(p))) {
		issues.push({
			message: `Boolean column "${column.name}": expected a verb prefix (${settings.booleanPrefixes.join("/")})`
		});
	}
	if (
		(typeName === "DATE" || typeName === "DATE_TIME" || typeName === "TIME") &&
		!settings.dateSuffixes.some((s) => businessName.endsWith(s))
	) {
		issues.push({
			message: `Date/time column "${column.name}": expected a suffix (${settings.dateSuffixes.join("/")})`
		});
	}

	// The guideline's "{Entity}Id" foreign-key convention is about the
	// generated DB column / C# property, not the Configurator/ESQ-level
	// Code — confirmed with the team: the DB column IS auto-suffixed
	// "...Id", the auto-generated C# class gets {Name}/{Name}Id/{Name}Name,
	// ESQ and the Configurator/frontend use the bare {Name}. So a lookup's
	// own Code ending in "Id" is the actual mistake here (a redundant
	// manual suffix on top of what the platform already adds), not the
	// reverse.
	if (column.isLookup && businessName.length > 2 && businessName.endsWith("Id")) {
		issues.push({
			message: `Lookup column "${column.name}": code shouldn't end in "Id" — the platform adds that suffix automatically for the DB column/generated C# property`
		});
	}

	if (
		entityBusinessName &&
		businessName !== entityBusinessName &&
		businessName.length > entityBusinessName.length &&
		businessName.startsWith(entityBusinessName)
	) {
		const shorter = businessName.slice(entityBusinessName.length);
		issues.push({
			message: `Column "${column.name}": redundant repetition of the owning entity's own name "${entityBusinessName}" — consider "${shorter}"`
		});
	}

	return issues;
}

export interface EntityCodeOccurrence {
	name: string;
	filePath: string;
	/** `Parent.Name === Name` in the schema's own descriptor.json — the
	 * substitution marker (see CLAUDE.md §3) confirmed real for
	 * `EntitySchemaManager` descriptors too, not just client schemas (e.g.
	 * `Account` substituted across `GoMain`/`GoLavkaDarkMain`/
	 * `GoSuppliersMain`, each with `ExtendParent: true` and `Parent.Name:
	 * "Account"`). */
	isSubstitution: boolean;
}

/**
 * A Code appearing in more than one package is normal under BPMSoft's
 * substitution mechanism (the same logical entity, extended per package) —
 * only a genuine coincidental collision (two or more *independent*, non-
 * substituting definitions sharing a Code) is worth flagging. At most one
 * non-substitution occurrence is expected (the original); two or more means
 * some package created a brand new object that happens to collide with an
 * existing Code instead of substituting it.
 */
export function findEntityCodeCollisions(occurrences: EntityCodeOccurrence[]): EntityCodeOccurrence[] {
	const byName = new Map<string, EntityCodeOccurrence[]>();
	for (const occ of occurrences) {
		const list = byName.get(occ.name);
		if (list) {
			list.push(occ);
		} else {
			byName.set(occ.name, [occ]);
		}
	}
	const collisions: EntityCodeOccurrence[] = [];
	for (const list of byName.values()) {
		const originals = list.filter((o) => !o.isSubstitution);
		if (originals.length > 1) {
			collisions.push(...originals);
		}
	}
	return collisions;
}
