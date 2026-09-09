import { AnyNode } from "./jsAst";

/**
 * Shared "what does this rule do" engine for `rules`/`businessRules` entries
 * (`{ AttrName: { RuleId: {...} } }`, see CLAUDE.md §4b/§6) — used by the
 * "Бизнес-правила" Outline section (`amdAst.ts`'s `collectBusinessRuleMembers`),
 * the editor hover, the always-on inlay hint, and the GUID-rule-id rename
 * quick-fix (`schemaUsageAnalyzer.ts`). Kept free of any `SymbolIndex`/
 * workspace dependency so it works the same from a pure-AST context (the
 * naming quick-fix has no index available) as from a context that does have
 * one (the hover/inlay-hints providers, which can pass `resolveComparisonType`
 * for a fully symbolic `comparisonType` label).
 */

/** Small local AST-property helpers, deliberately duplicated from
 * `amdAst.ts`'s own private equivalents rather than imported — `amdAst.ts`
 * needs this module's rule tables/description functions (see its
 * `collectBusinessRuleMembers`), so importing back from `amdAst.ts` here
 * would create a cycle. Each is a few lines and unlikely to drift. */
function localPropName(prop: AnyNode): string | undefined {
	const key = prop?.key as AnyNode | undefined;
	if (key?.type === "Identifier") {
		return key.name as string;
	}
	if (key?.type === "Literal" && typeof key.value === "string") {
		return key.value;
	}
	return undefined;
}

function localExprPreview(node: AnyNode | undefined, depth = 0): string | undefined {
	if (!node || depth > 6) {
		return undefined;
	}
	if (node.type === "Literal") {
		return node.value === null ? "null" : String(node.value);
	}
	if (node.type === "Identifier") {
		return node.name as string;
	}
	if (node.type === "MemberExpression" && !node.computed) {
		const obj = localExprPreview(node.object as AnyNode, depth + 1);
		const prop = (node.property as AnyNode)?.name as string | undefined;
		if (obj && prop) {
			return `${obj}.${prop}`;
		}
	}
	return undefined;
}

function propExprPreview(obj: AnyNode | undefined, key: string): string | undefined {
	if (!obj || obj.type !== "ObjectExpression") {
		return undefined;
	}
	for (const p of obj.properties as AnyNode[]) {
		if (localPropName(p) === key) {
			return localExprPreview(p.value as AnyNode);
		}
	}
	return undefined;
}

function rawPropValue(obj: AnyNode | undefined, key: string): AnyNode | undefined {
	if (!obj || obj.type !== "ObjectExpression") {
		return undefined;
	}
	for (const p of obj.properties as AnyNode[]) {
		if (localPropName(p) === key) {
			return p.value as AnyNode;
		}
	}
	return undefined;
}

// Authoritative, straight from the enum's own source —
// `conf\content\BusinessRuleModule.js`'s own `var enums = {Property: {...},
// RuleType: {...}}` — see CLAUDE.md §4b. Not derived from a guess.
export const RULE_TYPE_CODE_NAMES: Record<string, string> = {
	"-1": "DISABLED",
	"0": "BINDPARAMETER",
	"1": "FILTRATION",
	"2": "AUTOCOMPLETE",
	"3": "POPULATE_ATTRIBUTE"
};
export const RULE_PROPERTY_CODE_NAMES: Record<string, string> = {
	"0": "VISIBLE",
	"1": "ENABLED",
	"2": "REQUIRED",
	"3": "READONLY"
};
/** Ordered so the "available" list reads in the same order the platform
 * declares them, not alphabetically. */
export const ALL_RULE_PROPERTY_NAMES = ["VISIBLE", "ENABLED", "REQUIRED", "READONLY"];

/** `preview` → `"NAME (preview)"` when `names` recognizes it, else the raw
 * preview unchanged (still informative — a symbolic constant preview like
 * `BusinessRuleModule.enums.RuleType.FILTRATION` already reads fine as-is). */
export function describeRuleCode(preview: string | undefined, names: Record<string, string>): string | undefined {
	if (!preview) {
		return undefined;
	}
	const mapped = names[preview];
	return mapped ? `${mapped} (${preview})` : preview;
}

/** Resolves a rule's `ruleType`/`property` to its canonical enum name
 * regardless of which authoring path produced it: the Designer's numeric
 * code ("2") via `codeNames`, or hand-written `rules`' own symbolic constant
 * ("BusinessRuleModule.enums.Property.REQUIRED", matched by its trailing
 * identifier) — both mean the same thing, just spelled differently. */
export function normalizeRuleCode(preview: string | undefined, codeNames: Record<string, string>): string | undefined {
	if (!preview) {
		return undefined;
	}
	const direct = codeNames[preview];
	if (direct) {
		return direct;
	}
	const tail = preview.slice(preview.lastIndexOf(".") + 1);
	return Object.values(codeNames).includes(tail) ? tail : undefined;
}

function shortIdent(preview: string): string {
	return preview.slice(preview.lastIndexOf(".") + 1);
}

function describeComparisonType(
	raw: string | undefined,
	resolveComparisonType?: (rawValue: string) => string | undefined
): string | undefined {
	if (!raw) {
		return undefined;
	}
	if (/^-?\d+$/.test(raw)) {
		return resolveComparisonType?.(raw) ?? `код ${raw}`;
	}
	return shortIdent(raw);
}

