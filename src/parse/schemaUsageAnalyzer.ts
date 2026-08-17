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
		pushUnused(issues, sections[section], used, inherited[section], meta.kind, meta.label);
	}
	return issues;
}

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
