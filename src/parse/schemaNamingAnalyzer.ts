import { NamingIssue, TEMP_DESIGNATION_WORDS, pascalCaseSegments } from "./namingCommon";

export interface ClientSchemaNamingSettings {
	prefixes: string[];
	/** Off by default — real data shows only ~20-25% of Module-type schemas
	 * that aren't already Mixin/Css actually end in "Module" (the rest are
	 * Helper/Constants/Container/Override/... — an open role vocabulary, same
	 * situation as the C# `checkRoleSuffix` opt-in). */
	checkModuleSuffix: boolean;
}

/**
 * Only these SchemaType enum values (as returned by
 * `SchemaHierarchyResolver.resolveSchemaType`) reliably map to a single
 * naming-guidelines.md suffix family. Plain `MODULE` (Modules, Mixins,
 * Constants, Css schemas) is handled separately by `checkModuleTypeNaming`,
 * which has its own, structural way of telling those apart.
 */
const PAGE_FAMILY_SUFFIXES = ["Page", "PageV2", "MiniPage", "ModalPage"];
const SECTION_FAMILY_SUFFIXES = ["Section", "SectionV2"];
const DETAIL_FAMILY_SUFFIXES = ["Detail", "DetailV2"];

const SUFFIXES_BY_SCHEMA_TYPE: Record<string, string[]> = {
	EDIT_VIEW_MODEL_SCHEMA: PAGE_FAMILY_SUFFIXES,
	MODULE_VIEW_MODEL_SCHEMA: SECTION_FAMILY_SUFFIXES,
	GRID_DETAIL_VIEW_MODEL_SCHEMA: DETAIL_FAMILY_SUFFIXES,
	DETAIL_VIEW_MODEL_SCHEMA: DETAIL_FAMILY_SUFFIXES,
	EDIT_CONTROLS_DETAIL_VIEW_MODEL_SCHEMA: DETAIL_FAMILY_SUFFIXES,
	GRID_EDIT_DETAIL_VIEW_MODEL_SCHEMA: DETAIL_FAMILY_SUFFIXES
};

/**
 * A view-model schema only has to answer to Page/Section/Detail/MiniPage/
 * ModalPage naming when its own *immediate parent* is itself part of that
 * family — real data (both installs, 2026-09) confirms this both ways:
 * schemas with no real parent at all (root Section/Detail bases like
 * `BaseDataView`/`SystemDesigner`) or with a parent from an unrelated family
 * (`CommunicationPanel`, the `*ContentEditSchema` chain, dashboard bases like
 * `SectionActionsDashboard`) are never suffixed Page/Section/Detail — only
 * schemas descending from a real Page/Section/Detail base are. When the
 * parent is specifically MiniPage- or ModalPage-suffixed, real data is 100%
 * consistent about the child matching that *specific* suffix rather than
 * falling back to a generic Page/PageV2.
 */
function requiredSuffixesForParent(
	parentName: string,
	familySuffixes: string[]
): string[] | undefined {
	if (familySuffixes.includes("MiniPage") && parentName.endsWith("MiniPage")) {
		return ["MiniPage"];
	}
	if (familySuffixes.includes("ModalPage") && parentName.endsWith("ModalPage")) {
		return ["ModalPage"];
	}
	if (familySuffixes.some((suffix) => parentName.endsWith(suffix))) {
		return familySuffixes;
	}
	return undefined;
}

const GUID_TAIL_RE = /\d{4,}/;

/** naming-guidelines.md §3 "Дополнительные правила" — the wizard-injected
 * numeric/GUID tail (`NauAccount213312123Section`) and the New/Test/Temp/
 * Copy/Old/Backup placeholder words, applied to every client schema
 * regardless of category. A deliberate self-made `V2`/`V3` check was tried
 * and dropped: real data shows almost every standalone `V\d+` segment
 * outside a Page/Section/Detail suffix combo is a legitimate override of a
 * real platform class of the same name (`SummaryModuleV2`,
 * `FixedFilterViewModelV2`, `QuickFilterModuleV2`, ...) — no reliable way to
 * tell "self-made" apart from "must match the base class" from the name
 * alone. */
function checkBusinessNameGarbage(schemaName: string, issues: NamingIssue[]): void {
	if (GUID_TAIL_RE.test(schemaName)) {
		issues.push({
			message: `Схема «${schemaName}»: похоже на случайный числовой/технический хвост в имени — уберите его (частая причина: мастер создания раздела)`
		});
	}
	const tempSegment = pascalCaseSegments(schemaName).find((segment) =>
		TEMP_DESIGNATION_WORDS.includes(segment)
	);
	if (tempSegment) {
		issues.push({
			message: `Схема «${schemaName}»: избегайте временного обозначения «${tempSegment}» в бизнес-части имени`
		});
	}
}

/** The non-Code context `checkClientSchemaNaming` needs — resolved by the
 * caller (via `SchemaHierarchyResolver`/`parseDescriptorParent`/reading the
 * schema's own `.js`/`.less`) since it depends on the workspace index, not
 * on anything derivable from the Code alone. */
export interface ClientSchemaNamingContext {
	schemaType?: string;
	parentName?: string;
	/** Module-type schemas only — the schema's own `.js` source and, if
	 * present, `.less`. */
	moduleSource?: { js: string; less?: string };
}

