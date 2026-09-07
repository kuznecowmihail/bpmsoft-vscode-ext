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

interface EsqPathSegmentSpan {
	raw: string;
	/** Offset of `raw`'s first character within the full `columnPath`. */
	start: number;
}

/** Same segments as `splitEsqPath`, plus each one's own start offset within
 * `columnPath` - needed to figure out which segment a hover/cursor offset
 * actually lands in. Empty segments (consecutive/leading/trailing dots) are
 * skipped, matching `splitEsqPath`, but the dot itself still counts toward
 * offsets so real segments keep their true document position. */
function splitEsqPathWithOffsets(columnPath: string): EsqPathSegmentSpan[] {
	const out: EsqPathSegmentSpan[] = [];
	let offset = 0;
	for (const part of columnPath.split(".")) {
		if (part.length) {
			out.push({ raw: part, start: offset });
		}
		offset += part.length + 1;
	}
	return out;
}

interface EsqBracketSpans {
	schemaStart: number;
	schemaEnd: number;
	schemaLinkColumnStart: number;
	schemaLinkColumnEnd: number;
	currentLinkColumnStart?: number;
	currentLinkColumnEnd?: number;
}

/** Offsets of each colon-part *within `raw`* (a single bracket segment, e.g.
 * `[VwSysAdminUnit:Id:SysUser]`) - derived directly from the matched groups'
 * own lengths rather than re-scanning, since `BRACKET_SEGMENT_RE` is
 * anchored/exhaustive: every character belongs to exactly one group or one
 * of the fixed `[`/`:`/`]` literals between them, in a fixed order. */
function computeBracketSpans(raw: string): EsqBracketSpans | undefined {
	const m = BRACKET_SEGMENT_RE.exec(raw);
	if (!m) {
		return undefined;
	}
	const [, spec, schemaName, schemaLinkColumn, currentLinkColumn] = m;
	const schemaStart = spec.length + 1; // skip spec + "["
	const schemaEnd = schemaStart + schemaName.length;
	const schemaLinkColumnStart = schemaEnd + 1; // skip ":"
	const schemaLinkColumnEnd = schemaLinkColumnStart + schemaLinkColumn.length;
	if (!currentLinkColumn) {
		return { schemaStart, schemaEnd, schemaLinkColumnStart, schemaLinkColumnEnd };
	}
	const currentLinkColumnStart = schemaLinkColumnEnd + 1; // skip ":"
	const currentLinkColumnEnd = currentLinkColumnStart + currentLinkColumn.length;
	return {
		schemaStart,
		schemaEnd,
		schemaLinkColumnStart,
		schemaLinkColumnEnd,
		currentLinkColumnStart,
		currentLinkColumnEnd
	};
}

export type EsqPathHoverTarget =
	| { kind: "schema"; schemaName: string; start: number; end: number }
	| {
			kind: "column";
			/** Schema the hovered column actually lives on - the joined
			 * schema for a bracket's own link column, the schema *before* the
			 * hop for a plain forward segment or a bracket's current-schema
			 * link column. */
			schemaName: string;
			member: IndexedMember;
			start: number;
			end: number;
	  };

/**
 * Which real element of `columnPath` sits at `offset` (a character offset
 * *within* `columnPath` itself, not the document) - the position-aware
 * counterpart to `resolveEsqColumnPath`'s "resolve the whole path to its
 * final column" (used by hover, so it can show the schema under the cursor
 * when hovering `VwSysAdminUnit` in `[VwSysAdminUnit:Id:SysUser].Id`, the
 * join-target column when hovering the first `Id`, the current-schema
 * column when hovering `SysUser`, and the final `Id` as an ordinary column
 * of `VwSysAdminUnit` once past the `]`). `undefined` when `offset` doesn't
 * land inside any real name (join-symbol/`[`/`:`/`]`/`.` punctuation, or an
 * unresolvable hop) - callers fall back to the whole-path resolution in
 * that case rather than showing nothing.
 */
