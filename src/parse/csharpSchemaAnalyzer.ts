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

/** Default `settings.roleSuffixes` — every role naming-guidelines.md §4's
 * own category table names. `Service`/`EventListener` are also separately
 * verified against the class's real base type/attribute below; the rest
 * have no such platform marker — confirmed twice now (first pass, then
 * again specifically hunting for one after the user asked to add these
 * roles too): grepping every real `.cs` file under `Schemas/` for common
 * candidate interfaces (`IBackgroundTask` was the closest lead — real, but
 * implemented inconsistently across both installs by classes actually named
 * for a *different* role — `GoGeofinServiceHelper`, `GoBulkEntityHandlerCreate`,
 * a `...EventListener` — so it's a secondary capability some Helpers/
 * Handlers/EventListeners happen to also have, not a reliable "this class
 * IS a background job" signal). So `checkRoleSuffix`/`checkSingleClassPerSchema`
 * (see `CsharpNamingSettings`) stay heuristic, opt-in checks rather than
 * verified ones like Service/EventListener. */
export const DEFAULT_ROLE_SUFFIXES = [
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

export interface CsharpNamingSettings {
	prefixes: string[];
	/** Opt-in: flag a Code that ends in none of `roleSuffixes` at all. Off by
	 * default — confirmed ~37-45% of real Source Code schemas in both
	 * installs don't end in any of the default list, and a good chunk of
	 * those are legitimately something else the guideline's table doesn't
	 * cover at all (Constants/DTO/Exception/Extensions/Callout classes, …),
	 * not a missed role suffix — so this needs a team to tune
	 * `roleSuffixes` to their own real patterns before it's worth turning
	 * on (`bpmsoft.csharpNaming.checkRoleSuffix`). */
	checkRoleSuffix: boolean;
	/** Configurable via `bpmsoft.csharpNaming.roleSuffixes` — defaults to
	 * `DEFAULT_ROLE_SUFFIXES`. Used both by `checkRoleSuffix` and by the
	 * always-on chained-suffix check below. */
	roleSuffixes: string[];
	/** Opt-in: flag a file declaring more than one top-level class. Off by
	 * default — confirmed ~26-27% of real Source Code schemas are
	 * legitimately multi-class (naming-guidelines.md's own "может быть
	 * объектная модель данных" exception for a DTO/request-response bundle
	 * living alongside the main class), so this is a team preference to opt
	 * into, not a default-on check (`bpmsoft.csharpNaming.checkSingleClassPerSchema`). */
	checkSingleClassPerSchema: boolean;
}

/** Every `roleSuffixes` entry chained at the very end of `name`, left to
 * right (e.g. `"GoGeofinServiceHelper"` → `["Service", "Helper"]`). Length
 * ≤ 1 is normal (a single role suffix, or none); length > 1 is the mixing
 * naming-guidelines.md's own last bullet asks to avoid. */
function findChainedRoleSuffixes(name: string, roleSuffixes: string[]): string[] {
	const segments = pascalCaseSegments(name);
	const chain: string[] = [];
	let cursor = segments.length;
	while (cursor > 0) {
		let matched: string | undefined;
		for (const suffix of roleSuffixes) {
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
 * with an unambiguous platform marker — see `DEFAULT_ROLE_SUFFIXES`'s own
 * doc for why the rest aren't verified the same way), the schema's
 * registered name corresponding to an actual class in the file, no
 * redundant "SourceCode" suffix (the name should reflect the class's
 * *role*, not restate that it's a source-code schema at all), no temporary/
 * placeholder designation, no chained role suffixes, and — both opt-in, see
 * `CsharpNamingSettings` — a recognizable role suffix at all, and no more
 * than one top-level class per file.
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
	settings: CsharpNamingSettings,
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
	if (settings.prefixes.length && !settings.prefixes.some((prefix) => name.startsWith(prefix))) {
		push(`Класс «${name}»: ожидается префикс пакета (${settings.prefixes.join("/")})`);
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
	const chainedSuffixes = findChainedRoleSuffixes(name, settings.roleSuffixes);
	if (chainedSuffixes.length > 1) {
		push(`Класс «${name}»: не смешивайте суффиксы ролей без необходимости (${chainedSuffixes.join(" + ")})`);
	}
	if (settings.checkRoleSuffix && settings.roleSuffixes.length && !settings.roleSuffixes.some((s) => name.endsWith(s))) {
		push(
			`Класс «${name}»: код не заканчивается ни на один известный суффикс роли (${settings.roleSuffixes.join("/")}) — по гайдлайну имя должно отражать роль класса (проверить автоматически, какая роль верна, нельзя — нет надёжного маркера для Helper/Manager/Handler/Repository/Client/Connector/Job)`
		);
	}
	if (settings.checkSingleClassPerSchema && classes.length > 1) {
		push(
			`Класс «${name}»: файл схемы содержит ${classes.length} классов верхнего уровня — по гайдлайну один класс = одна схема (обоснованное исключение — объектная модель данных)`
		);
	}

	return issues;
}
