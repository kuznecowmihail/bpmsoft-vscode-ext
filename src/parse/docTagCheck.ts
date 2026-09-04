/**
 * Shared "is this a typo of a known doc-comment tag" detector for
 * `styleAnalyzer.ts` (JSDoc, `@tag`) and `csharpStyleAnalyzer.ts` (XML doc,
 * `<tag>`). Deliberately conservative: flags a tag only when it's a *close*
 * edit-distance match to exactly one known-good tag — real, intentional
 * tags this list doesn't happen to cover (a framework-specific one bundled
 * in vendor code, say) are far more common than genuine typos, so anything
 * not unambiguously close to a known tag is left alone rather than guessed
 * at. Confirmed against real BPMSoft schemas: `@overriden`/`@overridden` (not
 * `@override`, the only real JSDoc tag) account for ~270 occurrences across
 * one install's own custom packages alone; `inheritdocs`/`inhertidoc` (not
 * `inheritdoc`) show up a handful of times in C# too.
 */

/** Real BPMSoft/team convention on top of standard JSDoc: `@message`
 * documents a sandbox message (see schemas using `messages: {}` — e.g.
 * `@message NrbReloadEntity`). Everything else here is the actual JSDoc
 * (jsdoc.app) tag vocabulary, plus a handful of Closure-compiler/Angular
 * tags real vendor bundles under `Resources/ui` use, kept in the list so
 * they're never mistaken for a typo if such code is ever opened. */
export const KNOWN_JSDOC_TAGS: readonly string[] = [
	"abstract", "access", "alias", "arg", "argument", "async", "augments",
	"author", "borrows", "callback", "chainable", "class", "classdesc",
	"const", "constant", "constructor", "constructs", "copyright", "default",
	"defaultvalue", "deprecated", "desc", "description", "emits", "enum",
	"event", "example", "exports", "extends", "external", "file",
	"fileoverview", "fires", "func", "function", "generator", "global",
	"hideconstructor", "host", "ignore", "implements", "inheritdoc",
	"inheritDoc", "inner", "instance", "interface", "kind", "lends",
	"license", "listens", "member", "memberof", "method", "mixes", "mixin",
	"module", "name", "namespace", "override", "overview", "package",
	"param", "private", "property", "prop", "protected", "public",
	"readonly", "requires", "return", "returns", "see", "since", "static",
	"summary", "suppress", "template", "this", "throws", "todo", "tutorial",
	"type", "typedef", "var", "variation", "version", "virtual", "yield",
	"yields",
	// Team/framework extras — real, not typos.
	"message", "publicApi", "publicAPI", "codeGenApi", "usageNotes",
	"nocollapse", "internal", "security", "initializerApiFunction"
];

/** Standard C# XML documentation comment tags (Microsoft docs), plus
 * `inheritdoc` (a DocFX/Sandcastle extension, not in the base spec but
 * near-universal in real .NET code, including this codebase's own). */
export const KNOWN_XMLDOC_TAGS: readonly string[] = [
	"summary", "remarks", "returns", "value", "param", "paramref",
	"typeparam", "typeparamref", "exception", "seealso", "see", "list",
	"listheader", "item", "term", "description", "code", "c", "para",
	"example", "include", "permission", "inheritdoc", "exclude", "note"
];

function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) {
		return n;
	}
	if (n === 0) {
		return m;
	}
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i++) {
		const cur = [i];
		for (let j = 1; j <= n; j++) {
			cur[j] =
				a[i - 1] === b[j - 1]
					? prev[j - 1]
					: 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
		}
		prev = cur;
	}
	return prev[n];
}

/**
 * `undefined` when `tag` is already an exact, correctly-cased known tag, or
 * when nothing in `knownTags` is unambiguously close to it. Otherwise the
 * single known tag it most likely meant (exact case as declared in the
 * list — `inheritDoc`-style entries keep their real casing).
 */
export function nearestKnownTag(tag: string, knownTags: readonly string[]): string | undefined {
	if (knownTags.includes(tag)) {
		return undefined;
	}
	const lower = tag.toLowerCase();
	const maxDistance = lower.length <= 5 ? 1 : 2;
	let best: string | undefined;
	let bestDist = Infinity;
	let tie = false;
	for (const known of knownTags) {
		const d = levenshtein(lower, known.toLowerCase());
		if (d < bestDist) {
			bestDist = d;
			best = known;
			tie = false;
		} else if (d === bestDist && known.toLowerCase() !== best?.toLowerCase()) {
			tie = true;
		}
	}
	return best && bestDist <= maxDistance && !tie ? best : undefined;
}
