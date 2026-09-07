import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { SymbolIndex } from "../index/SymbolIndex";
import { IndexedMember } from "../parse/types";
import { isJsFile } from "./jsDocuments";
import { findResourceDirs } from "../index/schemaResourceLookup";

type OutlineNode =
	| { kind: "group"; label: string; members: IndexedMember[] }
	| {
			kind: "member";
			member: IndexedMember;
			ownerFilePath: string;
			groupLabel: string;
			isTopLevel: boolean;
			parent: OutlineNode;
	  };

// Schema types the platform's own compiler treats as a genuine View-Model
// class (Ext.define + generated viewmodel, per ViewModelGeneratorV2/
// SchemaBuilderV2 — see CLAUDE.md §4a) — as opposed to a plain Module-type
// schema (ClientUnitSchemaType.Module/None, no Ext.define hierarchy at all)
// or non-ClientUnitSchemaManager files (mixins, constants, C#, SQL). Same
// set `packageIcons.ts`/`SchemaHierarchyResolver.ts`'s `NO_ENTITY_COLUMN_SCHEMA_TYPES`
// already treat as "has entitySchemaName" for the family, plus the two
// EditControls/GridEdit detail variants documented (but not yet observed as
// a literal string in either indexed install) in CLAUDE.md §4.
const VIEW_MODEL_SCHEMA_TYPES = new Set([
	"EDIT_VIEW_MODEL_SCHEMA",
	"MODULE_VIEW_MODEL_SCHEMA",
	"GRID_DETAIL_VIEW_MODEL_SCHEMA",
	"DETAIL_VIEW_MODEL_SCHEMA",
	"EDIT_CONTROLS_DETAIL_VIEW_MODEL_SCHEMA",
	"GRID_EDIT_DETAIL_VIEW_MODEL_SCHEMA"
]);

/**
 * BPMSoft-aware Outline for the active view-model schema (Page/Section/
 * Detail and their variants — see `VIEW_MODEL_SCHEMA_TYPES`; a plain
 * Module-type schema, mixin, or non-JS file shows nothing here, on purpose —
 * that's what the plain mirror Outline is for) — unlike the standard
 * Outline (a view VS Code owns; can't be relocated into our container, see
 * plan), this reads `SymbolIndex.resolveThisMembers()` so it understands
 * the full `this.` surface: own members, members inherited through the
 * schema hierarchy, and mixin methods — not just what's declared in the
 * current file's AST.
 */
export class ViewModelOutlineProvider implements vscode.TreeDataProvider<OutlineNode> {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;
	private currentFilePath: string | undefined;
	/** Which nodes are expanded, kept per file so switching to another open
	 * file and back restores what was expanded rather than re-collapsing
	 * everything (`onDidChangeTreeData` re-queries the whole tree from
	 * `getTreeItem`'s collapsibleState — VS Code doesn't remember this for
	 * us across a full refresh the way it does for e.g. a stable-id list
	 * view). Keyed by a string, not the `OutlineNode` object itself — nodes
	 * are rebuilt fresh on every `getChildren()` call, no stable identity to
	 * key a Set/Map by otherwise. */
	private readonly expandedByFile = new Map<string, Set<string>>();

	constructor(private readonly index: SymbolIndex) {}

	refresh(): void {
		const document = vscode.window.activeTextEditor?.document;
		const filePath = document && isJsFile(document) ? document.uri.fsPath : undefined;
		this.currentFilePath = filePath && this.isViewModelSchema(filePath) ? filePath : undefined;
		this.changeEmitter.fire();
	}

	private isViewModelSchema(filePath: string): boolean {
		const schemaName = this.index.ensureModule(filePath)?.name;
		if (!schemaName) {
			return false;
		}
		const schemaType = this.index.hierarchy.resolveSchemaType(schemaName);
		return !!schemaType && VIEW_MODEL_SCHEMA_TYPES.has(schemaType);
	}

