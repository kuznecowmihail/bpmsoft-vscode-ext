import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { readFileSafe } from "../fsUtils";
import { resolveAppLayouts } from "../index/workspaceLayout";
import { parseDescriptorInfo } from "../index/schemaStructureParse";
import { SymbolIndex } from "../index/SymbolIndex";
import { NamingIssuesIndex } from "../index/NamingIssuesIndex";
import { findResourceDirs } from "../index/schemaResourceLookup";
import { TopFolderKind, topFolderIcon, schemaIcon } from "./packageIcons";

const TOP_FOLDER_ORDER: TopFolderKind[] = [
	"Schemas",
	"SqlScripts",
	"Data",
	"Resources",
	"Files",
	"Assemblies"
];

type PackagesNode =
	| { kind: "category"; label: string; packages: { name: string; path: string }[] }
	| { kind: "package"; name: string; path: string }
	| { kind: "folder"; folderKind: TopFolderKind; path: string }
	| { kind: "schema"; name: string; path: string; managerName?: string; schemaType?: string }
	| { kind: "sqlScript"; name: string; path: string }
	| { kind: "fsEntry"; path: string; isDirectory: boolean; label: string }
	| { kind: "shortcutGroup"; label: "Ресурсы" | "Иерархия"; schemaName: string; schemaPath: string }
	| { kind: "shortcutItem"; label: string; targetPath: string };

const WARNING_COLOR = new vscode.ThemeColor("problemsWarningIcon.foreground");
const MUTED_COLOR = new vscode.ThemeColor("disabledForeground");

const REGULAR_LABEL = "Пакеты";
const BOXED_LABEL = "Коробочные пакеты";

/**
 * Lazy (Explorer-like — reads the filesystem only on expand, never scans
 * `Pkg` eagerly) tree of Pkg/{Package}/{Data,Files,Resources,Schemas,
 * SqlScripts,Assemblies}, with BPMSoft-aware icons and naming-issue
 * decorations layered on top of the plain folder structure.
 */
export class PackagesTreeProvider implements vscode.TreeDataProvider<PackagesNode> {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	constructor(
		private readonly index: SymbolIndex,
		private readonly namingIndex: NamingIssuesIndex
	) {
		namingIndex.onDidChangeFindings(() => this.changeEmitter.fire());
	}

	refresh(): void {
		this.changeEmitter.fire();
	}

	getChildren(node?: PackagesNode): PackagesNode[] {
		if (!node) {
			return this.getCategories();
		}
		if (node.kind === "category") {
			return node.packages.map((p) => ({ kind: "package", ...p }) as PackagesNode);
		}
		if (node.kind === "package") {
			return [...this.getTopFolders(node.path), ...this.getPackageRootFiles(node.path)];
		}
		if (node.kind === "folder" && node.folderKind === "Schemas") {
			return this.getSchemaEntries(node.path);
		}
		if (node.kind === "folder" && node.folderKind === "SqlScripts") {
			return this.getSqlScriptEntries(node.path);
		}
		if (node.kind === "folder") {
			return this.getFsEntries(node.path);
		}
		if (node.kind === "schema") {
			return [...this.getShortcutGroups(node), ...this.getFsEntries(node.path)];
		}
		if (node.kind === "sqlScript") {
			return this.getFsEntries(node.path);
		}
		if (node.kind === "fsEntry" && node.isDirectory) {
			return this.getFsEntries(node.path);
		}
		if (node.kind === "shortcutGroup" && node.label === "Ресурсы") {
			return this.getResourceShortcuts(node);
		}
		if (node.kind === "shortcutGroup" && node.label === "Иерархия") {
			return this.getHierarchyShortcuts(node);
		}
		return [];
	}

