import * as path from "path";

export type MemberKind =
	| "method"
	| "const"
	| "enum"
	| "property"
	| "namespace"
	| "attribute";

export interface SourcePosition {
	line: number;
	character: number;
}

export interface IndexedMember {
	name: string;
	kind: MemberKind;
	detail?: string;
	documentation?: string;
	/** 0-based line/character in the owning file */
	position?: SourcePosition;
	/** Owning file when the member is not on the current schema module */
	filePath?: string;
	/** Function parameter names, for override snippets */
	params?: string[];
	/** Nested fields, e.g. lookup/enum value + displayValue */
	children?: IndexedMember[];
	/** Lookup/entity path target, e.g. Contact for column Contact */
	referenceSchemaName?: string;
	/** Diff-node only: `values.itemType` verbatim (e.g.
	 * `"BPMSoft.ViewItemType.BUTTON"`) — lets the Outline provider look up
	 * the real Ext control class via `ViewControlsIndex` and list its
	 * available-but-unfilled properties, without amdAst.ts needing to know
	 * about that index. */
	viewItemType?: string;
	/** dataModel/detail item only: the local attribute/column name it ties
	 * back to (`dataModels.<X>.primaryColumnValue.bindTo`,
	 * `details.<X>.filter.masterColumn`/`detailColumn`) — lets the Outline
	 * provider cross-link it to the matching entry in "Атрибуты" or
	 * "Бизнес-правила" (which is itself already grouped by attribute name),
	 * without re-deriving it from `detail`'s rendered text. */
	linkedAttributeName?: string;
	/** Attribute-kind member only: its own `dataValueType` (e.g.
	 * `"BPMSoft.DataValueType.LOOKUP"`), if declared. Lets a diff node with
	 * no `itemType` of its own (an ordinary `bindTo`-bound field) resolve
	 * its real control via `ViewControlsIndex.resolveControlByDataValueType`
	 * — see CLAUDE.md §4b's `generateEditControl` writeup. */
	dataValueType?: string;
}

export function memberDedupeKey(member: IndexedMember): string {
	return member.kind === "attribute" ? `$${member.name}` : member.name;
}

/** Names like `_closePage` — intended as file-private in BPMSoft schemas. */
export function isPrivateMemberName(name: string): boolean {
	return name.startsWith("_") && name.length > 1;
}

export function isPrivateMemberFromOtherFile(
	name: string,
	originFilePath: string | undefined,
	currentFilePath: string
): boolean {
	if (!isPrivateMemberName(name) || !originFilePath || !currentFilePath) {
		return false;
	}
	return path.normalize(originFilePath) !== path.normalize(currentFilePath);
}

