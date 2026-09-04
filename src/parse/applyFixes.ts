import { AUTO_FORMAT_SAFE_KINDS, StyleFix, StyleIssue } from "./styleAnalyzer";

/**
 * Applies a batch of non-overlapping StyleFix edits to `text` in one pass,
 * right-to-left so earlier offsets stay valid. Fixes whose range overlaps
 * one already applied (closer to the end) are skipped rather than risking
 * corrupted output.
 */
export function applyStyleFixes(text: string, fixes: StyleFix[]): string {
	if (!fixes.length) {
		return text;
	}
	const sorted = [...fixes].sort((a, b) => b.start - a.start);
	let result = text;
	let boundary = Infinity;
	for (const fix of sorted) {
		if (fix.end > boundary) {
			continue;
		}
		result = result.slice(0, fix.start) + fix.text + result.slice(fix.end);
		boundary = fix.start;
	}
	return result;
}

/**
 * Two issues on the same line can each want a fix whose range overlaps the
 * other's (e.g. "add a space after //" nested inside "move this trailing
 * comment above the line") — applyStyleFixes then applies only one of them
 * per pass. Re-running collect+apply converges the rest on the next pass,
 * so a single Format Document click doesn't leave a half-applied result.
 */
export function applyStyleFixesToFixpoint(
	text: string,
	collect: (source: string) => StyleIssue[],
	maxIterations = 3
): string {
	let result = text;
	for (let i = 0; i < maxIterations; i++) {
		const fixes = collect(result)
			.filter((issue) => AUTO_FORMAT_SAFE_KINDS.has(issue.kind))
			.map((issue) => issue.fix)
			.filter((fix): fix is StyleFix => !!fix);
		if (!fixes.length) {
			break;
		}
		const next = applyStyleFixes(result, fixes);
		if (next === result) {
			break;
		}
		result = next;
	}
	return result;
}