	/** Driven by `TreeView.onDidExpandElement`/`onDidCollapseElement` in
	 * extension.ts — this provider only tracks the state, it doesn't own the
	 * `TreeView` handle those events come from. */
	setExpanded(node: OutlineNode, expanded: boolean): void {
		if (!this.currentFilePath) {
			return;
		}
		if (!expanded) {
			this.expandedByFile.get(this.currentFilePath)?.delete(nodeKey(node));
			return;
		}
		let set = this.expandedByFile.get(this.currentFilePath);
		if (!set) {
			set = new Set();
			this.expandedByFile.set(this.currentFilePath, set);
		}
		set.add(nodeKey(node));
	}

	private isExpanded(node: OutlineNode): boolean {
		if (!this.currentFilePath) {
			return false;
		}
		return this.expandedByFile.get(this.currentFilePath)?.has(nodeKey(node)) ?? false;
	}

	getParent(node: OutlineNode): OutlineNode | undefined {
		return node.kind === "member" ? node.parent : undefined;
	}

	/** Deepest node whose own source position is at or before `line` — used
	 * by "Follow Cursor" (extension.ts). `IndexedMember.position` is a POINT
	 * (line/character), not a range (this tree is built from AST-summarized
	 * diff/attribute/rule data, not a live block-structured parse), so this
	 * is only an approximation of "the cursor is inside this element" — the
	 * nearest preceding element, not a genuine containment check. Precise
	 * range-based Follow Cursor is what the plain mirror Outline is for. */
	findNodeAtOrBeforeLine(line: number): OutlineNode | undefined {
		let best: OutlineNode | undefined;
		let bestLine = -1;
		const visit = (nodes: OutlineNode[]) => {
			for (const node of nodes) {
				const nodeLine = node.kind === "member" ? node.member.position?.line : undefined;
				if (nodeLine !== undefined && nodeLine <= line && nodeLine > bestLine) {
					best = node;
					bestLine = nodeLine;
				}
				visit(this.getChildren(node));
			}
		};
		visit(this.getGroups());
		return best;
	}

	getChildren(node?: OutlineNode): OutlineNode[] {
		if (!node) {
			return this.getGroups();
		}
		if (node.kind === "group") {
			return node.members.map((member) => ({
				kind: "member",
				member,
				ownerFilePath: member.filePath || this.currentFilePath || "",
				groupLabel: node.label,
				isTopLevel: true,
				parent: node
			}));
		}
		if (node.kind === "member" && node.member.children?.length) {
			return node.member.children.map((child) => ({
				kind: "member",
				member: child,
				ownerFilePath: child.filePath || node.ownerFilePath,
				groupLabel: node.groupLabel,
				isTopLevel: false,
				parent: node
			}));
		}
		return [];
	}

	getTreeItem(node: OutlineNode): vscode.TreeItem {
		if (node.kind === "group") {
			const collapsible = this.isExpanded(node)
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.Collapsed;
			return new vscode.TreeItem(node.label, collapsible);
		}
		const member = node.member;
		const collapsible = !member.children?.length
			? vscode.TreeItemCollapsibleState.None
			: this.isExpanded(node)
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.Collapsed;
		const item = new vscode.TreeItem(displayName(member), collapsible);
		item.description = member.detail;
		item.tooltip = member.documentation;
		item.iconPath = memberIcon(member, node.groupLabel, node.isTopLevel);
		if (member.position && node.ownerFilePath) {
			const pos = new vscode.Position(member.position.line, member.position.character);
			item.command = {
				command: "vscode.open",
				title: "Открыть",
				arguments: [vscode.Uri.file(node.ownerFilePath), { selection: new vscode.Range(pos, pos) }]
			};
		}
		return item;
	}

