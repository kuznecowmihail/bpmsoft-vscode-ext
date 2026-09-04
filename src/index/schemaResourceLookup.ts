import * as fs from "fs";
import * as path from "path";

function readDirSafe(dirPath: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dirPath, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** `Resources/{SchemaName}.{Suffix}` dirs for the schema at `schemaPath`
 * (`.../Schemas/{SchemaName}`) — matched by prefix rather than a hardcoded
 * ManagerName→suffix map (ClientUnit/Entity/Process/…), since a wrong guess
 * there would just silently hide a real resource dir. Shared by
 * `PackagesTreeProvider` (resource shortcut) and `SchemaHistoryTreeProvider`
 * (which files count as "this schema" for `git log`). */
export function findResourceDirs(schemaPath: string, schemaName: string): string[] {
	const packageRoot = path.dirname(path.dirname(schemaPath));
	const resourcesRoot = path.join(packageRoot, "Resources");
	const prefix = `${schemaName}.`;
	return readDirSafe(resourcesRoot)
		.filter((e) => e.isDirectory() && e.name.startsWith(prefix))
		.map((e) => path.join(resourcesRoot, e.name));
}

/** `.../Schemas/{SchemaName}` for a file somewhere under a schema's own
 * folder (e.g. `.../Schemas/LeadPageV2/LeadPageV2.js`), or `undefined` if
 * `filePath` isn't under a `Schemas/{Name}/` folder at all. */
export function findSchemaDir(filePath: string): { schemaDir: string; schemaName: string } | undefined {
	const normalized = filePath.replace(/\\/g, "/");
	const match = /^(.*\/Schemas\/([^/]+))\//.exec(normalized);
	if (!match) {
		return undefined;
	}
	return { schemaDir: match[1].replace(/\//g, path.sep), schemaName: match[2] };
}

export interface PackageItemRef {
	packageName: string;
	itemType: "Schemas" | "SqlScripts" | "Data" | "Resources";
	itemName: string;
	itemDir: string;
}

const PACKAGE_ITEM_RE = /^(.*\/Pkg\/([^/]+)\/(Schemas|SqlScripts|Data|Resources)\/([^/]+))\//;

/** Generalizes `findSchemaDir` to any package item folder — a package's
 * content isn't only `Schemas/`, so anything watching "what changed in this
 * package" (Open Schemas grouping, Timeline's file set) needs to key off
 * `Pkg/{Package}/{ItemType}/{ItemName}/…` broadly, not just schemas. */
export function resolvePackageItem(filePath: string): PackageItemRef | undefined {
	const normalized = filePath.replace(/\\/g, "/");
	const match = PACKAGE_ITEM_RE.exec(normalized);
	if (!match) {
		return undefined;
	}
	return {
		packageName: match[2],
		itemType: match[3] as PackageItemRef["itemType"],
		itemName: match[4],
		itemDir: match[1].replace(/\//g, path.sep)
	};
}

/** All real files that make up a schema: its own folder's files (recursively,
 * mostly flat in practice) plus any `Resources/{Name}.*` localization files. */
export function collectSchemaFiles(schemaDir: string, schemaName: string): string[] {
	const own = readDirSafe(schemaDir)
		.filter((e) => e.isFile())
		.map((e) => path.join(schemaDir, e.name));
	const resourceFiles: string[] = [];
	for (const resourceDir of findResourceDirs(schemaDir, schemaName)) {
		for (const entry of readDirSafe(resourceDir)) {
			if (entry.isFile()) {
				resourceFiles.push(path.join(resourceDir, entry.name));
			}
		}
	}
	return [...own, ...resourceFiles];
}

/** Flat file list for a non-schema package item (`SqlScripts/{Name}/`,
 * `Data/{Name}/`, `Resources/{Name}/`) — these don't have the Resources-merge
 * concern `collectSchemaFiles` handles, they're just a folder's own files. */
export function collectPackageItemFiles(itemDir: string): string[] {
	return readDirSafe(itemDir)
		.filter((e) => e.isFile())
		.map((e) => path.join(itemDir, e.name));
}