	/** Required for `TreeView.reveal()` to work — VS Code walks this chain
	 * from a target node up to the root before expanding back down. Always
	 * reconstructs the *canonical* filesystem-shaped parent (package → top
	 * folder → schema/sqlScript → …), never a "Ресурсы"/"Иерархия" shortcut —
	 * a shortcut can point at a file also reachable the plain way (or, for
	 * hierarchy layers, at a file outside `Pkg` entirely), so it has no
	 * single well-defined parent chain of its own. */
	getParent(node: PackagesNode): PackagesNode | undefined {
		switch (node.kind) {
			case "category":
				return undefined;
			case "package":
				return this.getCategories().find(
					(c) =>
						c.kind === "category" &&
						c.packages.some((p) => path.normalize(p.path) === path.normalize(node.path))
				);
			case "folder": {
				const packagePath = path.dirname(node.path);
				return { kind: "package", name: path.basename(packagePath), path: packagePath };
			}
			case "schema":
			case "sqlScript": {
				const folderPath = path.dirname(node.path);
				return { kind: "folder", folderKind: path.basename(folderPath) as TopFolderKind, path: folderPath };
			}
			case "fsEntry":
				return this.parentForFsPath(node.path);
			case "shortcutGroup":
				return this.schemaNodeForDir(node.schemaPath);
			case "shortcutItem":
				return this.parentForFsPath(node.targetPath);
		}
	}

	/** Given an arbitrary path under `Pkg`, walks one level up and figures
	 * out what kind of node that directory is — a package root, a top
	 * folder, a schema/sqlScript directory, or just a plain nested folder —
	 * purely from where it sits, so it always matches what the forward
	 * `getChildren` traversal would have produced for the same directory. */
	private parentForFsPath(fsPath: string): PackagesNode | undefined {
		const dirPath = path.dirname(fsPath);
		if (this.isPackageDirRoot(dirPath)) {
			return { kind: "package", name: path.basename(dirPath), path: dirPath };
		}
		for (const kind of TOP_FOLDER_ORDER) {
			if (path.basename(dirPath) === kind && this.isPackageDirRoot(path.dirname(dirPath))) {
				return { kind: "folder", folderKind: kind, path: dirPath };
			}
		}
		const grandParent = path.dirname(dirPath);
		if (path.basename(grandParent) === "Schemas" && this.isPackageDirRoot(path.dirname(grandParent))) {
			return this.schemaNodeForDir(dirPath);
		}
		if (path.basename(grandParent) === "SqlScripts" && this.isPackageDirRoot(path.dirname(grandParent))) {
			return { kind: "sqlScript", name: path.basename(dirPath), path: dirPath };
		}
		return { kind: "fsEntry", path: dirPath, isDirectory: true, label: path.basename(dirPath) };
	}

