import * as fs from "fs";
import * as path from "path";
import {
	BpmsoftAppLayout,
	resolveAppLayouts
} from "./workspaceLayout";

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
	source: "stack" | "pkg-extra" | "structure-parent";
}

const STRUCTURES_RE =
	/BPMSoft\.configuration\.Structures\["([^"]+)"\]\s*=\s*\{([^}]*)\}/;

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
	private pkgNamesCache: string[] | null = null;
	private layouts: BpmsoftAppLayout[] = [];
	private platformExtendCache = new Map<string, string | null>();

	setWorkspaceRoots(roots: string[]): void {
		this.confContentDirs = [];
		this.configurationRoots = [];
		this.structureCache.clear();
		this.platformExtendCache.clear();
		this.pkgNamesCache = null;
		this.layouts = resolveAppLayouts(roots);

		for (const layout of this.layouts) {
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

	getLayouts(): BpmsoftAppLayout[] {
		return this.layouts;
	}

	hasRoots(): boolean {
		return this.configurationRoots.length > 0 || this.confContentDirs.length > 0;
	}

	resolveEntitySchemaPath(entityName: string): string | undefined {
		if (!entityName || !/^[A-Za-z_][\w]*$/.test(entityName)) {
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

	parseStructure(schemaName: string): SchemaStructure | null {
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
		while (current && !visited.has(current)) {
			visited.add(current);
			chain.push(current);
			const structure = this.parseStructure(current);
			current = structure?.structureParent || undefined;
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
	 * Includes structureParent recursion and Pkg schemas missing from the stack.
	 */
	resolveSchemaLayers(schemaName: string): HierarchyLayer[] {
		const layers: HierarchyLayer[] = [];
		const seenFiles = new Set<string>();
		const visitedSchemas = new Set<string>();

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
			if (!name || visitedSchemas.has(name)) {
				return;
			}
			visitedSchemas.add(name);

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
				walk(structure.structureParent);
			}
		};

		walk(schemaName);
		return layers;
	}

	/**
	 * Resolve one stack entry to a source file.
	 * Prefer unlocked Pkg, then Autogenerated locked.
	 */
	resolveStackEntry(
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

	findPkgSchemaFiles(schemaName: string): string[] {
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

	findAutogeneratedSchemaFiles(schemaName: string): string[] {
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

	listPackageNames(): string[] {
		if (this.pkgNamesCache) {
			return this.pkgNamesCache;
		}
		const names = new Set<string>();
		for (const root of this.configurationRoots) {
			const pkgRoot = path.join(root, "Pkg");
			if (!fs.existsSync(pkgRoot)) {
				continue;
			}
			try {
				for (const name of fs.readdirSync(pkgRoot)) {
					if (name === "README.md" || name.startsWith(".")) {
						continue;
					}
					names.add(name);
				}
			} catch {
				// ignore
			}
		}
		this.pkgNamesCache = Array.from(names);
		return this.pkgNamesCache;
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
