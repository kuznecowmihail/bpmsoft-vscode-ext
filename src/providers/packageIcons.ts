import * as vscode from "vscode";

export type TopFolderKind = "Schemas" | "SqlScripts" | "Data" | "Resources" | "Files" | "Assemblies";

/** Icon for a package's top-level item-type folder — shared by
 * `PackagesTreeProvider` (the folder node itself) and `OpenSchemasTreeProvider`
 * (per-item icon, since it flattens straight to schemas/scripts/records
 * without the folder level in between). */
export function topFolderIcon(kind: TopFolderKind): vscode.ThemeIcon {
	switch (kind) {
		case "Schemas":
			return new vscode.ThemeIcon("symbol-class");
		case "SqlScripts":
			return new vscode.ThemeIcon("server-process");
		case "Data":
			return new vscode.ThemeIcon("table");
		case "Resources":
			return new vscode.ThemeIcon("globe");
		case "Files":
			return new vscode.ThemeIcon("files");
		case "Assemblies":
			return new vscode.ThemeIcon("library");
	}
}

export function schemaIcon(managerName: string | undefined, schemaType: string | undefined): vscode.ThemeIcon {
	switch (managerName) {
		case "EntitySchemaManager":
			return new vscode.ThemeIcon("database");
		case "ProcessSchemaManager":
			return new vscode.ThemeIcon("git-merge");
		case "ServiceSchemaManager":
			return new vscode.ThemeIcon("radio-tower");
		case "SourceCodeSchemaManager":
			return new vscode.ThemeIcon("symbol-class");
		case "ClientUnitSchemaManager":
			switch (schemaType) {
				case "EDIT_VIEW_MODEL_SCHEMA":
					return new vscode.ThemeIcon("browser");
				case "MODULE_VIEW_MODEL_SCHEMA":
					return new vscode.ThemeIcon("layout");
				case "GRID_DETAIL_VIEW_MODEL_SCHEMA":
					return new vscode.ThemeIcon("list-tree");
				case "MODULE":
					return new vscode.ThemeIcon("extensions");
				default:
					return new vscode.ThemeIcon("file-code");
			}
		default:
			return new vscode.ThemeIcon("file");
	}
}