export function resolveEsqPathAtOffset(
	getEntityMembers: (schemaName: string) => IndexedMember[] | undefined,
	entityName: string,
	columnPath: string,
	offset: number
): EsqPathHoverTarget | undefined {
	const segments = splitEsqPathWithOffsets(columnPath);
	let currentSchema = entityName;
	for (const { raw, start } of segments) {
		const end = start + raw.length;
		const withinSegment = offset >= start && offset <= end;
		const segment = parseEsqPathSegment(raw);
		if (!segment) {
			return undefined;
		}
		if (segment.kind === "forward") {
			if (withinSegment) {
				const member = getEntityMembers(currentSchema)?.find(
					(m) => m.name === segment.columnName
				);
				return member
					? { kind: "column", schemaName: currentSchema, member, start, end }
					: undefined;
			}
			const member = getEntityMembers(currentSchema)?.find(
				(m) => m.name === segment.columnName
			);
			if (!member) {
				return undefined;
			}
			currentSchema = member.referenceSchemaName || member.name;
			continue;
		}
		if (withinSegment) {
			const spans = computeBracketSpans(raw);
			if (!spans) {
				return undefined;
			}
			const rel = offset - start;
			if (rel >= spans.schemaStart && rel <= spans.schemaEnd) {
				return {
					kind: "schema",
					schemaName: segment.schemaName,
					start: start + spans.schemaStart,
					end: start + spans.schemaEnd
				};
			}
			if (rel >= spans.schemaLinkColumnStart && rel <= spans.schemaLinkColumnEnd) {
				const member = getEntityMembers(segment.schemaName)?.find(
					(m) => m.name === segment.schemaLinkColumn
				);
				return member
					? {
							kind: "column",
							schemaName: segment.schemaName,
							member,
							start: start + spans.schemaLinkColumnStart,
							end: start + spans.schemaLinkColumnEnd
						}
					: undefined;
			}
			if (
				spans.currentLinkColumnStart !== undefined &&
				rel >= spans.currentLinkColumnStart &&
				rel <= spans.currentLinkColumnEnd!
			) {
				const member = getEntityMembers(currentSchema)?.find(
					(m) => m.name === segment.currentLinkColumn
				);
				return member
					? {
							kind: "column",
							schemaName: currentSchema,
							member,
							start: start + spans.currentLinkColumnStart,
							end: start + spans.currentLinkColumnEnd!
						}
					: undefined;
			}
			// Landed on punctuation inside the brackets (spec chars, `[`,
			// `:`, `]`) - nothing meaningful to show.
			return undefined;
		}
		currentSchema = segment.schemaName;
	}
	return undefined;
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

/**
 * Detects "still typing a `[Schema:Col:Col]` reverse-link segment" (this is
 * completion's own concern — a segment mid-edit, unlike everything above
 * this, which only ever deals with a segment already fully written) and
 * which of the three colon-separated parts is currently being typed —
 * schema name, the schema's own link column, or (rarer — a 2-part
 * `[Schema:Col]` already covers the common case, defaulting the
 * current-schema column to `"Id"`) the current schema's link column.
 * `undefined` when the path's last dot-segment isn't inside an *unclosed*
 * bracket at all (a plain column name, or a bracket segment already closed
 * with `]`).
 */
export interface EsqBracketContext {
	stage: "schema" | "schemaLinkColumn" | "currentLinkColumn";
	/** Already-typed, complete colon-parts before the one being completed. */
	rawSegs: string[];
	/** The in-progress part being completed (may be empty). */
	prefix: string;
	/** 0-2 char join-type symbol before the `[`, e.g. `"="`, `">"`, `""`. */
	joinPrefix: string;
	/** Dot-segments before this one - already-resolved path prefix. */
	parentSegments: string[];
}

const BRACKET_IN_PROGRESS_RE = /^([<>=*]{0,2})\[([^[\]]*)$/;

export function getEsqBracketContext(fullName: string): EsqBracketContext | undefined {
	const parts = fullName.split(".");
	const last = parts[parts.length - 1] || "";
	const m = BRACKET_IN_PROGRESS_RE.exec(last);
	if (!m) {
		return undefined;
	}
	const [, joinPrefix, inner] = m;
	const rawSegs = inner.split(":");
	const stage: EsqBracketContext["stage"] =
		rawSegs.length <= 1 ? "schema" : rawSegs.length === 2 ? "schemaLinkColumn" : "currentLinkColumn";
	return {
		stage,
		rawSegs: rawSegs.slice(0, -1),
		prefix: rawSegs[rawSegs.length - 1] || "",
		joinPrefix,
		parentSegments: parts.slice(0, -1).filter(Boolean)
	};
}

/** A column usable as the *current*-schema side of a reverse link
 * (`currentLinkColumn` — `[Schema:Col:THIS]`) — per real ESQ semantics, that
 * can only ever be `Id` or a lookup/reference column, since anything else
 * has no foreign-key-shaped value another schema's own column could point
 * back at. Also reused to sanity-check a `schemaLinkColumn` candidate before
 * checking whether it specifically references the current schema (below) —
 * a column that isn't link-shaped at all can't reference anything. */
export function isEsqLinkableColumn(member: IndexedMember): boolean {
	return (
		member.name === "Id" ||
		Boolean(member.referenceSchemaName) ||
		Boolean(member.children?.length) ||
		member.dataValueType === "BPMSoft.DataValueType.LOOKUP"
	);
}

export type EsqBracketCandidates =
	| { kind: "schema"; names: string[] }
	| { kind: "column"; schemaName: string; members: IndexedMember[] };

/**
 * Real candidates for whichever `EsqBracketContext.stage` is in progress —
 * the position-aware completion counterpart to the parsing/resolution
 * functions above. `currentSchemaCandidates` is the schema (or, when the
 * root query's own entity is itself ambiguous, several) the bracket hops
 * *from* — resolved by the caller via `resolveEsqPathSchema` against
 * `bracket.parentSegments` when non-empty, else the root entity/entities.
 *
 * - `schema` stage: every entity name matching `bracket.prefix`, *if* the
 *   prefix is non-empty. With nothing typed yet this would mean scanning
 *   every known entity's own columns just to answer "which ones can link
 *   back here" — measured at several seconds across a real, ~2500-entity
 *   install — so an empty prefix intentionally returns the *unfiltered*
 *   list instead of paying that cost on literally the first keystroke;
 *   filtering kicks in the moment the user types even one character (the
 *   resulting candidate set is then always small enough to check inline,
 *   under half a second cold even for a single common letter).
 *   Filtering itself: keep only entities with a column whose
 *   `referenceSchemaName` is one of `currentSchemaCandidates` - i.e. an
 *   entity actually reachable by a reverse link from here. Known gap:
 *   `referenceSchemaName` isn't recoverable from Pkg-metadata-sourced
 *   columns at all (see `entityMetadata.ts#parsePkgEntityColumns` — the
 *   raw D2 block has no confirmed field for a lookup's *target* schema),
 *   so a custom entity that only qualifies via such a column won't be
 *   suggested here; the same gap already limits forward-hop resolution
 *   elsewhere in this file.
 * - `schemaLinkColumn` stage: `bracket.rawSegs[0]`'s (the schema chosen at
 *   the `schema` stage) own columns, filtered to `isEsqLinkableColumn` ones
 *   whose `referenceSchemaName` is actually one of `currentSchemaCandidates`
 *   — the column real enough to carry the join, i.e. `Contact.Account` when
 *   linking back to `Account`, not just any column on `Contact`.
 * - `currentLinkColumn` stage: the union of `currentSchemaCandidates`' own
 *   `isEsqLinkableColumn` columns (no back-reference check needed here —
 *   this side supplies the value the other side's lookup points *at*, so
 *   any `Id`/lookup column on the current schema is a legitimate choice,
 *   most commonly `Id` itself).
 */
export function resolveEsqBracketCandidates(
	bracket: EsqBracketContext,
	currentSchemaCandidates: string[],
	listEntityNames: (prefix: string) => string[],
	getEntityMembers: (schemaName: string) => IndexedMember[] | undefined
): EsqBracketCandidates {
	if (bracket.stage === "schema") {
		const names = listEntityNames(bracket.prefix);
		if (!bracket.prefix) {
			return { kind: "schema", names };
		}
		const filtered = names.filter((name) =>
			getEntityMembers(name)?.some(
				(m) => m.referenceSchemaName && currentSchemaCandidates.includes(m.referenceSchemaName)
			)
		);
		return { kind: "schema", names: filtered };
	}
	if (bracket.stage === "schemaLinkColumn") {
		const schemaName = bracket.rawSegs[0];
		const members = (getEntityMembers(schemaName) || []).filter(
			(m) =>
				isEsqLinkableColumn(m) &&
				m.referenceSchemaName &&
				currentSchemaCandidates.includes(m.referenceSchemaName)
		);
		return { kind: "column", schemaName, members };
	}
	const byName = new Map<string, IndexedMember>();
	for (const schemaName of currentSchemaCandidates) {
		for (const m of getEntityMembers(schemaName) || []) {
			if (isEsqLinkableColumn(m)) {
				byName.set(m.name, m);
			}
		}
	}
	return { kind: "column", schemaName: currentSchemaCandidates[0] || "", members: [...byName.values()] };
}
