/**
 * `// bpmsoft-ignore: <ruleId>` suppression-comment lookup — split out of
 * `styleAnalyzer.ts` (which re-exports it, so existing imports of it from
 * there keep working) so `schemaUsageAnalyzer.ts` can also use it without
 * creating a `styleAnalyzer.ts` ⇄ `schemaUsageAnalyzer.ts` import cycle
 * (`styleAnalyzer.ts` already imports several `collect*Issues` functions
 * from `schemaUsageAnalyzer.ts`).
 */

const SUPPRESS_COMMENT_RE = /^\/\/\s*bpmsoft-ignore:\s*([\w-]+)\s*$/;

/**
 * True when the non-blank source line immediately above `start` is a
 * `// bpmsoft-ignore: <ruleId>` marker matching `ruleId`.
 */
export function isSuppressedAbove(source: string, start: number, ruleId: string): boolean {
	const lineStart = source.lastIndexOf("\n", start - 1) + 1;
	let prevLineEnd = lineStart > 0 ? lineStart - 1 : -1;
	while (prevLineEnd >= 0) {
		const prevLineStart = source.lastIndexOf("\n", prevLineEnd - 1) + 1;
		const prevLine = source.slice(prevLineStart, prevLineEnd).trim();
		if (!prevLine) {
			prevLineEnd = prevLineStart > 0 ? prevLineStart - 1 : -1;
			continue;
		}
		const m = SUPPRESS_COMMENT_RE.exec(prevLine);
		return !!m && m[1] === ruleId;
	}
	return false;
}