	/** Whether `dirPath` is itself a package folder, i.e. a direct child of
	 * some workspace's `Pkg` root. */
	private isPackageDirRoot(dirPath: string): boolean {
		const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];
		const layouts = resolveAppLayouts(folders);
		const parent = path.dirname(dirPath);
		return layouts.some((l) => l.pkgRoot && path.normalize(l.pkgRoot) === path.normalize(parent));
	}

	/** The node `reveal()` should be asked to show for a file just opened in
	 * the editor — `undefined` when it isn't under any workspace's `Pkg` at
	 * all. Every real file (schema source, descriptor.json, a Data/Resources
	 * item, …) is a plain `fsEntry` leaf; `getParent` reconstructs the rest
	 * of the chain up from there. */
	nodeForFilePath(fsPath: string): PackagesNode | undefined {
		const normalized = fsPath.replace(/\\/g, "/");
		if (!/\/Pkg\/[^/]+\//i.test(normalized)) {
			return undefined;
		}
		return { kind: "fsEntry", path: fsPath, isDirectory: false, label: path.basename(fsPath) };
	}

	getTreeItem(node: PackagesNode): vscode.TreeItem {
		const item = this.buildTreeItem(node);
		// A stable id (independent of object identity, which changes every
		// refresh since nodes are plain objects rebuilt from disk) is what
		// lets VS Code's TreeView.reveal() — and its own expand/select-state
		// preservation across refreshes — actually find the right node.
		item.id = nodeId(node);
		return item;
	}

	private buildTreeItem(node: PackagesNode): vscode.TreeItem {
		if (node.kind === "category") {
			const item = new vscode.TreeItem(
				`${node.label} (${node.packages.length})`,
				node.label === BOXED_LABEL
					? vscode.TreeItemCollapsibleState.Collapsed
					: vscode.TreeItemCollapsibleState.Expanded
			);
			item.iconPath = new vscode.ThemeIcon(
				node.label === BOXED_LABEL ? "archive" : "folder-library"
			);
			item.contextValue = "bpmsoftPackageCategory";
			return item;
		}
		if (node.kind === "package") {
			return this.packageTreeItem(node);
		}
		if (node.kind === "folder") {
			const item = new vscode.TreeItem(
				node.folderKind,
				vscode.TreeItemCollapsibleState.Collapsed
			);
			item.iconPath = topFolderIcon(node.folderKind);
			item.contextValue = "bpmsoftPackageFolder";
			if (this.namingIndex.hasIssuesUnder(node.path)) {
				item.description = "⚠";
			}
			return item;
		}
		if (node.kind === "schema") {
			return this.schemaTreeItem(node);
		}
		if (node.kind === "sqlScript") {
			return this.sqlScriptTreeItem(node);
		}
		if (node.kind === "shortcutGroup") {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
			item.iconPath = new vscode.ThemeIcon(
				node.label === "Ресурсы" ? "globe" : "type-hierarchy"
			);
			item.contextValue = "bpmsoftShortcutGroup";
			return item;
		}
		if (node.kind === "shortcutItem") {
			const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
			item.iconPath = new vscode.ThemeIcon("file-symlink-file");
			item.resourceUri = vscode.Uri.file(node.targetPath);
			item.command = {
				command: "vscode.open",
				title: "Открыть",
				arguments: [item.resourceUri]
			};
			return item;
		}
		const item = new vscode.TreeItem(
			node.label,
			node.isDirectory
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None
		);
		item.resourceUri = vscode.Uri.file(node.path);
		if (!node.isDirectory) {
			item.command = { command: "vscode.open", title: "Открыть", arguments: [item.resourceUri] };
		}
		return item;
	}

	private packageTreeItem(node: { name: string; path: string }): vscode.TreeItem {
		const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
		item.contextValue = "bpmsoftPackage";
		item.resourceUri = vscode.Uri.file(node.path);
		const boxed = isBoxedPackage(node.path);
		const hasIssues = this.namingIndex.hasIssuesUnder(node.path);
		item.iconPath = new vscode.ThemeIcon(
			"package",
			boxed ? MUTED_COLOR : hasIssues ? WARNING_COLOR : undefined
		);
		if (hasIssues) {
			item.tooltip = "В этом пакете есть проблемы с неймингом";
		}
		return item;
	}

	/** Naming-issue text is shown via the registered `NamingDecorationProvider`
	 * (label color + badge) rather than a `description` string — a manual
	 * description ends up rendered in the same color as the label, which
	 * doesn't read as an error/warning. */
	private schemaTreeItem(node: {
		name: string;
		path: string;
		managerName?: string;
		schemaType?: string;
	}): vscode.TreeItem {
		const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
		item.contextValue = "bpmsoftSchema";
		item.resourceUri = vscode.Uri.file(node.path);
		const findings = this.namingIndex.getForPath(path.join(node.path, "descriptor.json"));
		const icon = schemaIcon(node.managerName, node.schemaType);
		if (findings.length) {
			item.iconPath = new vscode.ThemeIcon(icon.id, WARNING_COLOR);
			item.tooltip = findings.map((f) => f.message).join("\n");
		} else {
			item.iconPath = icon;
		}
		return item;
	}

	private sqlScriptTreeItem(node: { name: string; path: string }): vscode.TreeItem {
		const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
		item.contextValue = "bpmsoftSqlScript";
		item.resourceUri = vscode.Uri.file(node.path);
		const findings = this.namingIndex.getForPath(path.join(node.path, "descriptor.json"));
		if (findings.length) {
			item.iconPath = new vscode.ThemeIcon("server-process", WARNING_COLOR);
			item.tooltip = findings.map((f) => f.message).join("\n");
		} else {
			item.iconPath = new vscode.ThemeIcon("server-process");
		}
		return item;
	}

	/** Splits packages into "regular" vs "boxed" (Files-only, §4 of the naming
	 * doc — no editable source, just a stock/vendor drop) so the two don't
	 * clutter the same flat list. */
	private getCategories(): PackagesNode[] {
		const all = this.getRawPackages();
		const regular = all.filter((p) => !isBoxedPackage(p.path));
		const boxed = all.filter((p) => isBoxedPackage(p.path));
		const out: PackagesNode[] = [];
		if (regular.length) {
			out.push({ kind: "category", label: REGULAR_LABEL, packages: regular });
		}
		if (boxed.length) {
			out.push({ kind: "category", label: BOXED_LABEL, packages: boxed });
		}
		return out;
	}

	private getRawPackages(): { name: string; path: string }[] {
		const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];
		const layouts = resolveAppLayouts(folders);
		const seen = new Set<string>();
		const out: { name: string; path: string }[] = [];
		for (const layout of layouts) {
			if (!layout.pkgRoot) {
				continue;
			}
			for (const entry of readDirSafe(layout.pkgRoot)) {
				if (!entry.isDirectory()) {
					continue;
				}
				const fullPath = path.join(layout.pkgRoot, entry.name);
				const key = path.normalize(fullPath);
				if (seen.has(key) || !isPackageDir(fullPath)) {
					continue;
				}
				seen.add(key);
				out.push({ name: entry.name, path: fullPath });
			}
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	private getTopFolders(packagePath: string): PackagesNode[] {
		const present = new Set(
			readDirSafe(packagePath)
				.filter((e) => e.isDirectory())
				.map((e) => e.name)
		);
		return TOP_FOLDER_ORDER.filter((k) => present.has(k)).map(
			(folderKind) =>
				({ kind: "folder", folderKind, path: path.join(packagePath, folderKind) }) as PackagesNode
		);
	}

	private getSchemaEntries(schemasFolderPath: string): PackagesNode[] {
		return readDirSafe(schemasFolderPath)
			.filter((e) => e.isDirectory())
			.map((e) => this.schemaNodeForDir(path.join(schemasFolderPath, e.name)))
			.sort((a, b) => byName(a).localeCompare(byName(b)));
	}

	/** Builds a `schema` node for a known `.../Schemas/{Name}` directory —
	 * shared by `getSchemaEntries` (forward listing) and `getParent`
	 * (reconstructing an ancestor for `reveal()`), so the two can never
	 * disagree about what a schema node looks like. */
	private schemaNodeForDir(schemaPath: string): PackagesNode {
		const name = path.basename(schemaPath);
		const descriptorPath = path.join(schemaPath, "descriptor.json");
		const text = readFileSafe(descriptorPath);
		const info = text ? parseDescriptorInfo(text) : undefined;
		const managerName = info?.managerName;
		const schemaName = info?.name || name;
		const schemaType =
			managerName === "ClientUnitSchemaManager"
				? this.index.hierarchy.resolveSchemaType(schemaName)
				: undefined;
		return { kind: "schema", name, path: schemaPath, managerName, schemaType };
	}

	/** The package's own `descriptor.json` (and any other stray file sitting
	 * directly in the package root) — `getTopFolders` only looks at
	 * subdirectories, so these were previously invisible. */
	private getPackageRootFiles(packagePath: string): PackagesNode[] {
		return readDirSafe(packagePath)
			.filter((e) => e.isFile())
			.map(
				(e) =>
					({
						kind: "fsEntry" as const,
						path: path.join(packagePath, e.name),
						isDirectory: false,
						label: e.name
					}) satisfies PackagesNode
			)
			.sort((a, b) => (a.kind === "fsEntry" ? a.label : "").localeCompare(b.kind === "fsEntry" ? b.label : ""));
	}

	private getSqlScriptEntries(sqlScriptsFolderPath: string): PackagesNode[] {
		return readDirSafe(sqlScriptsFolderPath)
			.filter((e) => e.isDirectory())
			.map(
				(e) =>
					({
						kind: "sqlScript",
						name: e.name,
						path: path.join(sqlScriptsFolderPath, e.name)
					}) as PackagesNode
			)
			.sort((a, b) => byName(a).localeCompare(byName(b)));
	}

	/** "Ресурсы"/"Иерархия" shortcut group headers under a schema node —
	 * only shown when there's actually something to jump to. */
	private getShortcutGroups(node: {
		name: string;
		path: string;
		managerName?: string;
	}): PackagesNode[] {
		const out: PackagesNode[] = [];
		if (findResourceDirs(node.path, node.name).length) {
			out.push({ kind: "shortcutGroup", label: "Ресурсы", schemaName: node.name, schemaPath: node.path });
		}
		if (node.managerName === "ClientUnitSchemaManager") {
			const jsFile = path.join(node.path, `${node.name}.js`);
			const layers = this.index.hierarchy.resolveSchemaLayers(node.name, jsFile);
			if (layers.length > 1) {
				out.push({
					kind: "shortcutGroup",
					label: "Иерархия",
					schemaName: node.name,
					schemaPath: node.path
				});
			}
		}
		return out;
	}

	private getResourceShortcuts(node: { schemaName: string; schemaPath: string }): PackagesNode[] {
		return findResourceDirs(node.schemaPath, node.schemaName).map(
			(dirPath) =>
				({
					kind: "fsEntry" as const,
					path: dirPath,
					isDirectory: true,
					label: path.basename(dirPath)
				}) satisfies PackagesNode
		);
	}

	private getHierarchyShortcuts(node: { schemaName: string; schemaPath: string }): PackagesNode[] {
		const jsFile = path.join(node.schemaPath, `${node.schemaName}.js`);
		const layers = this.index.hierarchy.resolveSchemaLayers(node.schemaName, jsFile);
		return layers.map(
			(layer) =>
				({
					kind: "shortcutItem" as const,
					label: layer.packageName || path.basename(layer.filePath),
					targetPath: layer.filePath
				}) satisfies PackagesNode
		);
	}

	private getFsEntries(dirPath: string): PackagesNode[] {
		return readDirSafe(dirPath)
			.map(
				(e) =>
					({
						kind: "fsEntry" as const,
						path: path.join(dirPath, e.name),
						isDirectory: e.isDirectory(),
						label: e.name
					}) satisfies PackagesNode
			)
			.sort((a, b) => {
				if (a.kind !== "fsEntry" || b.kind !== "fsEntry") {
					return 0;
				}
				if (a.isDirectory !== b.isDirectory) {
					return a.isDirectory ? -1 : 1;
				}
				return a.label.localeCompare(b.label);
			});
	}
}

