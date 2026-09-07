import * as fs from "fs";
import * as walk from "acorn-walk";
import { AnyNode, parseJs } from "./jsAst";
import { propName } from "./amdAst";

/**
 * Captions for STOCK (platform, `conf/content`) entities - a genuinely
 * different storage shape than a custom Pkg entity's own
 * `Resources/{Entity}.Entity/resource.{culture}.xml` (`entityMetadata.ts`).
 * A stock entity has no `Pkg/` folder at all, so its captions live in the
 * already-*compiled* client resource bundle instead:
 * `conf/content/resources/{culture}/{EntityName}Resources.js`, a plain AMD
 * module - confirmed real, e.g. `SysUserInRoleResources.js`:
 * ```js
 * define("SysUserInRoleResources", ["BPMSoft"], function(BPMSoft) {
 *   var localizableStrings = {
 *     SysUserInRoleCaption: "Вх...",  // the entity's own title
 *     SysUserCaption: "П...",              // Caption of column "SysUser"
 *     ...
 *   };
 *   ...
 * });
 * ```
 * Every value ends in the literal suffix `Caption`; the one keyed
 * `{EntityName}Caption` is the entity's own title, every other
 * `{ColumnName}Caption` is that column's. Parsed via the real JS parser
 * (not regex) since these are ordinary string literals `\u`-escaped by the
 * platform's own build step - acorn already decodes those for free.
 */

export interface StockEntityCaptions {
	entityCaption?: string;
	columnCaptions: Map<string, string>;
}

const CAPTION_SUFFIX = "Caption";

function parseLocalizableStrings(source: string): Map<string, string> | undefined {
	const ast = parseJs(source);
	if (!ast) {
		return undefined;
	}
	let result: Map<string, string> | undefined;
	walk.simple(ast, {
		VariableDeclarator(node: AnyNode) {
			if (result || node.id?.type !== "Identifier" || node.id.name !== "localizableStrings") {
				return;
			}
			const init = node.init as AnyNode;
			if (init?.type !== "ObjectExpression") {
				return;
			}
			const map = new Map<string, string>();
			for (const prop of init.properties as AnyNode[]) {
				if (prop.type !== "Property") {
					continue;
				}
				const key = propName(prop);
				const value = prop.value as AnyNode;
				if (key && value?.type === "Literal" && typeof value.value === "string") {
					map.set(key, value.value);
				}
			}
			result = map;
		}
	} as any);
	return result;
}

/**
 * Reads the first (best-locale-ranked, see `entityMetadata.ts#localeRank`)
 * resource file in `candidatePaths` that actually parses, and splits its
 * `{Name}Caption` keys into the entity's own caption vs. its columns'.
 * `undefined`/empty when no candidate exists or none parses.
 */
export function loadStockEntityCaptions(
	candidatePaths: string[],
	entityName: string
): StockEntityCaptions {
	for (const filePath of candidatePaths) {
		let source: string;
		try {
			source = fs.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		const strings = parseLocalizableStrings(source);
		if (!strings || !strings.size) {
			continue;
		}
		const columnCaptions = new Map<string, string>();
		let entityCaption: string | undefined;
		for (const [key, value] of strings) {
			if (!key.endsWith(CAPTION_SUFFIX) || !value) {
				continue;
			}
			const name = key.slice(0, -CAPTION_SUFFIX.length);
			if (!name) {
				continue;
			}
			if (name === entityName) {
				entityCaption = value;
			} else {
				columnCaptions.set(name, value);
			}
		}
		return { entityCaption, columnCaptions };
	}
	return { columnCaptions: new Map() };
}
