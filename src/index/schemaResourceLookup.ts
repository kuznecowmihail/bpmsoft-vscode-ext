import * as fs from "fs";
import * as path from "path";
import { readFileSafe } from "../fsUtils";
import { parsePkgPath } from "./pkgPath";

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

/** Reverse of `findResourceDirs`: given a `Resources/{SchemaName}.{Suffix}/
 * resource.{culture}.xml` path, resolves back to that schema's own
 * `Schemas/{SchemaName}/descriptor.json` — used so a resource-file edit
 * (which several naming checks read, e.g. a missing RU/EN Title, or a
 * Process element's own caption) can re-trigger the naming check for the
 * schema it belongs to, not just invalidate its own path (which nothing
 * else keys findings on). Matched the same way `findResourceDirs` matches
 * forward — by trying each real `Schemas/*` dir name as a dot-anchored
 * prefix of the resource folder name — rather than naively splitting on the
 * first dot, since a wrong guess there would just silently miss the schema
 * instead of erroring. `undefined` if the path isn't under a package's
 * `Resources/` at all, or no matching schema/descriptor exists on disk. */
export function findOwningSchemaDescriptor(resourceFilePath: string): string | undefined {
	const info = parsePkgPath(resourceFilePath);
	if (info?.category !== "Resources" || !info.itemName || !info.rest || !/^resource\.[^/]+\.xml$/i.test(info.rest)) {
		return undefined;
	}
	const resourceFolderName = info.itemName;
	const schemasRoot = path.join(info.packageDir, "Schemas");
	for (const entry of readDirSafe(schemasRoot)) {
		if (!entry.isDirectory() || !resourceFolderName.startsWith(`${entry.name}.`)) {
			continue;
		}
		const descriptorPath = path.join(schemasRoot, entry.name, "descriptor.json");
		if (fs.existsSync(descriptorPath)) {
			return descriptorPath;
		}
	}
	return undefined;
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

/** Generalizes `findSchemaDir` to any package item folder — a package's
 * content isn't only `Schemas/`, so anything watching "what changed in this
 * package" (Open Schemas grouping, Timeline's file set) needs to key off
 * `Pkg/{Package}/{ItemType}/{ItemName}/…` broadly, not just schemas. */
export function resolvePackageItem(filePath: string): PackageItemRef | undefined {
	const info = parsePkgPath(filePath);
	if (!info?.category || info.category === "Files" || !info.itemName || !info.itemDir) {
		return undefined;
	}
	return {
		packageName: info.packageName,
		itemType: info.category,
		itemName: info.itemName,
		itemDir: info.itemDir
	};
}

/** A Module-type client schema's own `{Name}.js` (its code) and, if present,
 * `{Name}.less` (its styles) — siblings of `descriptorPath` in the same
 * `Schemas/{Name}/` folder. `undefined` js means the schema's own source
 * couldn't be read (e.g. deleted mid-scan) — the caller skips module checks
 * entirely in that case rather than guessing. */
export function readModuleSource(
	descriptorPath: string,
	schemaName: string
): { js: string; less?: string } | undefined {
	const dir = path.dirname(descriptorPath);
	const js = readFileSafe(path.join(dir, `${schemaName}.js`));
	if (js === undefined) {
		return undefined;
	}
	return { js, less: readFileSafe(path.join(dir, `${schemaName}.less`)) };
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
