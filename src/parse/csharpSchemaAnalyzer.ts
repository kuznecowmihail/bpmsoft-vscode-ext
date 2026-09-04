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

const CLASS_RE = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b\s*(?:<[^{]*?>)?\s*([^{]*)\{/;

/**
 * Regex-based (not a real C# parser — deliberately, see naming subsystem
 * plan) extraction of the first top-level class: its name (with position,
 * for diagnostics), everything between the name and `{` (base-type list),
 * and a window of text before the `class` keyword (for attributes like
 * `[ServiceContract]`).
 */
export function extractTopLevelClass(source: string): TopLevelClass | undefined {
	const match = CLASS_RE.exec(source);
	if (!match) {
		return undefined;
	}
	const nameStart = source.indexOf(match[1], match.index);
	const attributesBefore = source.slice(Math.max(0, match.index - 500), match.index);
	return {
		name: match[1],
		nameStart,
		nameEnd: nameStart + match[1].length,
		baseList: match[2] || "",
		attributesBefore
	};
}

/**
 * Checks a C# schema's main class against naming-guidelines.md §4: the
 * package prefix (if configured), and — only for the two roles with an
 * unambiguous platform marker — the Service/EventListener suffix.
 * `Helper`/`Manager`/`Repository`/`Client`/`Job` have no such marker and are
 * intentionally not checked (see naming subsystem plan).
 *
 * The name being *validated* is the schema's registered name — `schemaName`,
 * read from `descriptor.json` by the caller — not necessarily the literal
 * C# class identifier: the two are usually identical, but descriptor.json is
 * the platform's authoritative source of truth for every other schema type
 * (JS, SQL) already, and a substitution/override class can legitimately
 * carry its own source-level identifier. Base-type detection (`isService`/
 * `isEventListener`) still has to come from the source itself — descriptor.json
 * doesn't say what the class extends. Falls back to the source-extracted
 * class name when `schemaName` isn't available (no/unreadable descriptor.json).
 */
export function checkCsharpSchemaNaming(
	source: string,
	prefixes: string[],
	schemaName?: string
): NamingIssue[] {
	const cls = extractTopLevelClass(source);
	if (!cls) {
		return [];
	}
	const name = schemaName || cls.name;
	const issues: NamingIssue[] = [];
	const isService =
		/\bBaseService\b/.test(cls.baseList) || /\[\s*ServiceContract\b/.test(cls.attributesBefore);
	const isEventListener =
		/\bBaseEntityEventListener\b/.test(cls.baseList) ||
		/\[\s*EntityEventListener\b/.test(cls.attributesBefore);
	if (isService && !name.endsWith("Service")) {
		issues.push({
			message: `Класс «${name}»: наследует BaseService/[ServiceContract] — ожидается суффикс Service`,
			start: cls.nameStart,
			end: cls.nameEnd
		});
	}
	if (isEventListener && !name.endsWith("EventListener")) {
		issues.push({
			message: `Класс «${name}»: наследует BaseEntityEventListener/[EntityEventListener] — ожидается суффикс EventListener`,
			start: cls.nameStart,
			end: cls.nameEnd
		});
	}
	if (prefixes.length && !prefixes.some((prefix) => name.startsWith(prefix))) {
		issues.push({
			message: `Класс «${name}»: ожидается префикс пакета (${prefixes.join("/")})`,
			start: cls.nameStart,
			end: cls.nameEnd
		});
	}
	return issues;
}
