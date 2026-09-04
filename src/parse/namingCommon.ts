/**
 * Small helpers shared by every `*NamingAnalyzer.ts` module (Process,
 * ProcessUserTask, C#, Client schema, Entity, Data, SQL) — the common
 * `NamingIssue` result shape, PascalCase-segment reasoning (splitting a code
 * one capitalized segment at a time, flagging a temporary/placeholder-looking
 * segment baked into it), a shared ru-RU/en-US title-coverage check, and
 * recovering a finding's subject name from its own message text.
 */

/** One naming-guideline violation — every `check*Naming`/`check*Coverage`
 * function in this package returns `NamingIssue[]`. */
export interface NamingIssue {
	message: string;
}

/** A `NamingIssue` anchored to a `[start, end)` source offset range — used by
 * `checkCsharpSchemaNaming`, the one analyzer that computes its own
 * diagnostic position itself instead of leaving that to the caller (every
 * other `*NamingAnalyzer.ts` module works off a schema's registered Name,
 * with no source text of its own to anchor a range in). */
export interface PositionedNamingIssue extends NamingIssue {
	start: number;
	end: number;
}

/** Splits a PascalCase code into its capitalized segments (`"NauApprovalProcessV2"`
 * → `["Nau", "Approval", "Process", "V2"]`) — digits after the capital are
 * kept with it so a trailing `"V2"`-style version marker comes out as one
 * segment, not split into `"V"` + `"2"`. */
export function pascalCaseSegments(name: string): string[] {
	return name.match(/[A-Z][a-z0-9]*/g) || [name];
}

export const TEMP_DESIGNATION_WORDS = ["New", "Test", "Temp", "Copy", "Old", "Backup"];

/** The first PascalCase segment that looks like a temporary/placeholder
 * designation rather than a real name — one of `TEMP_DESIGNATION_WORDS`, or
 * a bare `V` + digits (a self-made version suffix, as opposed to a real
 * platform-sanctioned suffix like a client schema's own `PageV2`). */
export function findTemporaryDesignationSegment(name: string): string | undefined {
	return pascalCaseSegments(name).find(
		(segment) => TEMP_DESIGNATION_WORDS.includes(segment) || /^V\d+$/.test(segment)
	);
}

/** The message text every `*NamingAnalyzer.ts` check writes its subject name
 * into, wrapped either in Russian guillemets (`«Name»`, most checks) or
 * plain double quotes (`"Name"`, Process/UserTask/Entity/Data) — whichever
 * comes first is the finding's subject. Used only for the "mark as false
 * positive" quick action, which needs to recover the name from a
 * already-built `NamingFinding`/diagnostic message rather than threading a
 * dedicated field through every push site. */
export function extractNamingSubject(message: string): string | undefined {
	return message.match(/[«"]([^»"]+)[»"]/)?.[1];
}

/** Whether a subject (Process/UserTask/Object/...) has its own ru-RU/en-US
 * `Caption` — the same missing-title shape every schema type with a
 * localized title needs. `label` is the finding-message word for the
 * subject kind (`"Process"`/`"UserTask"`/`"Object"`/...). */
export function checkCaptionCoverage(
	label: string,
	name: string,
	hasRuCaption: boolean,
	hasEnCaption: boolean
): NamingIssue[] {
	const issues: NamingIssue[] = [];
	if (!hasRuCaption) {
		issues.push({ message: `${label} "${name}": missing a Russian title (ru-RU Caption)` });
	}
	if (!hasEnCaption) {
		issues.push({ message: `${label} "${name}": missing an English title (en-US Caption)` });
	}
	return issues;
}