	private getGroups(): OutlineNode[] {
		if (!this.currentFilePath) {
			return [];
		}
		const members = this.index.resolveThisMembers(this.currentFilePath);
		const normalizedCurrent = path.normalize(this.currentFilePath);
		const isOwn = (m: IndexedMember) => !!m.filePath && path.normalize(m.filePath) === normalizedCurrent;

		const attributes = members.filter((m) => m.kind === "attribute");
		const mixins = members.filter((m) => m.kind === "namespace");
		const methods = members.filter((m) => m.kind === "method");
		const ownMethods = methods.filter(isOwn);
		const inheritedMethods = methods.filter((m) => !isOwn(m));
		// Already computed by resolveThisMembers (schemaBindsEntityColumns →
		// appendEntitySchemaObject) but, being kind "property", fell through
		// every filter above and was never actually shown anywhere.
		const entitySchema = members.find((m) => m.kind === "property" && m.name === "entitySchema");

		const mod = this.index.ensureModule(this.currentFilePath);

		const attrDataValueTypeByName = new Map<string, string>();
		for (const a of attributes) {
			if (a.dataValueType) {
				attrDataValueTypeByName.set(a.name, a.dataValueType);
			}
		}

		// A `diff` DETAIL/MODULE item mounts by matching its own `name`
		// against the `details{}`/`modules{}` registry key (confirmed against
		// the real consumers, `BaseEntityPage.js`/`BaseSchemaViewModel.js` —
		// see CLAUDE.md §4b). Built early since both the attribute cross-link
		// below and the registry cross-link further down need it.
		const enrichedDiff = (mod?.diffMembers || []).map((m) =>
			enrichDiffAvailableProperties(m, this.index, attrDataValueTypeByName)
		);
		const diffNodesByName = new Map<string, IndexedMember>();
		collectDiffOperationNodesByName(enrichedDiff, diffNodesByName);

		// A plain `insert`/`merge` diff item with no `itemType` at all — the
		// common case for an ordinary attribute-bound field — still resolves
		// its real control via `bindTo` (`ViewGeneratorV2.findViewModelColumn`
		// looks the bound attribute up by this same name; see CLAUDE.md §4b),
		// so it belongs in the same attribute cross-link group as
		// dataModels/details/business-rules.
		const diffAttributeNodes: IndexedMember[] = [];
		collectLinkedAttributeNodes(enrichedDiff, diffAttributeNodes);

		const attrLinks = buildAttributeCrossLinks(
			attributes,
			mod?.dataModelMembers,
			mod?.detailMembers,
			mod?.businessRuleMembers,
			diffAttributeNodes
		);
		const linkedAttributes = attributes.map((a) => crossLinkAttribute(a, "Атрибуты", a.name, attrLinks));

		const registryByName = new Map<string, RelatedRef>();
		for (const d of mod?.detailMembers || []) {
			registryByName.set(d.name, { mechanismLabel: "Детали", member: d });
		}
		for (const em of mod?.embeddedModuleMembers || []) {
			registryByName.set(em.name, { mechanismLabel: "Встроенные модули", member: em });
		}

		const groups: OutlineNode[] = [];
		if (attributes.length) {
			groups.push({ kind: "group", label: `Атрибуты (${attributes.length})`, members: linkedAttributes });
		}
		if (ownMethods.length) {
			groups.push({ kind: "group", label: `Свои методы (${ownMethods.length})`, members: ownMethods });
		}
		if (inheritedMethods.length) {
			groups.push({
				kind: "group",
				label: `Унаследованные методы (${inheritedMethods.length})`,
				members: inheritedMethods
			});
		}
		if (mixins.length) {
			groups.push({ kind: "group", label: `Миксины (${mixins.length})`, members: mixins });
		}
		if (entitySchema) {
			groups.push({ kind: "group", label: "Модель данных", members: [entitySchema] });
		}

		// The rest is per-file structural data (this file's own AMD deps /
		// diff / rules / …) rather than the merged this.-surface above, so it
		// comes straight off this file's own IndexedModule.
		const allDeps = [...(mod?.dependencies || []), ...(mod?.pluginDependencies || [])];
		if (allDeps.length) {
			const depMembers: IndexedMember[] = allDeps.map((dep) => {
				const target = resolveDependencyTarget(this.index, dep);
				return {
					name: dep,
					kind: "const",
					detail: target ? undefined : "не найдено",
					filePath: target,
					position: target ? { line: 0, character: 0 } : undefined
				};
			});
			groups.push({ kind: "group", label: `Зависимости AMD (${depMembers.length})`, members: depMembers });
		}
		if (mod?.diffMembers?.length) {
			const withRegistry = enrichedDiff.map((m) => crossLinkDiffToRegistry(m, registryByName));
			const linked = withRegistry.map((m) => crossLinkDiffByAttribute(m, attrLinks));
			groups.push({ kind: "group", label: `Diff (${mod.diffMembers.length})`, members: linked });
		}
		if (mod?.businessRuleMembers?.length) {
			const linked = mod.businessRuleMembers.map((m) => crossLinkAttribute(m, "Бизнес-правила", m.name, attrLinks));
			groups.push({
				kind: "group",
				label: `Бизнес-правила (${mod.businessRuleMembers.length})`,
				members: linked
			});
		}
		if (mod?.multiplyActionMembers?.length) {
			groups.push({
				kind: "group",
				label: `Правила: мульти-действия (${mod.multiplyActionMembers.length})`,
				members: mod.multiplyActionMembers
			});
		}
		if (mod?.detailMembers?.length) {
			const linked = mod.detailMembers.map((m) => {
				const byAttr = crossLinkAttribute(m, "Детали", m.linkedAttributeName, attrLinks);
				const diffNode = diffNodesByName.get(m.name);
				return diffNode ? withRelated(byAttr, [{ mechanismLabel: "Diff", member: diffNode }]) : byAttr;
			});
			groups.push({
				kind: "group",
				label: `Детали (${mod.detailMembers.length})`,
				members: linked
			});
		}
		if (mod?.embeddedModuleMembers?.length) {
			const linked = mod.embeddedModuleMembers.map((m) => {
				const diffNode = diffNodesByName.get(m.name);
				return diffNode ? withRelated(m, [{ mechanismLabel: "Diff", member: diffNode }]) : m;
			});
			groups.push({
				kind: "group",
				label: `Встроенные модули (${mod.embeddedModuleMembers.length})`,
				members: linked
			});
		}
		if (mod?.dataModelMembers?.length) {
			const linked = mod.dataModelMembers.map((m) =>
				crossLinkAttribute(m, "Доп. модели данных", m.linkedAttributeName, attrLinks)
			);
			groups.push({
				kind: "group",
				label: `Доп. модели данных (${mod.dataModelMembers.length})`,
				members: linked
			});
		}
		return groups;
	}
}

