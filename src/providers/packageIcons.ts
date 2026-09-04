import * as vscode from "vscode";

export type TopFolderKind = "Schemas" | "SqlScripts" | "Data" | "Resources" | "Files" | "Assemblies";

/** Categorical icon colors — the `charts.*` theme tokens are VS Code's own
 * palette for exactly this ("give distinct data categories a distinct,
 * theme-adapting hue"), the same family the Testing/Ports views use. Plain
 * codicons default to flat `foreground` gray, which is what made this whole
 * icon set look monotone; this is the fix, not a switch to another
 * extension's icon assets (there's no supported way to reuse those — see
 * `PACKAGE_COLOR` below and its callers for the one color shared across
 * files, everything else stays local to whichever icon function uses it). */
const SCHEMAS_COLOR = new vscode.ThemeColor("charts.blue");
const SQL_SCRIPTS_COLOR = new vscode.ThemeColor("charts.orange");
const DATA_COLOR = new vscode.ThemeColor("charts.green");
const RESOURCES_COLOR = new vscode.ThemeColor("charts.purple");
const ASSEMBLIES_COLOR = new vscode.ThemeColor("charts.yellow");

/** Shared with `NamingIssuesTreeProvider`'s own "package" grouping node, so
 * a package reads as the same color in both trees. */
export const PACKAGE_COLOR = new vscode.ThemeColor("charts.blue");

/** Icon for a package's top-level item-type folder — shared by
 * `PackagesTreeProvider` (the folder node itself) and `OpenSchemasTreeProvider`
 * (per-item icon, since it flattens straight to schemas/scripts/records
 * without the folder level in between). */
export function topFolderIcon(kind: TopFolderKind): vscode.ThemeIcon {
	switch (kind) {
		case "Schemas":
			return new vscode.ThemeIcon("symbol-class", SCHEMAS_COLOR);
		case "SqlScripts":
			return new vscode.ThemeIcon("server-process", SQL_SCRIPTS_COLOR);
		case "Data":
			return new vscode.ThemeIcon("table", DATA_COLOR);
		case "Resources":
			return new vscode.ThemeIcon("globe", RESOURCES_COLOR);
		case "Files":
			// Deliberately uncolored — a catch-all bucket for whatever doesn't
			// fit the other categories, not a category of its own.
			return new vscode.ThemeIcon("files");
		case "Assemblies":
			return new vscode.ThemeIcon("library", ASSEMBLIES_COLOR);
	}
}

const ENTITY_COLOR = new vscode.ThemeColor("charts.green");
const PROCESS_COLOR = new vscode.ThemeColor("charts.purple");
const SERVICE_COLOR = new vscode.ThemeColor("charts.orange");
const SOURCE_CODE_COLOR = new vscode.ThemeColor("charts.yellow");
const CLIENT_SCHEMA_COLOR = new vscode.ThemeColor("charts.blue");

export function schemaIcon(managerName: string | undefined, schemaType: string | undefined): vscode.ThemeIcon {
	switch (managerName) {
		case "EntitySchemaManager":
			return new vscode.ThemeIcon("database", ENTITY_COLOR);
		case "ProcessSchemaManager":
			return new vscode.ThemeIcon("git-merge", PROCESS_COLOR);
		case "ServiceSchemaManager":
			return new vscode.ThemeIcon("radio-tower", SERVICE_COLOR);
		case "SourceCodeSchemaManager":
			return new vscode.ThemeIcon("symbol-class", SOURCE_CODE_COLOR);
		case "ClientUnitSchemaManager":
			switch (schemaType) {
				case "EDIT_VIEW_MODEL_SCHEMA":
					return new vscode.ThemeIcon("browser", CLIENT_SCHEMA_COLOR);
				case "MODULE_VIEW_MODEL_SCHEMA":
					return new vscode.ThemeIcon("layout", CLIENT_SCHEMA_COLOR);
				case "GRID_DETAIL_VIEW_MODEL_SCHEMA":
					return new vscode.ThemeIcon("list-tree", CLIENT_SCHEMA_COLOR);
				case "MODULE":
					return new vscode.ThemeIcon("extensions", CLIENT_SCHEMA_COLOR);
				default:
					return new vscode.ThemeIcon("file-code", CLIENT_SCHEMA_COLOR);
			}
		default:
			// Unrecognized manager — no category to color it by.
			return new vscode.ThemeIcon("file");
	}
}