function byName(node: PackagesNode): string {
	return "name" in node ? node.name : "";
}

/** Stable per-node id for `getTreeItem`/`reveal()` — namespaced by `kind` so
 * a "Ресурсы"/"Иерархия" shortcut pointing at a file that's *also* reachable
 * through the plain filesystem chain (a resource dir, a hierarchy layer that
 * happens to be the schema's own .js file, …) never collides with that
 * file's "real" id. */
function nodeId(node: PackagesNode): string {
	const norm = (p: string) => path.normalize(p);
	switch (node.kind) {
		case "category":
			return `category:${node.label}`;
		case "package":
			return `package:${norm(node.path)}`;
		case "folder":
			return `folder:${norm(node.path)}`;
		case "schema":
			return `schema:${norm(node.path)}`;
		case "sqlScript":
			return `sqlScript:${norm(node.path)}`;
		case "fsEntry":
			return `fsEntry:${norm(node.path)}`;
		case "shortcutGroup":
			return `shortcutGroup:${norm(node.schemaPath)}:${node.label}`;
		case "shortcutItem":
			return `shortcutItem:${norm(node.targetPath)}:${node.label}`;
	}
}

function readDirSafe(dirPath: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dirPath, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** `Autogenerated` (code-gen output, present alongside `Files` on plenty of
 * boxed packages, e.g. `OpenIdAuth`) doesn't count as real editable source —
 * ignore it when deciding whether a package is Files-only/"boxed". */
const IGNORED_FOR_BOXED_CHECK = new Set(["Autogenerated"]);

/** `Pkg/` can contain stray non-package directories (build caches, tooling
 * dirs, …) alongside real packages — a real package always has at least one
 * of its standard content folders or its own `descriptor.json`. Filtering on
 * this keeps such directories out of the Packages tree entirely instead of
 * showing them as empty/misleading package nodes. */
function isPackageDir(dirPath: string): boolean {
	if (fs.existsSync(path.join(dirPath, "descriptor.json"))) {
		return true;
	}
	const dirs = new Set(
		readDirSafe(dirPath)
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
	);
	return TOP_FOLDER_ORDER.some((kind) => dirs.has(kind));
}

function isBoxedPackage(packagePath: string): boolean {
	const dirs = readDirSafe(packagePath)
		.filter((e) => e.isDirectory() && !IGNORED_FOR_BOXED_CHECK.has(e.name))
		.map((e) => e.name);
	return dirs.length === 1 && dirs[0] === "Files";
}