function describeOperand(node: AnyNode | undefined): string | undefined {
	if (!node || node.type !== "ObjectExpression") {
		return undefined;
	}
	const attribute = propExprPreview(node, "attribute");
	if (attribute) {
		return shortIdent(attribute);
	}
	const value = propExprPreview(node, "value");
	return value;
}

function describeSingleCondition(
	cond: AnyNode | undefined,
	resolveComparisonType?: (rawValue: string) => string | undefined
): string | undefined {
	if (!cond || cond.type !== "ObjectExpression") {
		return undefined;
	}
	const left = describeOperand(rawPropValue(cond, "leftExpression"));
	const right = describeOperand(rawPropValue(cond, "rightExpression"));
	const comparison = describeComparisonType(propExprPreview(cond, "comparisonType"), resolveComparisonType);
	if (!left && !right && !comparison) {
		return undefined;
	}
	return [left, comparison, right].filter(Boolean).join(" ");
}

/**
 * Best-effort natural-language(ish) rendering of a rule's own condition
 * fields — deliberately conservative: an unrecognized shape omits the
 * clause instead of guessing at semantics this hasn't confirmed. Two real
 * shapes are handled (CLAUDE.md's `rules` section):
 * - FILTRATION/AUTOCOMPLETE-style: `attribute`/`baseAttributePatch`/
 *   `comparisonType` directly on the rule object (which field plays which
 *   role swaps between the two rule types, so this reports both rather
 *   than asserting a direction).
 * - BINDPARAMETER-style: a `conditions` array of `{leftExpression,
 *   comparisonType, rightExpression}` clauses, ESQ-filter-shaped.
 */
export function describeRuleCondition(
	ruleObj: AnyNode | undefined,
	resolveComparisonType?: (rawValue: string) => string | undefined
): string | undefined {
	if (!ruleObj || ruleObj.type !== "ObjectExpression") {
		return undefined;
	}
	const attribute = propExprPreview(ruleObj, "attribute");
	const baseAttributePatch = propExprPreview(ruleObj, "baseAttributePatch");
	if (attribute || baseAttributePatch) {
		const comparison = describeComparisonType(propExprPreview(ruleObj, "comparisonType"), resolveComparisonType);
		const parts = [
			attribute ? `attribute: ${shortIdent(attribute)}` : undefined,
			comparison ? `comparisonType: ${comparison}` : undefined,
			baseAttributePatch ? `baseAttributePatch: ${shortIdent(baseAttributePatch)}` : undefined
		].filter((p): p is string => !!p);
		return parts.length ? parts.join(", ") : undefined;
	}
	const conditionsNode = rawPropValue(ruleObj, "conditions");
	if (conditionsNode?.type === "ArrayExpression") {
		const clauses = (conditionsNode.elements as AnyNode[])
			.map((el) => describeSingleCondition(el, resolveComparisonType))
			.filter((s): s is string => !!s);
		if (clauses.length) {
			return clauses.join(" И ");
		}
	}
	return undefined;
}

export interface RuleDescription {
	/** Compact, inlay-hint-length summary. */
	short: string;
	/** Full Markdown text for a hover/tooltip. */
	full: string;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Combines ruleType + property (only shown for BINDPARAMETER rules, per
 * the platform's own documented caveat that `property` is meaningless for
 * FILTRATION/AUTOCOMPLETE/POPULATE_ATTRIBUTE) with the best-effort
 * condition clause into one short label and one fuller Markdown blurb. */
export function describeRule(
	ruleObj: AnyNode | undefined,
	resolveComparisonType?: (rawValue: string) => string | undefined
): RuleDescription {
	const ruleTypeRaw = propExprPreview(ruleObj, "ruleType");
	const propertyRaw = propExprPreview(ruleObj, "property");
	const ruleTypeName = normalizeRuleCode(ruleTypeRaw, RULE_TYPE_CODE_NAMES);
	const ruleType = describeRuleCode(ruleTypeRaw, RULE_TYPE_CODE_NAMES);
	const property = ruleTypeName === "BINDPARAMETER" ? describeRuleCode(propertyRaw, RULE_PROPERTY_CODE_NAMES) : undefined;
	const condition = describeRuleCondition(ruleObj, resolveComparisonType);
	const head = [ruleType, property].filter(Boolean).join(" · ") || "правило";
	const short = condition ? `${head} — ${truncate(condition, 60)}` : head;
	const full = condition ? `**${head}**\n\n${condition}` : `**${head}**`;
	return { short, full };
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exact match — a rule-id key is either a whole GUID (Designer-autogenerated,
 * never renamed) or a symbolic name a developer chose, never a mix. */
export function isGuidLikeName(name: string): boolean {
	return GUID_RE.test(name);
}

function toPascal(name: string): string {
	return name
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
		.join("");
}

/** Deterministic replacement name for a GUID-shaped rule-id key — built from
 * what the rule actually does, not the developer's intent (which this has no
 * way to know), so it's meant as a much better starting point than a raw
 * GUID rather than a final answer. */
export function slugifyRuleName(ruleObj: AnyNode | undefined, attrName: string): string {
	const ruleTypeRaw = propExprPreview(ruleObj, "ruleType");
	const propertyRaw = propExprPreview(ruleObj, "property");
	const ruleTypeName = normalizeRuleCode(ruleTypeRaw, RULE_TYPE_CODE_NAMES);
	const propertyName = normalizeRuleCode(propertyRaw, RULE_PROPERTY_CODE_NAMES);
	const head = toPascal(propertyName || ruleTypeName || "Rule");
	const attr = toPascal(attrName) || "Attr";
	return `${head}_${attr}`;
}
