import * as prettier from "prettier";
import { collectStyleIssues } from "./styleAnalyzer";
import { applyStyleFixesToFixpoint } from "./applyFixes";

/** Prettier layout pass (K&R braces match the JS guide by default) + our own
 * fixable lint rules (var→let/const, ==→===, …). No vscode dependency. */
export async function formatJsSource(original: string): Promise<string> {
	let text = original;
	try {
		text = await prettier.format(text, {
			parser: "babel",
			useTabs: true,
			tabWidth: 4,
			printWidth: 100,
			semi: true
		});
	} catch {
		text = original;
	}
	try {
		text = applyStyleFixesToFixpoint(text, (source) => collectStyleIssues(source));
	} catch {
		// leave prettier's output as-is if our own analyzer can't parse it
	}
	return text;
}
