import { SymbolIndex } from "../index/SymbolIndex";
import { DATA_VALUE_TYPE_NAMES } from "../index/ViewControlsIndex";
import { RULE_PROPERTY_CODE_NAMES, RULE_TYPE_CODE_NAMES, normalizeRuleCode } from "./businessRuleDescription";

/**
 * Maps a coded field's raw literal value (e.g. `"5"` for `contentType: 5`)
 * back to its symbolic `BPMSoft.*`/`BusinessRuleModule.enums.*` constant —
 * the reverse of what a developer would normally read off the completion
 * list. Used by `EnumInlayHintsProvider.ts`, `HoverProvider.ts`, and
 * `EnumLiteralCodeActionProvider.ts` so all three agree on one resolution.
 *
 * Two lookup strategies, deliberately kept separate:
 * - hardcoded tables (`dataValueType`/`itemType`/the two rule fields) —
 *   always available, even with `bpmsoft.enablePlatformStubs` off, and
 *   version-stable enough to hardcode (see each table's own comment for its
 *   confirmed source).
 * - a dynamic fallback (`contentType`/`comparisonType`) sourced from the
 *   real `BPMSoft.<Enum> = {...}` object literal in the user's own install
 *   (`SymbolIndex.resolvePlatformEnumMemberName`, backed by
 *   `buildPlatformStubs`) — used for enums this hasn't independently
 *   confirmed a numeric table for, so it never guesses at one.
 */
export interface EnumFieldHint {
	/** Dotted symbolic form a developer would write, e.g.
	 * `"BPMSoft.ContentType.LOOKUP"`. */
	symbol: string;
	/** Just the member name, e.g. `"LOOKUP"`. */
	memberName: string;
}

// Confirmed straight from the enum's own source — `Resources/ui/BPMSoft/
// core/enums/sysenums.js`'s `BPMSoft.ViewItemType = {...}` — see CLAUDE.md
// §4b's diff `values.itemType` writeup for the full confirmed list.
const VIEW_ITEM_TYPE_NAMES: Record<number, string> = {
	0: "GRID_LAYOUT",
	1: "TAB_PANEL",
	2: "DETAIL",
	3: "MODEL_ITEM",
	4: "MODULE",
	5: "BUTTON",
	6: "LABEL",
	7: "CONTAINER",
	8: "MENU",
	9: "MENU_ITEM",
	10: "MENU_SEPARATOR",
	11: "SECTION_VIEWS",
	12: "SECTION_VIEW",
	13: "GRID",
	14: "SCHEDULE_EDIT",
	15: "CONTROL_GROUP",
	16: "RADIO_GROUP",
	17: "DESIGN_VIEW",
	18: "COLOR_BUTTON",
	19: "IMAGE_TAB_PANEL",
	20: "HYPERLINK",
	21: "INFORMATION_BUTTON",
	22: "TIP",
	23: "COMPONENT",
	24: "TIP_LABEL",
	30: "PROGRESS_BAR",
	31: "GRID_LAYOUT_EDIT",
	32: "IFRAMECONTROL",
	33: "EXTERNAL_WIDGET"
};

function stringifyKeys(table: Record<number, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of Object.keys(table)) {
		out[key] = table[Number(key)];
	}
	return out;
}

const GENERIC_HARDCODED: Record<string, { enumName: string; names: Record<string, string> }> = {
	dataValueType: { enumName: "DataValueType", names: stringifyKeys(DATA_VALUE_TYPE_NAMES) },
	itemType: { enumName: "ViewItemType", names: stringifyKeys(VIEW_ITEM_TYPE_NAMES) }
};

/** Field name → simple `BPMSoft.*` enum name, for the dynamic (platform
 * stub tree) fallback path — anything not confirmed as a hardcoded table
 * above. */
const GENERIC_DYNAMIC_FIELD_TO_ENUM: Record<string, string> = {
	contentType: "ContentType",
	comparisonType: "ComparisonType"
};

/** Every field name this module knows how to resolve generically (i.e.
 * anywhere in a schema, no enclosing-rule-object check needed) — lets
 * callers cheaply test "is this key even worth resolving" before parsing
 * out the rest of the context. */
export const GENERIC_ENUM_FIELD_NAMES: ReadonlySet<string> = new Set([
	...Object.keys(GENERIC_HARDCODED),
	...Object.keys(GENERIC_DYNAMIC_FIELD_TO_ENUM)
]);

/** Generic — resolvable anywhere in a schema. `index` is only consulted for
 * fields with no hardcoded table (and only when platform stubs are built —
 * see `SymbolIndex.resolvePlatformEnumMemberName`). */
export function resolveGenericEnumField(
	index: SymbolIndex,
	fieldName: string,
	rawValue: string
): EnumFieldHint | undefined {
	const hardcoded = GENERIC_HARDCODED[fieldName];
	if (hardcoded) {
		const memberName = hardcoded.names[rawValue];
		return memberName ? { symbol: `BPMSoft.${hardcoded.enumName}.${memberName}`, memberName } : undefined;
	}
	const enumName = GENERIC_DYNAMIC_FIELD_TO_ENUM[fieldName];
	if (!enumName) {
		return undefined;
	}
	const memberName = index.resolvePlatformEnumMemberName(enumName, rawValue);
	return memberName ? { symbol: `BPMSoft.${enumName}.${memberName}`, memberName } : undefined;
}

/**
 * Rule-scoped fields (`ruleType`/`property` inside a `rules`/`businessRules`
 * rule-config object) — deliberately **not** exposed through
 * `resolveGenericEnumField`, since `property` in particular is too generic a
 * key name to safely recognize outside a confirmed rule-object context; the
 * caller (the inlay-hints/hover/quick-fix providers, which already walk
 * `rules`/`businessRules` to build the rule description) is what confirms
 * that context. `ruleTypeRaw` is the sibling `ruleType` field's own raw
 * preview — `property` only means something when the rule normalizes to
 * BINDPARAMETER (the platform's own documented caveat), so it's otherwise
 * skipped rather than shown misleadingly.
 */
export function resolveRuleEnumField(
	fieldName: "ruleType" | "property",
	rawValue: string,
	ruleTypeRaw?: string
): EnumFieldHint | undefined {
	if (fieldName === "ruleType") {
		const memberName = RULE_TYPE_CODE_NAMES[rawValue];
		return memberName
			? { symbol: `BusinessRuleModule.enums.RuleType.${memberName}`, memberName }
			: undefined;
	}
	if (normalizeRuleCode(ruleTypeRaw, RULE_TYPE_CODE_NAMES) !== "BINDPARAMETER") {
		return undefined;
	}
	const memberName = RULE_PROPERTY_CODE_NAMES[rawValue];
	return memberName
		? { symbol: `BusinessRuleModule.enums.Property.${memberName}`, memberName }
		: undefined;
}