/** Stable string identity for an `OutlineNode`, surviving the fact that the
 * node objects themselves are rebuilt fresh on every `getChildren()` call —
 * used to key expand-state (`expandedByFile`) and nothing else. Group nodes
 * are unique by label alone; member nodes by their group + name + source
 * line (matches the same fields `isSameMember` already treats as identity
 * elsewhere in this file). */
function nodeKey(node: OutlineNode): string {
	if (node.kind === "group") {
		return `group:${node.label}`;
	}
	return `member:${node.groupLabel}/${node.member.name}/${node.member.position?.line ?? "-"}`;
}

function displayName(member: IndexedMember): string {
	return member.kind === "attribute" ? `$${member.name}` : member.name;
}

const DIFF_ADDED_COLOR = new vscode.ThemeColor("gitDecoration.addedResourceForeground");
const DIFF_REMOVED_COLOR = new vscode.ThemeColor("gitDecoration.deletedResourceForeground");
const DIFF_MODIFIED_COLOR = new vscode.ThemeColor("gitDecoration.modifiedResourceForeground");

/** A real-data survey of 618 client schemas across two BPMSoft installs
 * found `diff` operations are exhaustively one of these four (insert/remove/
 * merge/move — nothing else observed), so this can give each its own
 * distinct, git-like icon instead of guessing at hypothetical ones.
 * `collectDiffMembers` puts the operation as the leading word of `detail`. */
function diffOperationIcon(detail: string | undefined): vscode.ThemeIcon | undefined {
	if (!detail) {
		return undefined;
	}
	if (detail.startsWith("insert")) {
		return new vscode.ThemeIcon("diff-added", DIFF_ADDED_COLOR);
	}
	if (detail.startsWith("remove")) {
		return new vscode.ThemeIcon("diff-removed", DIFF_REMOVED_COLOR);
	}
	if (detail.startsWith("merge")) {
		return new vscode.ThemeIcon("diff-modified", DIFF_MODIFIED_COLOR);
	}
	if (detail.startsWith("move")) {
		return new vscode.ThemeIcon("arrow-both");
	}
	return undefined;
}

