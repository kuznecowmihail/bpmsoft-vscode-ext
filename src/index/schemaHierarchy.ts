import * as fs from "fs";
import * as path from "path";
import { resolveAppLayouts } from "./workspaceLayout";

export interface SchemaStructure {
	schemaName: string;
	innerHierarchyStack: string[];
	structureParent?: string;
}

export interface HierarchyLayer {
	/** File with schema AMD source */
	filePath: string;
	/** Package name if known (Lead, GoRestaurantsMain, …) */
	packageName?: string;
	/** Stack entry that produced this layer, if any */
	stackEntry?: string;
		source: "stack" | "pkg-extra";
}

const STRUCTURES_RE =
	/BPMSoft\.configuration\.Structures\["([^"]+)"\]\s*=\s*\{([^}]*)\}/;
const MAX_SCHEMA_WALK_DEPTH = 50;
const ENTITY_NAME_RE = /^[A-Za-z_][\w]*$/;

function isEntityName(name: string): boolean {
	return Boolean(name) && ENTITY_NAME_RE.test(name);
}

/**
 * Resolves Creatio/BPMSoft schema replacement chains via conf/content Structures.
 *
 * Stack order: left = base parent, right = most derived (wins on override).
 * Returned layers are ordered child → parent (first-wins for member merge).
 */
export class SchemaHierarchyResolver {
	private confContentDirs: string[] = [];
	private configurationRoots: string[] = [];
	private structureCache = new Map<string, SchemaStructure | null>();
	private platformExtendCache = new Map<string, string | null>();
	private descriptorParentCache = new Map<string, string | null>();

	setWorkspaceRoots(roots: string[]): void {
		this.clear();
		const layouts = resolveAppLayouts(roots);

		for (const layout of layouts) {
			if (layout.confContent) {
				this.confContentDirs.push(layout.confContent);
			}
			if (layout.configurationRoot) {
				this.configurationRoots.push(layout.configurationRoot);
			}
		}

		// Fallback for unusual layouts: keep old direct probes
		if (!this.confContentDirs.length && !this.configurationRoots.length) {
			for (const root of roots) {
				const conf = path.join(root, "conf", "content");
				if (fs.existsSync(conf)) {
					this.confContentDirs.push(conf);
				}
				const cfg = path.join(root, "BPMSoft.Configuration");
				if (fs.existsSync(cfg)) {
					this.configurationRoots.push(cfg);
				}
				if (
					path.basename(root) === "BPMSoft.Configuration" &&
					fs.existsSync(root)
				) {
					this.configurationRoots.push(root);
				}
			}
		}
	}

	clear(): void {
		this.confContentDirs = [];
		this.configurationRoots = [];
		this.structureCache.clear();
		this.platformExtendCache.clear();
		this.descriptorParentCache.clear();
	}

	hasRoots(): boolean {
		return this.configurationRoots.length > 0 || this.confContentDirs.length > 0;
	}

	resolveEntitySchemaPath(entityName: string): string | undefined {
		if (!isEntityName(entityName)) {
			return undefined;
		}
		for (const dir of this.confContentDirs) {
			const filePath = path.join(dir, `${entityName}.js`);
			if (fs.existsSync(filePath)) {
				return filePath;
			}
		}
		return undefined;
	}

	/** Pkg/{Package}/Schemas/{Entity}/metadata.json — custom entity columns. */
	resolveEntityPkgMetadataPaths(entityName: string): string[] {
		return this.collectPkgEntityFiles(entityName, (pkg, name) =>
			path.join(pkg, "Schemas", name, "metadata.json")
		);
	}

	/** Pkg/{Package}/Resources/{Entity}.Entity — column captions. */
	resolveEntityPkgResourceDirs(entityName: string): string[] {
		return this.collectPkgEntityFiles(entityName, (pkg, name) =>
			path.join(pkg, "Resources", `${name}.Entity`)
		);
	}

