import { IndexedMember } from "./types";

/**
 * EntitySchemaQuery column-path resolution — join-type prefixes and the
 * reverse-link bracket syntax, shared by JS (`SymbolIndex.resolveEsqColumn`)
 * and the C# ESQ support. Confirmed straight from `BPMSoft.Core.dll` via
 * reflection (not guessed from the docs' own truncated table/examples):
 *
 * - `EntitySchemaQuery.InnerJoinSpecSymbol` = `"="`
 * - `EntitySchemaQuery.LeftJoinSpecSymbol` = `">"` (same as the *default*,
 *   i.e. omitting a symbol also means LEFT OUTER JOIN — `>` just spells it
 *   out explicitly)
 * - `EntitySchemaQuery.RightJoinSpecSymbol` = `"<"`
 * - `EntitySchemaQuery.FullJoinSpecSymbol` = `"<>"`
 * - `EntitySchemaQuery.CrossJoinSpecSymbol` = `"*"`
 * - `EntitySchemaQuery._regexPathSufix` =
 *   `(?<SpecSymbol>[\<\>\=\*]{0,2})\[?(?<Sufix>[^\[\]\:\.]+)(?:\:\w+\:?\w*\])?$`
 *   — each dot-separated path segment is an optional 0-2-char join symbol,
 *   then either a plain column name or, in `[...]`, a reverse-link target.
 * - `PathUtils.RefColumnPathFormat` = `"[{0}:{1}:{2}].{3}"` — reverse link
 *   is `[ReferencedSchema:ColumnOnReferencedSchema:ColumnOnCurrentSchema]`,
 *   with the doc's own note that the current-schema column can be omitted
 *   (defaults to `"Id"`) when it's the schema's own primary key.
 */

export type EsqJoinType = "Inner" | "LeftOuter" | "RightOuter" | "FullOuter" | "Cross";

const JOIN_TYPE_BY_SYMBOL: Record<string, EsqJoinType> = {
	"": "LeftOuter",
	"=": "Inner",
	">": "LeftOuter",
	"<": "RightOuter",
	"<>": "FullOuter",
	"*": "Cross"
};

export type EsqPathSegment =
	| { joinType: EsqJoinType; kind: "forward"; columnName: string }
	| {
			joinType: EsqJoinType;
			kind: "reverse";
			/** Schema being joined in — it has the column pointing back here. */
			schemaName: string;
			/** Column on `schemaName` that references the current schema. */
			schemaLinkColumn: string;
			/** Column on the *current* schema being linked to (defaults to `"Id"`
			 * when the 2-part `[Schema:Col]` shorthand is used). */
			currentLinkColumn: string;
	  };

const BRACKET_SEGMENT_RE = /^([<>=*]{0,2})\[([^[\]:.]+):([^[\]:.]+)(?::([^[\]:.]+))?\]$/;
const PLAIN_SEGMENT_RE = /^([<>=*]{0,2})([^[\]:.]+)$/;

/** A single dot-separated path segment, already split off by `splitEsqPath`.
 * `undefined` when it doesn't match either real shape at all (a genuinely
 * malformed path — not worth guessing at). An unrecognized join-symbol
 * combination (the regex tolerates any 0-2 chars from the symbol set, but
 * only 5 real combinations exist) falls back to the real default,
 * `LeftOuter`, rather than failing the whole path over a display detail. */
export function parseEsqPathSegment(raw: string): EsqPathSegment | undefined {
	const bracket = BRACKET_SEGMENT_RE.exec(raw);
	if (bracket) {
		const [, spec, schemaName, schemaLinkColumn, currentLinkColumn] = bracket;
		return {
			joinType: JOIN_TYPE_BY_SYMBOL[spec] ?? "LeftOuter",
			kind: "reverse",
			schemaName,
			schemaLinkColumn,
			currentLinkColumn: currentLinkColumn || "Id"
		};
	}
	const plain = PLAIN_SEGMENT_RE.exec(raw);
	if (plain) {
		const [, spec, columnName] = plain;
		return { joinType: JOIN_TYPE_BY_SYMBOL[spec] ?? "LeftOuter", kind: "forward", columnName };
	}
	return undefined;
}

