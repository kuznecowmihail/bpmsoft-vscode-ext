export interface NamingIssue {
	message: string;
}

/**
 * Only these SchemaType enum values (as returned by
 * `SchemaHierarchyResolver.resolveSchemaType`) reliably map to a single
 * naming-guidelines.md suffix family. Plain `MODULE` covers Modules, Mixins,
 * Constants and CSS schemas all at once — too ambiguous to validate, so it's
 * deliberately left out rather than guessed at.
 */
const SUFFIXES_BY_SCHEMA_TYPE: Record<string, string[]> = {
	EDIT_VIEW_MODEL_SCHEMA: ["Page", "PageV2", "MiniPage"],
	GRID_DETAIL_VIEW_MODEL_SCHEMA: ["Detail", "DetailV2"],
	MODULE_VIEW_MODEL_SCHEMA: ["Section", "SectionV2"]
};

/**
 * `EditViewModelSchema` is used both for real navigable pages AND for
 * reusable embedded panels that are edited through the same designer UI but
 * never shown as a "page" (`CommunicationPanel`, the `Base*ContentEditSchema`
 * family, …) — SchemaType alone can't tell them apart, and both real
 * confirmed false positives on this rule so far were exactly that. The
 * schema's *immediate* parent turns out to be a reliable tell: real pages
 * descend from a Page/PageV2/MiniPage-suffixed base (`BaseModulePageV2`,
 * `BasePageV2`, …); the panel family doesn't. Only enforce the suffix when
 * the parent corroborates it — Section/Detail haven't shown this problem, so
 * they stay unconditional.
 */
const PAGE_SUFFIXES = SUFFIXES_BY_SCHEMA_TYPE.EDIT_VIEW_MODEL_SCHEMA;

/**
 * Checks a client (JS) schema's name against naming-guidelines.md: the
 * type-appropriate suffix (§3) and, if any prefixes are configured, the
 * package prefix (§2/§3). Pure — the caller resolves `schemaType` (and the
 * immediate `parentName`, via the existing `SchemaHierarchyResolver`/
 * `parseDescriptorParent`) and passes them in.
 */
export function checkClientSchemaNaming(
	schemaName: string,
	schemaType: string | undefined,
	prefixes: string[],
	parentName?: string
): NamingIssue[] {
	const issues: NamingIssue[] = [];
	const suffixes = schemaType ? SUFFIXES_BY_SCHEMA_TYPE[schemaType] : undefined;
	const parentConfirmsPage =
		!parentName || PAGE_SUFFIXES.some((suffix) => parentName.endsWith(suffix));
	const shouldCheckSuffix =
		suffixes && (schemaType !== "EDIT_VIEW_MODEL_SCHEMA" || parentConfirmsPage);
	if (shouldCheckSuffix && suffixes && !suffixes.some((suffix) => schemaName.endsWith(suffix))) {
		issues.push({
			message: `Схема «${schemaName}»: для типа ${schemaType} ожидается суффикс ${suffixes.join("/")}`
		});
	}
	if (prefixes.length && !prefixes.some((prefix) => schemaName.startsWith(prefix))) {
		issues.push({
			message: `Схема «${schemaName}»: ожидается префикс пакета (${prefixes.join("/")})`
		});
	}
	return issues;
}