	private collectPkgEntityFiles(
		entityName: string,
		joinFromPkg: (pkgDir: string, entityName: string) => string
	): string[] {
		if (!isEntityName(entityName)) {
			return [];
		}
		const out: string[] = [];
		for (const pkgDir of this.pkgPackageDirs()) {
			const candidate = joinFromPkg(pkgDir, entityName);
			if (fs.existsSync(candidate)) {
				out.push(candidate);
			}
		}
		return out;
	}

	private pkgPackageDirs(): string[] {
		const out: string[] = [];
		for (const root of this.configurationRoots) {
			const pkgRoot = path.join(root, "Pkg");
			if (!fs.existsSync(pkgRoot)) {
				continue;
			}
			let packages: string[];
			try {
				packages = fs.readdirSync(pkgRoot);
			} catch {
				continue;
			}
			for (const pkg of packages) {
				out.push(path.join(pkgRoot, pkg));
			}
		}
		return out;
	}

	private parseStructure(schemaName: string): SchemaStructure | null {
		const cached = this.structureCache.get(schemaName);
		if (cached !== undefined) {
			return cached;
		}
		for (const dir of this.confContentDirs) {
			const filePath = path.join(dir, `${schemaName}.js`);
			if (!fs.existsSync(filePath)) {
				continue;
			}
			try {
				const head = fs.readFileSync(filePath, "utf8").slice(0, 4000);
				const parsed = parseStructuresLine(head, schemaName);
				if (parsed) {
					this.structureCache.set(schemaName, parsed);
					return parsed;
				}
			} catch {
				// ignore
			}
		}
		this.structureCache.set(schemaName, null);
		return null;
	}

	/**
	 * Parent schema from Pkg/.../Schemas/{Name}/descriptor.json.
	 * Used only when the schema is absent from conf/content.
	 *
	 * Parent.Name === schemaName is a replacement (ExtendParent from another
	 * package), not a walk target — skip it and look at other packages for a
	 * real parent so the walk cannot loop on the same name.
	 */
	private readDescriptorParent(
		schemaName: string,
		preferredFilePath?: string
	): string | undefined {
		if (!preferredFilePath) {
			const cached = this.descriptorParentCache.get(schemaName);
			if (cached !== undefined) {
				return cached || undefined;
			}
		}
		const files = this.descriptorSchemaFiles(schemaName, preferredFilePath);
		for (const filePath of files) {
			const parent = this.parseDescriptorFile(
				descriptorPathForSchemaFile(filePath)
			);
			if (parent && parent !== schemaName) {
				if (!preferredFilePath) {
					this.descriptorParentCache.set(schemaName, parent);
				}
				return parent;
			}
		}
		if (!preferredFilePath) {
			this.descriptorParentCache.set(schemaName, null);
		}
		return undefined;
	}

	private descriptorSchemaFiles(
		schemaName: string,
		preferredFilePath?: string
	): string[] {
		const preferred = preferredFilePath
			? normalizePath(preferredFilePath)
			: "";
		const files = this.findPkgSchemaFiles(schemaName).map(normalizePath);
		if (!preferred) {
			return files;
		}
		const rest = files.filter((p) => p !== preferred);
		if (fs.existsSync(preferred)) {
			return [preferred, ...rest];
		}
		return rest;
	}

	private parseDescriptorFile(descriptorPath: string): string | undefined {
		if (!descriptorPath || !fs.existsSync(descriptorPath)) {
			return undefined;
		}
		try {
			return parseDescriptorParent(fs.readFileSync(descriptorPath, "utf8"));
		} catch {
			return undefined;
		}
	}