/** Named pseudo-group containers reused across several mechanisms (diff
 * nodes, details, modules, cross-links) — these should read the same
 * regardless of which top-level group they're nested under, so they're
 * matched by name before any group-specific override gets a chance to paint
 * them with that group's flat icon. */
const PSEUDO_GROUP_ICONS: Record<string, string> = {
	"Связано": "link",
	"Доступные, но не заполненные": "add",
	"Доступные свойства (BINDPARAMETER)": "add",
	"Заполненные свойства": "symbol-namespace",
	"Заполненные события": "symbol-namespace",
	"Удалённые свойства": "diff-removed"
};

function memberIcon(member: IndexedMember, groupLabel: string, isTopLevel: boolean): vscode.ThemeIcon {
	const pseudo = member.kind === "namespace" ? PSEUDO_GROUP_ICONS[member.name] : undefined;
	if (pseudo) {
		return new vscode.ThemeIcon(pseudo);
	}
	if (groupLabel.startsWith("Diff")) {
		const icon = diffOperationIcon(member.detail);
		if (icon) {
			return icon;
		}
	}
	if (groupLabel.startsWith("Бизнес-правила")) {
		// Top level here is the attribute name (kind "namespace", grouping
		// its rules); leaves are the individual rules.
		return member.kind === "namespace" ? new vscode.ThemeIcon("symbol-namespace") : new vscode.ThemeIcon("law");
	}
	if (groupLabel.startsWith("Правила: мульти-действия")) {
		if (member.kind === "namespace") {
			return new vscode.ThemeIcon("symbol-event");
		}
		// "заполнение значения (POPULATE)" is the one action type the
		// classic rules engine has no equivalent for at all — worth its own
		// icon rather than blending in with the filter/property actions.
		return member.detail?.includes("POPULATE") ? new vscode.ThemeIcon("edit") : new vscode.ThemeIcon("law");
	}
	// Only the group's own direct entries get its flat icon — nested
	// "Заполненные свойства"/"Доступные"/"Связано" children (added once
	// details/modules got the same filled-vs-available treatment as diff)
	// fall through to the kind-based switch below instead, via `isTopLevel`.
	if (isTopLevel && groupLabel.startsWith("Детали")) {
		return new vscode.ThemeIcon("layout");
	}
	if (isTopLevel && groupLabel.startsWith("Встроенные модули")) {
		return new vscode.ThemeIcon("package");
	}
	if (isTopLevel && groupLabel.startsWith("Доп. модели данных")) {
		return new vscode.ThemeIcon("database");
	}
	switch (member.kind) {
		case "method":
			return new vscode.ThemeIcon("symbol-method");
		case "attribute":
			return new vscode.ThemeIcon("symbol-field");
		case "property":
			return new vscode.ThemeIcon("symbol-property");
		case "namespace":
			return new vscode.ThemeIcon("symbol-namespace");
		case "const":
			return new vscode.ThemeIcon("symbol-constant");
		case "enum":
			return new vscode.ThemeIcon("symbol-enum");
		default:
			return new vscode.ThemeIcon("symbol-misc");
	}
}

/**
 * Resolves an AMD dependency string from a schema's `define([...])` list to
 * a real file, so clicking it in the outline can jump straight there.
 * Confirmed by surveying every `"X!"`-prefixed dependency across both real
 * installs (2026-09-06) — only two loader-plugin prefixes exist in practice:
 * - `css!{Name}` — the RequireJS css-loader convention, loads `{Name}.less`.
 * - `{Name}Resources` (a suffix, not a `!`-prefix) — the schema's own
 *   compiled localization-strings module; not a real file in `Pkg` at all,
 *   it's synthesized at build time from the schema's own `Resources` folder
 *   (the `resource.<culture>.xml` files, §4a) — so this resolves to the
 *   first of those XML files instead.
 * - a bare name is an ordinary schema/class dependency — resolves to its own
 *   `.js` file directly via the already-built `SymbolIndex` name index.
 * `profile!{Key}` (BPMSoft's user-profile loader plugin) is deliberately
 * NOT handled here — it only ever appears via a dynamic `BPMSoft.require()`
 * call inside method bodies, never in the static `define([...])` array, so
 * it can never actually reach this function.
 */
