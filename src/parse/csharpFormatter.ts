import { collectCsharpStyleIssues } from "./csharpStyleAnalyzer";
import { applyStyleFixesToFixpoint } from "./applyFixes";

const CONTROL_KEYWORD = /^(if|switch|return|while|foreach|for)\b/;
const SKIP_PREV_LINE = /^(if|switch|while|foreach|for|else|case|default|try|catch|finally|do)\b|[{}]$/;
const MEMBER_START = /^(\[|\/\/\/|public|private|protected|internal|static|async|override|virtual|abstract|sealed|readonly|const)\b/;

/** All fixable analyzer issues (Allman braces, naming, …) applied in one
 * batch, plus format-only normalization too noisy to run as live
 * diagnostics: blank lines around control statements/members, and
 * space-indent → tabs where the file is predominantly tab-indented.
 * No vscode dependency. */
export function formatCsharpSource(original: string): string {
	let text = original;
	try {
		text = applyStyleFixesToFixpoint(text, collectCsharpStyleIssues);
	} catch {
		text = original;
	}
	text = ensureBlankLineBeforeControlKeywords(text);
	text = ensureBlankLineBetweenMembers(text);
	text = normalizeIndentToTabs(text);
	return text;
}

function splitLines(text: string): { lines: string[]; nl: string } {
	return { lines: text.split(/\r?\n/), nl: text.includes("\r\n") ? "\r\n" : "\n" };
}

/** Blank line before if/switch/return/while/foreach/for, but only when the
 * previous line is an ordinary statement (not `{`, `}`, or another control
 * keyword) — avoids breaking do/while, else-if chains, and switch cases. */
function ensureBlankLineBeforeControlKeywords(text: string): string {
	const { lines, nl } = splitLines(text);
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (CONTROL_KEYWORD.test(trimmed) && out.length) {
			const prevTrim = out[out.length - 1].trim();
			if (prevTrim !== "" && !SKIP_PREV_LINE.test(prevTrim)) {
				out.push("");
			}
		}
		out.push(line);
	}
	return out.join(nl);
}

/** Blank line between a closing `}` and the next member declaration
 * (attribute, doc comment, or an access/static/etc. modifier). */
function ensureBlankLineBetweenMembers(text: string): string {
	const { lines, nl } = splitLines(text);
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (MEMBER_START.test(trimmed) && out.length) {
			const prevTrim = out[out.length - 1].trim();
			if (prevTrim === "}") {
				out.push("");
			}
		}
		out.push(line);
	}
	return out.join(nl);
}

/** Converts pure-space indentation to tabs, but only for lines in a file
 * that's predominantly tab-indented already, and only when the space count
 * is a clean multiple of the unit — leaves alignment whitespace alone. */
function normalizeIndentToTabs(text: string): string {
	const { lines, nl } = splitLines(text);
	let tabLines = 0;
	let spaceLines = 0;
	for (const line of lines) {
		const m = /^[ \t]+/.exec(line);
		if (!m) {
			continue;
		}
		if (m[0].includes("\t")) {
			tabLines++;
		} else {
			spaceLines++;
		}
	}
	if (tabLines === 0 || tabLines < spaceLines) {
		return text;
	}
	const unit = 4;
	const out = lines.map((line) => {
		const m = /^( +)(\S|$)/.exec(line);
		if (!m || m[1].length % unit !== 0) {
			return line;
		}
		return "\t".repeat(m[1].length / unit) + line.slice(m[1].length);
	});
	return out.join(nl);
}
