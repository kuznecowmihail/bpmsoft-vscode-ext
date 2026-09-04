import { findTemporaryDesignationSegment, pascalCaseSegments } from "./namingCommon";

export interface NamingIssue {
	message: string;
	start: number;
	end: number;
}

export interface TopLevelClass {
	name: string;
	nameStart: number;
	nameEnd: number;
	baseList: string;
	attributesBefore: string;
}

const CLASS_RE = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b\s*(?:<[^{]*?>)?\s*([^{]*)\{/g;

/**
 * Regex-based (not a real C# parser — deliberately, see naming subsystem
 * plan) extraction of every top-level class in the file: its name (with
 * position, for diagnostics), everything between the name and `{`
 * (base-type list), and a window of text before the `class` keyword (for
 * attributes like `[ServiceContract]`). A "Source Code" schema's own file
 * routinely declares more than one class (request/response DTOs alongside
 * the real one, or — per naming-guidelines.md's own explicit exception — a
 * whole small object model) — extracting all of them, not just the first,
 * is what lets `checkCsharpSchemaNaming` find the class that actually
 * matches the schema's registered name, wherever in the file it sits.
 */
export function extractAllTopLevelClasses(source: string): TopLevelClass[] {
	const out: TopLevelClass[] = [];
	CLASS_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = CLASS_RE.exec(source))) {
		const nameStart = source.indexOf(match[1], match.index);
		const attributesBefore = source.slice(Math.max(0, match.index - 500), match.index);
		out.push({
			name: match[1],
			nameStart,
			nameEnd: nameStart + match[1].length,
			baseList: match[2] || "",
			attributesBefore
		});
	}
	return out;
}

/** First top-level class only — kept for callers that only ever care about
 * one class (there are none left inside this module, but it's a small,
 * still-useful shorthand over `extractAllTopLevelClasses`). */
export function extractTopLevelClass(source: string): TopLevelClass | undefined {
	return extractAllTopLevelClasses(source)[0];
}

/** A role suffix the guideline recognizes (§4's own category table) —
 * chaining more than one of these at the end of a Code (`...ServiceHelper`,
 * `...ClientEventListener`) is explicitly called out as something to avoid
 * ("суффиксы не смешивать без нужды"). `Service`/`EventListener` are also
 * separately verified against the class's real base type/attribute below;
 * the rest have no such platform marker (confirmed — no common interface or
 * base class across real Helper/Manager/Handler/Repository/Client/Job
 * classes in either surveyed install), so they're only checked for this
 * chaining rule, not for whether the suffix itself is "correct". */
const ROLE_SUFFIXES = [
	"Service",
	"EventListener",
	"Helper",
	"Utils",
	"Manager",
	"Handler",
	"Repository",
	"Client",
	"Connector",
	"Job",
	"Process"
];

/** Every `ROLE_SUFFIXES` entry chained at the very end of `name`, left to
 * right (e.g. `"GoGeofinServiceHelper"` → `["Service", "Helper"]`). Length
 * ≤ 1 is normal (a single role suffix, or none); length > 1 is the mixing
 * naming-guidelines.md's own last bullet asks to avoid. */
function findChainedRoleSuffixes(name: string): string[] {
	const segments = pascalCaseSegments(name);
	const chain: string[] = [];
	let cursor = segments.length;
	while (cursor > 0) {
		let matched: string | undefined;
		for (const suffix of ROLE_SUFFIXES) {
			const suffixSegments = pascalCaseSegments(suffix);
			const sliceStart = cursor - suffixSegments.length;
			if (sliceStart >= 0 && segments.slice(sliceStart, cursor).join("") === suffix) {
				matched = suffix;
				cursor = sliceStart;
				break;
			}
		}
		if (!matched) {
			break;
		}
		chain.unshift(matched);
	}
	return chain;
}

/**
 * Checks a C# schema's main class against naming-guidelines.md §4: the
 * package prefix, the Service/EventListener suffix (only for the two roles
 * with an unambiguous platform marker — see `ROLE_SUFFIXES`'s own doc for
 * why the rest aren't), the schema's registered name corresponding to an
 * actual class in the file, no redundant "SourceCode" suffix (the name
 * should reflect the class's *role*, not restate that it's a source-code
 * schema at all), no temporary/placeholder designation, and no chained role
 * suffixes.
 *
 * The name being *validated* is the schema's registered name — `schemaName`,
 * read from `descriptor.json` by the caller — not necessarily the literal
 * C# class identifier: the two are usually identical, but descriptor.json is
 * the platform's authoritative source of truth for every other schema type
 * (JS, SQL) already, and a substitution/override class can legitimately
 * carry its own source-level identifier. Falls back to the first
 * source-extracted class name when `schemaName` isn't available (no/
 * unreadable descriptor.json), and returns `[]` outright when the file
 * declares no class at all (an enum/interface-only file — outside what this
 * class-naming check can reason about).
 */
export function checkCsharpSchemaNaming(
	source: string,
	prefixes: string[],
	schemaName?: string
): NamingIssue[] {
	const classes = extractAllTopLevelClasses(source);
	if (classes.length === 0) {
		return [];
	}
	const name = schemaName || classes[0].name;
	// The class whose own name matches the schema's registered name — same
	// class in the overwhelming majority of files (one class per file), but
	// in a multi-class file the matching class isn't always textually first
	// (e.g. a family of sibling event listeners sharing one file, where the
	// schema-named one comes last) — falls back to the first class so a
	// schema with no matching class at all still gets a real position to
	// anchor its findings on.
	const mainClass = classes.find((c) => c.name === name) || classes[0];
	const issues: NamingIssue[] = [];
	const push = (message: string) =>
		issues.push({ message, start: mainClass.nameStart, end: mainClass.nameEnd });

	const isService =
		/\bBaseService\b/.test(mainClass.baseList) || /\[\s*ServiceContract\b/.test(mainClass.attributesBefore);
	const isEventListener =
		/\bBaseEntityEventListener\b/.test(mainClass.baseList) ||
		/\[\s*EntityEventListener\b/.test(mainClass.attributesBefore);
	if (isService && !name.endsWith("Service")) {
		push(`Класс «${name}»: наследует BaseService/[ServiceContract] — ожидается суффикс Service`);
	}
	if (isEventListener && !name.endsWith("EventListener")) {
		push(`Класс «${name}»: наследует BaseEntityEventListener/[EntityEventListener] — ожидается суффикс EventListener`);
	}
	if (prefixes.length && !prefixes.some((prefix) => name.startsWith(prefix))) {
		push(`Класс «${name}»: ожидается префикс пакета (${prefixes.join("/")})`);
	}
	if (!classes.some((c) => c.name === name)) {
		push(
			`Класс «${name}»: имя схемы не совпадает ни с одним классом в файле — переименуйте схему или класс (обоснованное исключение — объектная модель данных без единого «главного» класса)`
		);
	}
	if (name.endsWith("SourceCode")) {
		push(`Класс «${name}»: суффикс "SourceCode" избыточен — имя должно отражать роль класса, а не то, что это исходный код`);
	}
	const tempSegment = findTemporaryDesignationSegment(name);
	if (tempSegment) {
		push(`Класс «${name}»: избегайте временных обозначений ("${tempSegment}") в имени схемы`);
	}
	const chainedSuffixes = findChainedRoleSuffixes(name);
	if (chainedSuffixes.length > 1) {
		push(`Класс «${name}»: не смешивайте суффиксы ролей без необходимости (${chainedSuffixes.join(" + ")})`);
	}

	return issues;
}