	/**
	 * Walk structureParent to the root schema (no parent), then read
	 * extend: "BPMSoft.model.BaseViewModel" from that conf Structure define.
	 */
	resolvePlatformExtendClass(schemaName: string): string | undefined {
		if (!schemaName) {
			return undefined;
		}
		const chain: string[] = [];
		const visited = new Set<string>();
		let current: string | undefined = schemaName;
		while (
			current &&
			!visited.has(current) &&
			chain.length < MAX_SCHEMA_WALK_DEPTH
		) {
			visited.add(current);
			chain.push(current);
			const structure = this.parseStructure(current);
			if (structure?.structureParent) {
				current = shouldWalkDescriptorParent(
					current,
					structure.structureParent,
					visited
				)
					? structure.structureParent
					: undefined;
			} else if (!structure) {
				const parent = this.readDescriptorParent(current);
				current = shouldWalkDescriptorParent(current, parent, visited)
					? parent
					: undefined;
			} else {
				current = undefined;
			}
		}
		for (let i = chain.length - 1; i >= 0; i--) {
			const ext = this.readPlatformExtend(chain[i]);
			if (ext) {
				return ext;
			}
		}
		return undefined;
	}

	private readPlatformExtend(schemaName: string): string | undefined {
		const cached = this.platformExtendCache.get(schemaName);
		if (cached !== undefined) {
			return cached || undefined;
		}
		for (const dir of this.confContentDirs) {
			const filePath = path.join(dir, `${schemaName}.js`);
			if (!fs.existsSync(filePath)) {
				continue;
			}
			try {
				const head = fs.readFileSync(filePath, "utf8").slice(0, 30000);
				const ext = parseStructurePlatformExtend(head);
				this.platformExtendCache.set(schemaName, ext || null);
				return ext;
			} catch {
				// ignore
			}
		}
		this.platformExtendCache.set(schemaName, null);
		return undefined;
	}

	/**
	 * Full schema inheritance as file layers, child → parent.
	 * Includes structureParent recursion, descriptor.json Parent when the
	 * schema is missing from conf/content, and Pkg schemas missing from the stack.
	 */
	resolveSchemaLayers(
		schemaName: string,
		fromFilePath?: string
	): HierarchyLayer[] {
		const layers: HierarchyLayer[] = [];
		const seenFiles = new Set<string>();
		const visitedSchemas = new Set<string>();
		let depth = 0;

		const appendUnique = (layer: HierarchyLayer) => {
			const key = normalizePath(layer.filePath);
			if (seenFiles.has(key)) {
				return;
			}
			if (!fs.existsSync(layer.filePath)) {
				return;
			}
			seenFiles.add(key);
			layers.push({ ...layer, filePath: key });
		};

		const walk = (name: string) => {
			if (
				!name ||
				visitedSchemas.has(name) ||
				depth >= MAX_SCHEMA_WALK_DEPTH
			) {
				return;
			}
			visitedSchemas.add(name);
			depth += 1;

			const structure = this.parseStructure(name);
			const stack = structure?.innerHierarchyStack?.length
				? structure.innerHierarchyStack
				: [name];

			const stackPackages = new Set<string>();
			const stackLayersRtl: HierarchyLayer[] = [];

			for (let i = stack.length - 1; i >= 0; i--) {
				const entry = stack[i];
				const resolved = this.resolveStackEntry(name, entry);
				if (!resolved) {
					continue;
				}
				if (resolved.packageName) {
					stackPackages.add(resolved.packageName);
				}
				stackLayersRtl.push({
					filePath: resolved.filePath,
					packageName: resolved.packageName,
					stackEntry: entry,
					source: "stack"
				});
			}

			// Unlocked Pkg schemas not listed in conf stack (still contribute methods)
			const extras = this.findPkgSchemaFiles(name).filter((p) => {
				const pkg = packageFromPkgPath(p);
				if (pkg && stackPackages.has(pkg)) {
					return false;
				}
				const key = normalizePath(p);
				return !stackLayersRtl.some((l) => normalizePath(l.filePath) === key);
			});

			for (const filePath of extras) {
				appendUnique({
					filePath,
					packageName: packageFromPkgPath(filePath),
					source: "pkg-extra"
				});
			}
			for (const layer of stackLayersRtl) {
				appendUnique(layer);
			}

			if (structure?.structureParent) {
				if (
					shouldWalkDescriptorParent(
						name,
						structure.structureParent,
						visitedSchemas
					)
				) {
					walk(structure.structureParent);
				}
			} else if (!structure) {
				const preferred =
					name === schemaName ? fromFilePath : undefined;
				const parent = this.readDescriptorParent(name, preferred);
				if (shouldWalkDescriptorParent(name, parent, visitedSchemas)) {
					walk(parent);
				}
			}
		};

		walk(schemaName);
		return layers;
	}

