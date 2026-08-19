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
	/** messages: { Name: { direction: PUBLISH | SUBSCRIBE | BIDIRECTIONAL } } */
	messages: Record<string, IndexedSchemaMessage>;
	/**
	 * Names assigned in the module as `viewModel.foo = this.foo` /
	 * `this.foo.bind(this)` (e.g. ModalBoxSchemaModule.createViewModel).
	 */
	viewModelBindings?: string[];
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
