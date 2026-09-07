/**
 * A `Data/{Name}/` package item (naming-guidelines.md §5 "Данные") seeds
 * rows into an existing table/entity — `descriptor.json`'s `Descriptor.Schema.Name`
 * is that target table's real name (confirmed real, e.g.
 * `Data/City_Main/descriptor.json` → `Schema.Name: "City"`,
 * `Data/Lookup_GoFastFilterProfile/descriptor.json` → `Schema.Name: "Lookup"`,
 * `Data/SysSettings_GoPageZoomLevel/descriptor.json` → `Schema.Name: "SysSettings"`).
 * This is ground truth for the guideline's `{TableName}_...` naming
 * templates — no need to guess or hardcode which tables are "system" vs
 * "business", every Data schema names its own target table directly.
 * `descriptor.json` also lists the target table's own columns
 * (`Descriptor.Columns[].ColumnName`/`ColumnUId`), and the seeded row values
 * live in the sibling `data.json` (`PackageData[0].Row[].SchemaColumnUId`/
 * `Value`) — together these resolve one named column's actual seeded value,
 * used for the SysSettings/SysSettingsValue pairing check (matching by the
 * real row Id / "SysSettings" foreign-key value, not by folder-name string
 * matching).
 */

import { parseJsonNoBom } from "../textUtils";

export interface DataSchemaDescriptorInfo {
	/** `Descriptor.Name` — the Data schema's own Code (the `Data/{Name}/` folder name). */
	code: string;
	/** `Descriptor.Schema.Name` — the real table/entity this data seeds rows into. */
	tableName: string;
}

export function parseDataSchemaDescriptor(descriptorText: string): DataSchemaDescriptorInfo | undefined {
	const root = parseJsonNoBom(descriptorText) as
		| { Descriptor?: { Name?: unknown; Schema?: { Name?: unknown } } }
		| undefined;
	const code = root?.Descriptor?.Name;
	const tableName = root?.Descriptor?.Schema?.Name;
	if (typeof code !== "string" || !code || typeof tableName !== "string" || !tableName) {
		return undefined;
	}
	return { code, tableName };
}

function findColumnUId(descriptorRoot: unknown, columnName: string): string | undefined {
	const columns = (descriptorRoot as { Descriptor?: { Columns?: unknown } } | undefined)?.Descriptor?.Columns;
	if (!Array.isArray(columns)) {
		return undefined;
	}
	for (const column of columns) {
		if (column && typeof column === "object" && (column as Record<string, unknown>).ColumnName === columnName) {
			const uid = (column as Record<string, unknown>).ColumnUId;
			if (typeof uid === "string") {
				return uid;
			}
		}
	}
	return undefined;
}

function findRowValue(dataRoot: unknown, columnUId: string): string | undefined {
	const row = (dataRoot as { PackageData?: Array<{ Row?: unknown }> } | undefined)?.PackageData?.[0]?.Row;
	if (!Array.isArray(row)) {
		return undefined;
	}
	for (const cell of row) {
		if (cell && typeof cell === "object" && (cell as Record<string, unknown>).SchemaColumnUId === columnUId) {
			const value = (cell as Record<string, unknown>).Value;
			if (typeof value === "string") {
				return value;
			}
		}
	}
	return undefined;
}

/** One seeded row's value for a named column, e.g. `"Id"` (a SysSettings
 * row's own primary key — what a SysSettingsValue row's `"SysSettings"`
 * column points at) or `"SysSettings"` itself (a SysSettingsValue row's own
 * foreign-key value). `descriptorText` resolves the column's own UId for
 * this specific schema (column UIds aren't stable across tables), then
 * `dataText` supplies the actual seeded value. `undefined` on any parse
 * failure, missing column, or a non-string value (GUIDs/Codes are always
 * strings; a missing/`"null"`-literal reference also comes back as a real
 * string, which the caller treats as "no reference" separately). */
export function readDataRowColumnValue(
	descriptorText: string,
	dataText: string,
	columnName: string
): string | undefined {
	const descriptorRoot = parseJsonNoBom(descriptorText);
	const dataRoot = parseJsonNoBom(dataText);
	if (descriptorRoot === undefined || dataRoot === undefined) {
		return undefined;
	}
	const columnUId = findColumnUId(descriptorRoot, columnName);
	return columnUId ? findRowValue(dataRoot, columnUId) : undefined;
}