export function splitEsqPath(columnPath: string): string[] {
	return columnPath.split(".").filter(Boolean);
}

export interface EsqPathHop {
	/** Schema landed on after this hop. */
	schemaName: string;
	joinType: EsqJoinType;
}

export interface EsqColumnResolution {
	member: IndexedMember;
	/** One entry per schema actually joined in along the way — empty for a
	 * same-schema (no-hop) column. Doesn't include the root schema itself. */
	hops: EsqPathHop[];
}

/**
 * Resolves a full ESQ column path (`Type.Name`, `[Activity:Contact:Id].Name`,
 * `=Contact.Name`, chains of either) against `entityName`'s own columns,
 * hopping through `referenceSchemaName` for a forward segment or straight to
 * the named schema for a reverse (bracket) one. `getEntityMembers` is a
 * plain lookup callback rather than a direct `SymbolIndex` dependency, so
 * this stays a pure, independently testable module — callers (JS's
 * `SymbolIndex.resolveEsqColumn`, the C# ESQ support) supply their own.
 * `undefined` on any unresolvable hop (unknown column, unknown schema, a
 * bracket segment with nothing after it, …) — same "can't confirm it, don't
 * guess" stance as the rest of this codebase's cross-schema resolution.
 */
export function resolveEsqColumnPath(
	getEntityMembers: (schemaName: string) => IndexedMember[] | undefined,
	entityName: string,
	columnPath: string
): EsqColumnResolution | undefined {
	const rawSegments = splitEsqPath(columnPath);
	if (!rawSegments.length) {
		return undefined;
	}
	let currentSchema = entityName;
	const hops: EsqPathHop[] = [];
	let found: IndexedMember | undefined;
	for (let i = 0; i < rawSegments.length; i++) {
		const segment = parseEsqPathSegment(rawSegments[i]);
		if (!segment) {
			return undefined;
		}
		const isLast = i === rawSegments.length - 1;
		if (segment.kind === "forward") {
			const members = getEntityMembers(currentSchema);
			const member = members?.find((m) => m.name === segment.columnName);
			if (!member) {
				return undefined;
			}
			found = member;
			if (!isLast) {
				currentSchema = member.referenceSchemaName || member.name;
				hops.push({ schemaName: currentSchema, joinType: segment.joinType });
			}
		} else {
			if (isLast) {
				// A bracket hop always names a *join*, never the selected column
				// itself (see PathUtils.RefColumnPathFormat) - one with nothing
				// after it doesn't identify a column at all.
				return undefined;
			}
			currentSchema = segment.schemaName;
			hops.push({ schemaName: currentSchema, joinType: segment.joinType });
		}
	}
	return found ? { member: found, hops } : undefined;
}

/**
 * Resolves just the schema landed on after walking every segment of
 * `columnPath` — unlike `resolveEsqColumnPath`, a trailing reverse (bracket)
 * segment is fine here, since completion wants "what schema does this
 * already-typed prefix point to", not a final selected column. `columnPath`
 * of `""` (nothing typed yet) resolves to `entityName` itself. `undefined` on
 * any unresolvable hop (unknown column, unknown schema, a non-lookup forward
 * column with nothing to hop into, …).
 */
export function resolveEsqPathSchema(
	getEntityMembers: (schemaName: string) => IndexedMember[] | undefined,
	entityName: string,
	columnPath: string
): string | undefined {
	const rawSegments = splitEsqPath(columnPath);
	let currentSchema = entityName;
	for (const raw of rawSegments) {
		const segment = parseEsqPathSegment(raw);
		if (!segment) {
			return undefined;
		}
		if (segment.kind === "forward") {
			const member = getEntityMembers(currentSchema)?.find((m) => m.name === segment.columnName);
			if (!member?.referenceSchemaName) {
				return undefined;
			}
			currentSchema = member.referenceSchemaName;
		} else {
			currentSchema = segment.schemaName;
		}
	}
	return currentSchema;
}