/**
 * Checks a client (JS) schema's name against naming-guidelines.md §3: the
 * type-appropriate suffix, the package prefix, and (for Module-type schemas)
 * §3's Module/Mixin/Css triad — see `checkModuleTypeNaming`. Pure — the
 * caller resolves everything in `ClientSchemaNamingContext` and passes it in.
 */
export function checkClientSchemaNaming(
	code: string,
	settings: ClientSchemaNamingSettings,
	context: ClientSchemaNamingContext = {}
): NamingIssue[] {
	const { schemaType, parentName, moduleSource } = context;
	const issues: NamingIssue[] = [];
	const suffixes = schemaType ? SUFFIXES_BY_SCHEMA_TYPE[schemaType] : undefined;
	if (suffixes) {
		const required = parentName ? requiredSuffixesForParent(parentName, suffixes) : undefined;
		if (required && !required.some((suffix) => code.endsWith(suffix))) {
			issues.push({
				message: `Схема «${code}»: родитель «${parentName}» относится к типу с суффиксом ${required.join("/")}, ожидается такой же суффикс`
			});
		}
	}
	if (schemaType === "MODULE" && moduleSource) {
		checkModuleTypeNaming(code, moduleSource, settings.checkModuleSuffix, issues);
	}
	if (settings.prefixes.length && !settings.prefixes.some((prefix) => code.startsWith(prefix))) {
		issues.push({
			message: `Схема «${code}»: ожидается префикс пакета (${settings.prefixes.join("/")})`
		});
	}
	checkBusinessNameGarbage(code, issues);
	return issues;
}

function isNearEmptySource(text: string): boolean {
	return text.replace(/\s+/g, "").length < 5;
}

/** Structural CSS-schema detection: a Module-type schema whose own `.js` is
 * empty/near-empty but whose `.less` carries real content is, by
 * construction, a CSS schema — independent of what it happens to be named.
 * Confirmed against every real `Css`-suffixed schema in both installs (100%
 * match), and it additionally surfaces 36 real schemas in one install that
 * are structurally CSS but suffixed `CSS` (wrong case) instead of `Css`. */
function looksLikeCssSchema(js: string, less: string | undefined): boolean {
	return isNearEmptySource(js) && Boolean(less) && !isNearEmptySource(less as string);
}

function extractModuleDefineName(js: string): string | undefined {
	let match = js.match(/^\s*define\(\s*["']([^"']+)["']/);
	if (match) {
		return match[1];
	}
	match = js.match(/Ext\.define\(\s*["']([^"']+)["']/);
	if (match) {
		return match[1].split(".").pop();
	}
	match = js.match(/alternateClassName\s*:\s*["']([^"']+)["']/);
	if (match) {
		return match[1].split(".").pop();
	}
	return undefined;
}

/**
 * naming-guidelines.md §3's Module/Mixin/Css row, for `SchemaType: "Module"`
 * schemas (no inheritance — mixins, plain modules, CSS-only schemas). Two
 * checks, both confirmed low-noise against real data:
 * - the module's own registered name (`define("Name", ...)` /
 *   `Ext.define("...Name")` / `alternateClassName`) must match the schema's
 *   own Name — "один модуль — одна схема", same idea as the C# class-name
 *   check (§4). ~97-100% compliant already in both installs; real
 *   mismatches found (`GoDateFilterModule` defining `GoDateFilterViewModel`)
 *   are genuine bugs.
 * - if it structurally looks like a CSS schema (see `looksLikeCssSchema`),
 *   it should be suffixed exactly `Css` (not `CSS`/`Css` case variants); the
 *   reverse (named `*Css` but not structurally empty-js/real-less) is
 *   flagged too, defensively — no real occurrence of that direction was
 *   found, but it would mean the schema's actual role doesn't match its
 *   name.
 * The bare "must end in Module/Mixin/Css" requirement is NOT enforced
 * unconditionally — real data shows 74-84% of real Module-type schemas
 * legitimately use neither (Helper/Constants/Container/Override/...), the
 * same open-role-vocabulary situation as C#'s Helper/Manager/Handler. Only
 * checked when `checkModuleSuffix` is explicitly turned on.
 */
function checkModuleTypeNaming(
	schemaName: string,
	moduleSource: { js: string; less?: string },
	checkModuleSuffix: boolean,
	issues: NamingIssue[]
): void {
	const looksCss = looksLikeCssSchema(moduleSource.js, moduleSource.less);
	const namedCss = schemaName.endsWith("Css");
	if (looksCss && !namedCss) {
		issues.push({
			message: `Схема «${schemaName}»: код (.js) пустой, .less заполнен — похоже на CSS-схему, ожидается суффикс Css (с учётом регистра)`
		});
		return;
	}
	if (namedCss && !looksCss) {
		issues.push({
			message: `Схема «${schemaName}»: суффикс Css, но код (.js) не пустой или .less пуст/отсутствует — не похоже на настоящую CSS-схему`
		});
		return;
	}
	if (looksCss) {
		return;
	}
	const defineName = extractModuleDefineName(moduleSource.js);
	if (defineName && defineName !== schemaName) {
		issues.push({
			message: `Модуль «${schemaName}»: внутреннее имя (define/Ext.define/alternateClassName — «${defineName}») не совпадает с именем схемы`
		});
	}
	if (
		checkModuleSuffix &&
		!schemaName.endsWith("Module") &&
		!schemaName.endsWith("Mixin")
	) {
		issues.push({
			message: `Схема «${schemaName}»: для типа Module ожидается суффикс Module или Mixin`
		});
	}
}
