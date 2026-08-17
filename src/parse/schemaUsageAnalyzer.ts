import { collectThisMemberAccesses } from "./amdParser";
import { AnyNode, childNodes, parseJs } from "./jsAst";
import type { StyleFix, StyleIssue } from "./styleAnalyzer";

export interface InheritedSchemaNames {
	methods?: Set<string>;
	attributes?: Set<string>;
	messages?: Set<string>;
}

const SECTION_LABEL: Record<"methods" | "attributes" | "messages", {
	kind: StyleIssue["kind"];
	label: string;
}> = {
	methods: { kind: "unusedMethod", label: "Метод" },
	attributes: { kind: "unusedAttribute", label: "Атрибут" },
	messages: { kind: "unusedMessage", label: "Сообщение" }
};

export function collectSchemaUnusedIssues(
	source: string,
	inherited: InheritedSchemaNames = {},
	parsed?: AnyNode
): StyleIssue[] {
	const ast = parsed || parseJs(source);
	if (!ast) {
		return [];
	}
	const sections = {
		methods: [] as SectionProp[],
		attributes: [] as SectionProp[],
		messages: [] as SectionProp[]
	};
	collectSections(ast, sections);
	const used = collectUsedNames(source, ast);
	const issues: StyleIssue[] = [];
	for (const section of ["methods", "attributes", "messages"] as const) {
		const meta = SECTION_LABEL[section];
		pushUnused(
			issues,
			sections[section],
			used,
			inherited[section],
			meta.kind,
			meta.label
		);
	}
	return issues;
}

const DIFF_OPERATIONS = new Set(["merge", "move", "remove", "insert"]);

export function collectDiffDuplicateIssues(parsed: AnyNode): StyleIssue[] {
	const items: DiffItem[] = [];
	collectDiffItems(parsed, items);
	const groups = new Map<string, DiffItem[]>();
	for (const item of items) {
		const key = `${item.operation}\0${item.name}`;
		const list = groups.get(key);
		if (list) {
			list.push(item);
		} else {
			groups.set(key, [item]);
		}
	}
	const issues: StyleIssue[] = [];
	for (const group of groups.values()) {
		if (group.length < 2) {
			continue;
		}
		for (const item of group) {
			issues.push({
				kind: "duplicateDiff",
				start: item.nameStart,
				end: item.nameEnd,
				message: `Повторяющийся элемент diff: operation «${item.operation}», name «${item.name}»`,
				severity: "error"
			});
		}
	}
	return issues;
}

interface DiffItem {
	operation: string;
	name: string;
	nameStart: number;
	nameEnd: number;
}

function collectDiffItems(node: AnyNode | undefined, out: DiffItem[]): void {
	if (!node || typeof node.type !== "string") {
		return;
	}
	if (node.type === "ObjectExpression") {
		const props = (node.properties as AnyNode[]) || [];
		const keys = new Set(
			props.map((p) => propertyKeyName(p)).filter(Boolean) as string[]
		);
		if (isSchemaObject(keys)) {
			for (const prop of props) {
				if (propertyKeyName(prop) === "diff") {
					collectDiffArrayItems(prop.value as AnyNode, out);
				}
			}
		}
		for (const prop of props) {
			if (prop.type === "SpreadElement") {
				collectDiffItems(prop.argument, out);
				continue;
			}
			if (prop.computed) {
				collectDiffItems(prop.key, out);
			}
			collectDiffItems(prop.value, out);
		}
		return;
	}
	for (const child of childNodes(node)) {
		collectDiffItems(child, out);
	}
}

function isSchemaObject(keys: Set<string>): boolean {
	return (
		keys.has("methods") ||
		keys.has("attributes") ||
		keys.has("messages") ||
		keys.has("entitySchemaName") ||
		keys.has("mixins") ||
		keys.has("properties")
	);
}

function collectDiffArrayItems(node: AnyNode | undefined, out: DiffItem[]): void {
	if (!node || node.type !== "ArrayExpression") {
		return;
	}
	for (const el of (node.elements as AnyNode[]) || []) {
		if (!el || el.type !== "ObjectExpression") {
			continue;
		}
		const operation = objectStringProp(el, "operation");
		const name = objectStringProp(el, "name");
		if (
			!operation ||
			!name ||
			!DIFF_OPERATIONS.has(operation.value)
		) {
			continue;
		}
		out.push({
			operation: operation.value,
			name: name.value,
			nameStart: name.start,
			nameEnd: name.end
		});
	}
}

function objectStringProp(
	obj: AnyNode,
	key: string
): { value: string; start: number; end: number } | undefined {
	for (const prop of (obj.properties as AnyNode[]) || []) {
		if (prop.type === "SpreadElement" || propertyKeyName(prop) !== key) {
			continue;
		}
		const value = prop.value as AnyNode;
		if (value?.type === "Literal" && typeof value.value === "string" && value.value) {
			return {
				value: value.value,
				start: value.start as number,
				end: value.end as number
			};
		}
	}
	return undefined;
}

