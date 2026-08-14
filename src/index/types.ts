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
}

export function memberDedupeKey(member: IndexedMember): string {
	return member.kind === "attribute" ? `$${member.name}` : member.name;
}

export interface IndexedModule {
	name: string;
	filePath: string;
	kind: "amd" | "mixin" | "constants" | "page" | "class" | "unknown";
	dependencies: string[];
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
}

export interface PlatformStubMember {
	name: string;
	kind: MemberKind;
	detail?: string;
	documentation?: string;
	children?: PlatformStubMember[];
}