function resolveDependencyTarget(index: SymbolIndex, dep: string): string | undefined {
	if (dep.startsWith("css!")) {
		const jsPath = resolveSchemaFilePath(index, dep.slice("css!".length));
		if (!jsPath) {
			return undefined;
		}
		const lessPath = jsPath.replace(/\.js$/i, ".less");
		return fileExists(lessPath) ? lessPath : undefined;
	}
	if (dep.endsWith("Resources") && dep.length > "Resources".length) {
		const schemaName = dep.slice(0, -"Resources".length);
		const jsPath = resolveSchemaFilePath(index, schemaName);
		if (!jsPath) {
			return undefined;
		}
		return firstResourceFile(path.dirname(jsPath), schemaName);
	}
	return resolveSchemaFilePath(index, dep);
}

function resolveSchemaFilePath(index: SymbolIndex, name: string): string | undefined {
	return index.getAllByName(name)[0]?.filePath;
}

function firstResourceFile(schemaDir: string, schemaName: string): string | undefined {
	for (const resourceDir of findResourceDirs(schemaDir, schemaName)) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(resourceDir, { withFileTypes: true });
		} catch {
			continue;
		}
		const files = entries.filter((e) => e.isFile()).map((e) => e.name);
		const preferred = files.find((f) => f.includes("ru-RU")) || files[0];
		if (preferred) {
			return path.join(resourceDir, preferred);
		}
	}
	return undefined;
}

const DIFF_FILLED_GROUP_NAMES = new Set(["Заполненные свойства", "Заполненные события", "Удалённые свойства"]);

/**
 * Adds a "Доступные, но не заполненные" child listing config properties the
 * diff node's underlying Ext control class declares but this node doesn't
 * set — via `ViewControlsIndex`. Two ways to resolve the control, tried in
 * order: (1) `itemType` → `ViewGeneratorV2.js`'s `generateStandardItem`
 * dispatch, for structural placeholders (buttons, containers, tabs, …); (2)
 * for a node with no `itemType` at all — the common case for an ordinary
 * attribute-bound field, just `bindTo`+`layout` — its bound attribute's own
 * `dataValueType` via `generateEditControl`'s separate dispatch (see
 * CLAUDE.md §4b for both). `attrDataValueTypeByName` supplies the second
 * path; built once in `getGroups` from the Outline's own attribute list.
 * Either way, resolution is scoped to the control's *own* file — properties
 * it inherits from its `extend` chain (most of what e.g. `BPMSoft.Container`
 * actually has) aren't included yet, so an empty/short list here doesn't
 * mean the control has no other config options, just none declared on its
 * own class body. Non-mutating: `mod.diffMembers` is a cached array shared
 * across refreshes, so this builds new wrapper objects rather than editing
 * the cached tree in place (repeated refreshes would otherwise keep
 * re-appending the group).
 */
function enrichDiffAvailableProperties(
	member: IndexedMember,
	index: SymbolIndex,
	attrDataValueTypeByName: Map<string, string>
): IndexedMember {
	const children = member.children?.map((c) => enrichDiffAvailableProperties(c, index, attrDataValueTypeByName));
	const control =
		index.viewControls.resolveControl(member.viewItemType) ??
		(member.viewItemType
			? undefined
			: index.viewControls.resolveControlByDataValueType(
					member.linkedAttributeName ? attrDataValueTypeByName.get(member.linkedAttributeName) : undefined
				));
	if (!control?.ownProperties.length) {
		return children === member.children ? member : { ...member, children };
	}
	const known = new Set<string>();
	for (const group of children || []) {
		if (DIFF_FILLED_GROUP_NAMES.has(group.name)) {
			for (const leaf of group.children || []) {
				known.add(leaf.name);
			}
		}
	}
	const available = control.ownProperties.filter((p) => !known.has(p));
	if (!available.length) {
		return children === member.children ? member : { ...member, children };
	}
	const availableGroup: IndexedMember = {
		name: "Доступные, но не заполненные",
		kind: "namespace",
		detail: `${available.length}`,
		documentation: `${control.className} — собственные свойства класса, без учёта родителя${control.extend ? ` (${control.extend})` : ""}`,
		children: available.map((p) => ({ name: p, kind: "property" }))
	};
	return { ...member, children: [...(children || []), availableGroup] };
}