	/**
	 * Resolve one stack entry to a source file.
	 * Prefer unlocked Pkg, then Autogenerated locked.
	 */
	private resolveStackEntry(
		schemaName: string,
		entry: string
	): { filePath: string; packageName?: string } | undefined {
		const pkg = packageFromStackEntry(schemaName, entry);
		if (pkg) {
			const fromPkg = this.pkgSchemaPath(schemaName, pkg);
			if (fromPkg) {
				return { filePath: fromPkg, packageName: pkg };
			}
			const fromAuto = this.autogeneratedSchemaPath(schemaName, pkg);
			if (fromAuto) {
				return { filePath: fromAuto, packageName: pkg };
			}
			return undefined;
		}

		// Bare schema name = topmost replacement: Autogen not covered by other stack
		// packages, or any remaining Autogen / Pkg candidate.
		const structure = this.parseStructure(schemaName);
		const namedPackages = new Set(
			(structure?.innerHierarchyStack || [])
				.map((e) => packageFromStackEntry(schemaName, e))
				.filter((p): p is string => Boolean(p))
		);

		for (const auto of this.findAutogeneratedSchemaFiles(schemaName)) {
			const autoPkg = packageFromAutogenPath(auto, schemaName);
			if (autoPkg && namedPackages.has(autoPkg)) {
				continue;
			}
			return { filePath: auto, packageName: autoPkg };
		}

		for (const pkgFile of this.findPkgSchemaFiles(schemaName)) {
			const p = packageFromPkgPath(pkgFile);
			if (p && namedPackages.has(p)) {
				continue;
			}
			return { filePath: pkgFile, packageName: p };
		}

		return undefined;
	}