/** Keys that still mean a plain attribute config (usage is worth checking). */
const SIMPLE_ATTRIBUTE_KEYS = new Set(["dataValueType", "value", "type"]);

interface SectionProp {
	name: string;
	keyStart: number;
	keyEnd: number;
	obj: AnyNode;
	prop: AnyNode;
}

function collectSections(
	node: AnyNode | undefined,
	out: { methods: SectionProp[]; attributes: SectionProp[]; messages: SectionProp[] }
): void {
	if (!node || typeof node.type !== "string") {
		return;
	}
	if (node.type === "ObjectExpression") {
		for (const prop of (node.properties as AnyNode[]) || []) {
			if (prop.type === "SpreadElement") {
				collectSections(prop.argument, out);
				continue;
			}
			const name = propertyKeyName(prop);
			const value = prop.value as AnyNode;
			if (
				(name === "methods" || name === "attributes" || name === "messages") &&
				value?.type === "ObjectExpression"
			) {
				for (const inner of (value.properties as AnyNode[]) || []) {
					if (inner.type === "SpreadElement") {
						continue;
					}
					const innerName = propertyKeyName(inner);
					if (!innerName) {
						continue;
					}
					const key = inner.key as AnyNode;
					out[name].push({
						name: innerName,
						keyStart: key.start,
						keyEnd: key.end,
						obj: value,
						prop: inner
					});
				}
			}
			if (prop.computed) {
				collectSections(prop.key, out);
			}
			collectSections(value, out);
		}
		return;
	}
	for (const child of childNodes(node)) {
		collectSections(child, out);
	}
}

function collectUsedNames(source: string, ast: AnyNode): Set<string> {
	const used = new Set<string>();
	for (const access of collectThisMemberAccesses(source, ast)) {
		used.add(access.name);
	}
	collectStringLiterals(ast, used);
	return used;
}

function collectStringLiterals(node: AnyNode | undefined, used: Set<string>): void {
	if (!node || typeof node.type !== "string") {
		return;
	}
	if (node.type === "Literal" && typeof node.value === "string" && node.value) {
		used.add(node.value);
		return;
	}
	if (node.type === "ObjectExpression") {
		for (const prop of (node.properties as AnyNode[]) || []) {
			if (prop.type === "SpreadElement") {
				collectStringLiterals(prop.argument, used);
				continue;
			}
			if (prop.computed) {
				collectStringLiterals(prop.key, used);
			}
			collectStringLiterals(prop.value, used);
		}
		return;
	}
	if (node.type === "MemberExpression") {
		collectStringLiterals(node.object, used);
		if (node.computed) {
			collectStringLiterals(node.property, used);
		}
		return;
	}
	for (const child of childNodes(node)) {
		collectStringLiterals(child, used);
	}
}

function isSimpleAttributeConfig(prop: AnyNode): boolean {
	const value = prop.value as AnyNode | undefined;
	if (!value || value.type !== "ObjectExpression") {
		return false;
	}
	for (const inner of (value.properties as AnyNode[]) || []) {
		if (inner.type === "SpreadElement") {
			return false;
		}
		const name = propertyKeyName(inner);
		if (!name || !SIMPLE_ATTRIBUTE_KEYS.has(name)) {
			return false;
		}
	}
	return true;
}

function pushUnused(
	issues: StyleIssue[],
	props: SectionProp[],
	used: Set<string>,
	inherited: Set<string> | undefined,
	kind: StyleIssue["kind"],
	label: string
): void {
	const seen = new Set<string>();
	for (const prop of props) {
		if (
			kind === "unusedAttribute" &&
			!isSimpleAttributeConfig(prop.prop)
		) {
			seen.add(prop.name);
			continue;
		}
		if (seen.has(prop.name) || used.has(prop.name) || inherited?.has(prop.name)) {
			seen.add(prop.name);
			continue;
		}
		seen.add(prop.name);
		issues.push({
			kind,
			start: prop.keyStart,
			end: prop.keyEnd,
			message: `${label} «${prop.name}» объявлен, но не используется в этой схеме`,
			severity: "warning",
			fix: propertyRemovalFix(prop)
		});
	}
}

function propertyRemovalFix(item: SectionProp): StyleFix {
	const props = item.obj.properties as AnyNode[];
	const idx = props.indexOf(item.prop);
	let start = item.prop.start as number;
	let end = item.prop.end as number;
	if (idx >= 0 && idx < props.length - 1) {
		end = props[idx + 1].start as number;
	} else if (idx > 0) {
		start = props[idx - 1].end as number;
	}
	return {
		title: "Удалить неиспользуемое объявление",
		start,
		end,
		text: ""
	};
}

function propertyKeyName(prop: AnyNode): string | undefined {
	if (prop.computed) {
		return undefined;
	}
	const key = prop.key as AnyNode;
	if (!key) {
		return undefined;
	}
	if (key.type === "Identifier") {
		return key.name as string;
	}
	if (key.type === "Literal" && typeof key.value === "string") {
		return key.value;
	}
	return undefined;
}