export interface IndexedModule {
	name: string;
	filePath: string;
	kind: "amd" | "mixin" | "constants" | "page" | "class" | "unknown";
	dependencies: string[];
	/** `css!`/`text!` loader-plugin entries from the same `define([...])`
	 * list — kept separate from `dependencies` because they don't bind to a
	 * factory parameter (RequireJS loads them as a side effect), so folding
	 * them back in would break `dependencies`' 1:1 positional alignment with
	 * `paramNames` that `SymbolIndex.resolveLocalAlias` relies on. Outline
	 * display only. */
	pluginDependencies?: string[];
	/** Parameter names in the define factory (aligned with deps when possible) */
	paramNames: string[];
	members: IndexedMember[];
	/** Keys from mixins: { LocalName: "BPMSoft.X" } */
	mixins: Record<string, string>;
	/** Ext.define class name, e.g. BPMSoft.controls.Grid */
	className?: string;
	/** alternateClassName e.g. BPMSoft.Grid / BPMSoft.WSFieldManagementMixin */
	alternateClassName?: string;
	/** Ext override: "BPMSoft.controls.Grid" */
	override?: string;
	/** Ext extend: "BPMSoft.controls.Component" */
	extend?: string;
	/** Client schema entity, e.g. Account → conf/content/Account.js columns */
	entitySchemaName?: string;
	/**
	 * Ext.define members of conf/content/{Entity}.js for `this.entitySchema`
	 * (name, uId, caption, …). Columns stay on `members`.
	 */
	entityClassMembers?: IndexedMember[];
	/** messages: { Name: { direction: PUBLISH | SUBSCRIBE | BIDIRECTIONAL } } */
	messages: Record<string, IndexedSchemaMessage>;
	/**
	 * Names assigned in the module as `viewModel.foo = this.foo` /
	 * `this.foo.bind(this)` (e.g. ModalBoxSchemaModule.createViewModel).
	 */
	viewModelBindings?: string[];
	/** One entry per `diff: [...]` array element (view-model schemas only) —
	 * outline/browsing aid, not used for completion/hover. */
	diffMembers?: IndexedMember[];
	/** `rules` (hand-written) merged with `businessRules` (Designer panel
	 * output) the same way `BusinessRulesApplierV2.mergeRules` merges them at
	 * runtime — for the same reason as `diffMembers`. See CLAUDE.md §4b. */
	businessRuleMembers?: IndexedMember[];
	/** `businessRulesMultiplyActions` — a separate, tree-based rules engine
	 * (one shared condition can drive actions across multiple columns), kept
	 * apart from `businessRuleMembers` since its shape is genuinely
	 * different. See CLAUDE.md §4b. */
	multiplyActionMembers?: IndexedMember[];
	/** `details: { DetailName: {...} }` — a Detail embedded directly in the
	 * schema's own config (rare — most schemas carry this only as the
	 * Designer's empty placeholder), for the same reason as `diffMembers`. */
	detailMembers?: IndexedMember[];
	/** `modules: { Name: { moduleClassName, config } }` — named, pre-configured
	 * embedded module instances a `diff` MODULE entry mounts by name. See
	 * CLAUDE.md §4b. */
	embeddedModuleMembers?: IndexedMember[];
	/** `dataModels: { Name: { entitySchemaName, primaryColumnValue } }` —
	 * named references to a related entity reached via a lookup attribute.
	 * See CLAUDE.md §4b. */
	dataModelMembers?: IndexedMember[];
}

export type SchemaMessageDirection = "publish" | "subscribe" | "bidirectional";

export interface IndexedSchemaMessage {
	name: string;
	direction: SchemaMessageDirection;
	position?: SourcePosition;
	filePath?: string;
	documentation?: string;
}

export type SandboxMessageIssue = "missing" | "wrongDirection";

const MESSAGE_DIRECTION_LABEL: Record<SchemaMessageDirection, string> = {
	publish: "PUBLISH",
	subscribe: "SUBSCRIBE",
	bidirectional: "BIDIRECTIONAL"
};

export function schemaMessageDirectionLabel(
	direction: SchemaMessageDirection
): string {
	return MESSAGE_DIRECTION_LABEL[direction];
}

/** PUBLISH/SUBSCRIBE plus BIDIRECTIONAL for the matching sandbox action. */
export function schemaMessageSupports(
	msg: IndexedSchemaMessage | undefined,
	action: "publish" | "subscribe"
): boolean {
	if (!msg) {
		return false;
	}
	return msg.direction === action || msg.direction === "bidirectional";
}

export function sandboxMessageIssue(
	messages: Record<string, IndexedSchemaMessage>,
	name: string,
	action: "publish" | "subscribe"
): SandboxMessageIssue | undefined {
	const msg = messages[name];
	if (!msg) {
		return "missing";
	}
	if (schemaMessageSupports(msg, action)) {
		return undefined;
	}
	return "wrongDirection";
}

export interface PlatformStubMember {
	name: string;
	kind: MemberKind;
	detail?: string;
	documentation?: string;
	filePath?: string;
	position?: SourcePosition;
	children?: PlatformStubMember[];
}
