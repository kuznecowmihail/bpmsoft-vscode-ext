import { AnyNode, childNodes } from "./jsAst";
import { GENERIC_ENUM_FIELD_NAMES } from "./enumHints";

/**
 * One AST walk that finds every place `EnumInlayHintsProvider.ts` and
 * `HoverProvider.ts` care about: a numeric literal on a recognized coded
 * field (`dataValueType`/`itemType`/`contentType`/`comparisonType`
 * anywhere, `ruleType`/`property` only inside a `rules`/`businessRules`
 * rule-config object), and each `rules`/`businessRules` rule-id key itself
 * (for the "what does this rule do" description hint/hover). Shared by both
 * providers so they agree on exactly where a hint lives.
 */
export type EnumHintSite =
	| {
			kind: "literal";
			scope: "generic";
			fieldName: string;
			rawValue: string;
			start: number;
			end: number;
	  }
	| {
			kind: "literal";
			scope: "rule";
			fieldName: "ruleType" | "property";
			rawValue: string;
			ruleTypeRaw: string | undefined;
			start: number;
			end: number;
	  }
	| {
			kind: "ruleId";
			attrName: string;
			ruleId: string;
			ruleObj: AnyNode | undefined;
			start: number;
			end: number;
	  };

export function collectEnumHintSites(parsed: AnyNode | undefined): EnumHintSite[] {
	const out: EnumHintSite[] = [];
	walk(parsed, out);
	return out;
}

function keyName(prop: AnyNode): string | undefined {
	if (prop.computed) {
		return undefined;
	}
	const key = prop.key as AnyNode | undefined;
	if (key?.type === "Identifier") {
		return key.name as string;
	}
	if (key?.type === "Literal" && typeof key.value === "string") {
		return key.value;
	}
	return undefined;
}

function literalString(node: AnyNode | undefined): string | undefined {
	return node?.type === "Literal" && (typeof node.value === "number" || typeof node.value === "string")
		? String(node.value)
		: undefined;
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

function walk(node: AnyNode | undefined, out: EnumHintSite[]): void {
	if (!node || typeof node.type !== "string") {
		return;
	}
	if (node.type === "ObjectExpression") {
		const props = (node.properties as AnyNode[]) || [];
		const keys = new Set(props.map((p) => keyName(p)).filter(Boolean) as string[]);
		if (isSchemaObject(keys)) {
			for (const prop of props) {
				const name = keyName(prop);
				if (name === "rules" || name === "businessRules") {
					walkRuleSection(prop.value as AnyNode, out);
				}
			}
		}
		for (const prop of props) {
			if (prop.type === "Property" && !prop.computed) {
				const name = keyName(prop);
				const value = prop.value as AnyNode;
				const raw = literalString(value);
				if (name && raw !== undefined && GENERIC_ENUM_FIELD_NAMES.has(name)) {
					out.push({
						kind: "literal",
						scope: "generic",
						fieldName: name,
						rawValue: raw,
						start: value.start as number,
						end: value.end as number
					});
				}
			}
			if (prop.type === "SpreadElement") {
				walk(prop.argument, out);
				continue;
			}
			if (prop.computed) {
				walk(prop.key, out);
			}
			walk(prop.value, out);
		}
		return;
	}
	for (const child of childNodes(node)) {
		walk(child, out);
	}
}

/** `{ AttrName: { RuleId: {...} } }` — one level down from the `rules`/
 * `businessRules` property itself. Each rule-config object also contributes
 * its own `ruleType`/`property` literal sites (rule-scoped, so they aren't
 * picked up by the generic scan above). */
function walkRuleSection(attrsObj: AnyNode | undefined, out: EnumHintSite[]): void {
	if (!attrsObj || attrsObj.type !== "ObjectExpression") {
		return;
	}
	for (const attrProp of attrsObj.properties as AnyNode[]) {
		const attrName = keyName(attrProp);
		const ruleMapObj = attrProp.value as AnyNode;
		if (!attrName || ruleMapObj?.type !== "ObjectExpression") {
			continue;
		}
		for (const ruleProp of ruleMapObj.properties as AnyNode[]) {
			const ruleId = keyName(ruleProp);
			const ruleObj = ruleProp.value as AnyNode;
			if (!ruleId || ruleObj?.type !== "ObjectExpression") {
				continue;
			}
			const key = ruleProp.key as AnyNode;
			out.push({
				kind: "ruleId",
				attrName,
				ruleId,
				ruleObj,
				start: key.start as number,
				end: key.end as number
			});
			const ruleTypeProp = ruleObj.properties.find((p: AnyNode) => keyName(p) === "ruleType") as
				| AnyNode
				| undefined;
			const ruleTypeValue = ruleTypeProp?.value as AnyNode | undefined;
			const ruleTypeRaw = literalString(ruleTypeValue);
			if (ruleTypeRaw !== undefined) {
				out.push({
					kind: "literal",
					scope: "rule",
					fieldName: "ruleType",
					rawValue: ruleTypeRaw,
					ruleTypeRaw,
					start: ruleTypeValue!.start as number,
					end: ruleTypeValue!.end as number
				});
			}
			const propertyProp = ruleObj.properties.find((p: AnyNode) => keyName(p) === "property") as
				| AnyNode
				| undefined;
			const propertyValue = propertyProp?.value as AnyNode | undefined;
			const propertyRaw = literalString(propertyValue);
			if (propertyRaw !== undefined) {
				out.push({
					kind: "literal",
					scope: "rule",
					fieldName: "property",
					rawValue: propertyRaw,
					ruleTypeRaw,
					start: propertyValue!.start as number,
					end: propertyValue!.end as number
				});
			}
		}
	}
}