	private pkgSchemaPath(schemaName: string, packageName: string): string | undefined {
		for (const root of this.configurationRoots) {
			const candidate = path.join(
				root,
				"Pkg",
				packageName,
				"Schemas",
				schemaName,
				`${schemaName}.js`
			);
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
		return undefined;
	}

	private autogeneratedSchemaPath(
		schemaName: string,
		packageName: string
	): string | undefined {
		for (const root of this.configurationRoots) {
			const candidate = path.join(
				root,
				"Autogenerated",
				"Src",
				`${schemaName}.${packageName}.js`
			);
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
		return undefined;
	}

	private findPkgSchemaFiles(schemaName: string): string[] {
		const out: string[] = [];
		for (const root of this.configurationRoots) {
			const pkgRoot = path.join(root, "Pkg");
			if (!fs.existsSync(pkgRoot)) {
				continue;
			}
			let packages: string[];
			try {
				packages = fs.readdirSync(pkgRoot);
			} catch {
				continue;
			}
			for (const pkg of packages) {
				const candidate = path.join(
					pkgRoot,
					pkg,
					"Schemas",
					schemaName,
					`${schemaName}.js`
				);
				if (fs.existsSync(candidate)) {
					out.push(candidate);
				}
			}
		}
		return out;
	}

	private findAutogeneratedSchemaFiles(schemaName: string): string[] {
		const out: string[] = [];
		const prefix = `${schemaName}.`;
		for (const root of this.configurationRoots) {
			const dir = path.join(root, "Autogenerated", "Src");
			if (!fs.existsSync(dir)) {
				continue;
			}
			let files: string[];
			try {
				files = fs.readdirSync(dir);
			} catch {
				continue;
			}
			for (const file of files) {
				if (!file.startsWith(prefix) || !file.endsWith(".js")) {
					continue;
				}
				// skip CSS companions like LeadPageV2CSS.CoreLead.js when schema is LeadPageV2
				const rest = file.slice(prefix.length, -".js".length);
				if (!rest || rest.includes(".")) {
					continue;
				}
				out.push(path.join(dir, file));
			}
		}
		return out;
	}
}

export function packageFromStackEntry(
	schemaName: string,
	entry: string
): string | undefined {
	if (!entry) {
		return undefined;
	}
	if (entry === schemaName) {
		return undefined;
	}
	if (entry.startsWith(schemaName)) {
		const pkg = entry.slice(schemaName.length);
		return pkg || undefined;
	}
	return undefined;
}

export function parseStructuresLine(
	source: string,
	expectedSchema?: string
): SchemaStructure | null {
	const text = source.replace(/^\uFEFF/, "");
	const match = text.match(STRUCTURES_RE);
	if (!match) {
		return null;
	}
	const schemaName = match[1];
	if (expectedSchema && schemaName !== expectedSchema) {
		return null;
	}
	const body = match[2];
	const stackMatch = body.match(/innerHierarchyStack\s*:\s*\[([^\]]*)\]/);
	if (!stackMatch) {
		return null;
	}
	const innerHierarchyStack = Array.from(
		stackMatch[1].matchAll(/"([^"]+)"/g),
		(m) => m[1]
	);
	const parentMatch = body.match(/structureParent\s*:\s*"([^"]*)"/);
	return {
		schemaName,
		innerHierarchyStack,
		structureParent: parentMatch?.[1] || undefined
	};
}

/**
 * First Structure `extend: "BPMSoft.…"` / `Ext.…` in a conf/content schema file.
 * Schema-to-schema extend (extend: "BaseDataViewNUI") is ignored.
 */
export function parseStructurePlatformExtend(source: string): string | undefined {
	const text = source.replace(/^\uFEFF/, "");
	const match = text.match(
		/\bextend\s*:\s*['"]((?:BPMSoft|Ext)\.[\w.]+)['"]/
	);
	return match?.[1];
}

/**
 * Whether to follow descriptor/structure parent.
 * Same-name Parent is a replacement from another package — do not walk it
 * (that would recurse forever). Already visited names are also skipped.
 */
export function shouldWalkDescriptorParent(
	currentSchema: string,
	parentName: string | undefined,
	visitedSchemas: Set<string>
): parentName is string {
	return Boolean(
		parentName &&
			parentName !== currentSchema &&
			!visitedSchemas.has(parentName)
	);
}

/**
 * Parent.Name from a client schema descriptor.json.
 */
export function parseDescriptorParent(source: string): string | undefined {
	try {
		const json = JSON.parse(source.replace(/^\uFEFF/, ""));
		const root = json?.Descriptor && typeof json.Descriptor === "object"
			? json.Descriptor
			: json;
		const name = root?.Parent?.Name;
		if (typeof name === "string" && /^[A-Za-z_][\w]*$/.test(name)) {
			return name;
		}
	} catch {
		// ignore
	}
	return undefined;
}

function descriptorPathForSchemaFile(filePath: string): string {
	return path.join(path.dirname(filePath), "descriptor.json");
}

function packageFromPkgPath(filePath: string): string | undefined {
	const norm = normalizePath(filePath);
	const m = norm.match(/\/Pkg\/([^/]+)\/Schemas\//);
	return m?.[1];
}

function packageFromAutogenPath(
	filePath: string,
	schemaName: string
): string | undefined {
	const base = path.basename(filePath);
	const prefix = `${schemaName}.`;
	if (!base.startsWith(prefix) || !base.endsWith(".js")) {
		return undefined;
	}
	return base.slice(prefix.length, -".js".length);
}

function normalizePath(p: string): string {
	return path.normalize(p);
}