interface RelatedRef {
	mechanismLabel: string;
	member: IndexedMember;
}

/**
 * Groups attribute-anchored nodes (attributes themselves, data models,
 * details, business-rule groups) by the attribute name they share, so each
 * one can list the others as "Связано". `Бизнес-правила`'s top-level nodes
 * are already grouped by attribute name (see `collectBusinessRuleMembers`),
 * so that IS the attribute name for them — no separate field needed.
 * `Правила: мульти-действия` is deliberately not included: a
 * multiply-action's condition can span several attributes at once (no
 * single "the" attribute to anchor on). Modules aren't attribute-anchored at
 * all — see `crossLinkDiffToRegistry`/the `diffNodesByName` link built in
 * `getGroups` for their (name-based, not attribute-based) cross-link.
 * `diffAttributeNodes` are diff-tree nodes with their own `bindTo`-derived
 * `linkedAttributeName` (ordinary attribute-bound fields, the common case —
 * see `crossLinkDiffByAttribute`).
 */
function buildAttributeCrossLinks(
	attributes: IndexedMember[],
	dataModelMembers: IndexedMember[] | undefined,
	detailMembers: IndexedMember[] | undefined,
	businessRuleMembers: IndexedMember[] | undefined,
	diffAttributeNodes: IndexedMember[]
): Map<string, RelatedRef[]> {
	const byAttrName = new Map<string, RelatedRef[]>();
	const add = (attrName: string | undefined, ref: RelatedRef) => {
		if (!attrName) {
			return;
		}
		const list = byAttrName.get(attrName);
		if (list) {
			list.push(ref);
		} else {
			byAttrName.set(attrName, [ref]);
		}
	};
	for (const a of attributes) {
		add(a.name, { mechanismLabel: "Атрибуты", member: a });
	}
	for (const dm of dataModelMembers || []) {
		add(dm.linkedAttributeName, { mechanismLabel: "Доп. модели данных", member: dm });
	}
	for (const d of detailMembers || []) {
		add(d.linkedAttributeName, { mechanismLabel: "Детали", member: d });
	}
	for (const br of businessRuleMembers || []) {
		add(br.name, { mechanismLabel: "Бизнес-правила", member: br });
	}
	for (const dn of diffAttributeNodes) {
		add(dn.linkedAttributeName, { mechanismLabel: "Diff", member: dn });
	}
	return byAttrName;
}

function collectLinkedAttributeNodes(members: IndexedMember[], out: IndexedMember[]): void {
	for (const m of members) {
		if (m.linkedAttributeName) {
			out.push(m);
		}
		if (m.children) {
			collectLinkedAttributeNodes(m.children, out);
		}
	}
}

/** The other direction of the diff-node refs `buildAttributeCrossLinks`
 * folds in above: walks the (already registry-cross-linked) diff tree and,
 * for each node with its own `linkedAttributeName`, adds/merges a "Связано"
 * entry for every *other* attribute-anchored node sharing that name. */
function crossLinkDiffByAttribute(member: IndexedMember, attrLinks: Map<string, RelatedRef[]>): IndexedMember {
	const children = member.children?.map((c) => crossLinkDiffByAttribute(c, attrLinks));
	const withChildren = children === member.children ? member : { ...member, children };
	if (!member.linkedAttributeName) {
		return withChildren;
	}
	const refs = attrLinks.get(member.linkedAttributeName) || [];
	const others = refs.filter((r) => !(r.mechanismLabel === "Diff" && isSameMember(r.member, member)));
	return withRelated(withChildren, others);
}

/** Value-based identity, not reference equality: a diff node passes through
 * several non-mutating enrichment passes before self-exclusion is checked
 * (`enrichDiffAvailableProperties` → `crossLinkDiffToRegistry` →
 * `crossLinkDiffByAttribute`), and each rebuilds a new wrapper object for
 * any node with children via `.map()` — which allocates a fresh array (and
 * so a fresh `{...member, children}` object) even when every mapped child
 * came back unchanged. `r.member === member` reference comparison silently
 * fails once that's happened, letting a node "recommend" itself as related
 * to itself — caught via a real example (`AccountPageV2.js`'s `Country...`
 * field showing up in its own "Связано" list). `position` survives every
 * pass by reference (each pass only ever spreads it through, never
 * reconstructs it), but compare by value anyway to not depend on that. */
