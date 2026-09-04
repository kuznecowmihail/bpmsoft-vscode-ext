/**
 * Small helpers shared by several `*NamingAnalyzer.ts` modules (Process,
 * ProcessUserTask, now C#) that all need to reason about a PascalCase code
 * one capitalized segment at a time — splitting it, and flagging a
 * temporary/placeholder-looking segment (`New`/`Test`/`Temp`/`Copy`, a
 * self-made `V2`-style version marker) baked into it.
 */

/** Splits a PascalCase code into its capitalized segments (`"NauApprovalProcessV2"`
 * → `["Nau", "Approval", "Process", "V2"]`) — digits after the capital are
 * kept with it so a trailing `"V2"`-style version marker comes out as one
 * segment, not split into `"V"` + `"2"`. */
export function pascalCaseSegments(name: string): string[] {
	return name.match(/[A-Z][a-z0-9]*/g) || [name];
}

const TEMP_DESIGNATION_WORDS = ["New", "Test", "Temp", "Copy"];

/** The first PascalCase segment that looks like a temporary/placeholder
 * designation rather than a real name — one of `TEMP_DESIGNATION_WORDS`, or
 * a bare `V` + digits (a self-made version suffix, as opposed to a real
 * platform-sanctioned suffix like a client schema's own `PageV2`). */
export function findTemporaryDesignationSegment(name: string): string | undefined {
	return pascalCaseSegments(name).find(
		(segment) => TEMP_DESIGNATION_WORDS.includes(segment) || /^V\d+$/.test(segment)
	);
}