function isSameMember(a: IndexedMember, b: IndexedMember): boolean {
	return a.name === b.name && a.position?.line === b.position?.line && a.position?.character === b.position?.character;
}

/** Non-mutating: `member` may come from a cache shared across Outline
 * refreshes (`resolveThisMembers`'s attribute list, `mod.dataModelMembers`,
 * …), so this returns a new wrapper rather than editing it in place —
 * otherwise a "Связано" child would keep re-appending on every refresh. */
function crossLinkAttribute(
	member: IndexedMember,
	ownMechanismLabel: string,
	attrName: string | undefined,
	byAttrName: Map<string, RelatedRef[]>
): IndexedMember {
	const refs = attrName ? byAttrName.get(attrName) : undefined;
	if (!refs) {
		return member;
	}
	const others = refs.filter((r) => !(r.mechanismLabel === ownMechanismLabel && r.member === member));
	return withRelated(member, others);
}

/** Adds (or merges into an already-present) "Связано" child listing `refs` —
 * shared by the attribute-based cross-link above and the diff-name-based one
 * below, so a node touched by both (e.g. a Detail linked by attribute *and*
 * by its matching diff item) gets one combined list, not two separate
 * groups. Non-mutating for the same reason as `crossLinkAttribute`. */
function withRelated(member: IndexedMember, refs: RelatedRef[]): IndexedMember {
	if (!refs.length) {
		return member;
	}
	const newLeaves: IndexedMember[] = refs.map((r) => ({
		name: r.member.name,
		kind: "property",
		detail: r.mechanismLabel,
		position: r.member.position,
		filePath: r.member.filePath
	}));
	const children = member.children ? [...member.children] : [];
	const existingIdx = children.findIndex((c) => c.name === "Связано");
	if (existingIdx >= 0) {
		const existing = children[existingIdx];
		const merged = [...(existing.children || []), ...newLeaves];
		children[existingIdx] = { ...existing, detail: `${merged.length}`, children: merged };
	} else {
		children.push({ name: "Связано", kind: "namespace", detail: `${newLeaves.length}`, children: newLeaves });
	}
	return { ...member, children };
}

/** A genuine diff-tree node (as opposed to a "Заполненные свойства"/
 * "Доступные, но не заполненные" pseudo-group or one of their leaf
 * properties) always carries its operation as the leading word of `detail`
 * (see `diffNodeToMember` in amdAst.ts) — used to scope the name-based
 * registry lookup below to real diff items only, so an unrelated filled
 * property that happens to share a name with a Detail/Module can't
 * false-match. */
function isDiffOperationNode(member: IndexedMember): boolean {
	return ["insert", "merge", "remove", "move"].some((op) => member.detail?.startsWith(op));
}

function collectDiffOperationNodesByName(members: IndexedMember[], out: Map<string, IndexedMember>): void {
	for (const m of members) {
		if (isDiffOperationNode(m)) {
			out.set(m.name, m);
		}
		if (m.children) {
			collectDiffOperationNodesByName(m.children, out);
		}
	}
}

/**
 * The reverse direction of the Детали/Встроенные модули → diff link built in
 * `getGroups`: a `diff` item whose own `name` matches a `details{}`/
 * `modules{}` registry key gets a "Связано" entry pointing back at that
 * registry entry (confirmed matching mechanism — see CLAUDE.md §4b: a diff
 * DETAIL/MODULE item mounts by `name`, not by a `values.moduleName` field).
 */
function crossLinkDiffToRegistry(member: IndexedMember, registryByName: Map<string, RelatedRef>): IndexedMember {
	const children = member.children?.map((c) => crossLinkDiffToRegistry(c, registryByName));
	const withChildren = children === member.children ? member : { ...member, children };
	if (!isDiffOperationNode(member)) {
		return withChildren;
	}
	const match = registryByName.get(member.name);
	return match ? withRelated(withChildren, [match]) : withChildren;
}

function fileExists(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}
