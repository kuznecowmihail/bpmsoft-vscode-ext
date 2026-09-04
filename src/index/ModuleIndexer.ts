import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { parseAmdModule } from "../parse/amdParser";
import { IndexedModule } from "../parse/types";
import { SymbolIndex } from "./SymbolIndex";
import { buildPlatformStubs } from "../stubs/platformGlobals";
import { buildExtStubs } from "../stubs/extGlobals";
import { buildSandboxStubs } from "../stubs/sandboxGlobals";
import { buildNavigationMessages } from "../stubs/navigationMessages";
import {
	resolveAppLayouts,
	supportedAppLayouts,
	walkJsFiles,
	BpmsoftAppLayout
} from "./workspaceLayout";
import { computeDirFingerprint, loadPlatformIndexCache, savePlatformIndexCache } from "./platformIndexCache";
import { OwnedSchemaCacheEntry, loadOwnedSchemaCache, saveOwnedSchemaCache } from "./ownedSchemaCache";
import { parseDescriptorModifiedOnUtc } from "./schemaStructureParse";
import { isBoxedPackage } from "./packageOwnershipCheck";
import { enablePlatformStubs } from "../config";

const PLATFORM_CACHE_FILE_NAME = "platform-index-cache.json";
const OWNED_SCHEMA_CACHE_FILE_NAME = "owned-schema-cache.json";

export class ModuleIndexer {
	/** `cacheDir`/`extensionVersion` are both required for the
	 * `Resources/ui/BPMSoft` + `conf/content` cache (see
	 * `platformIndexCache.ts`) to actually be used — omit either (e.g. no
	 * workspace open yet, so no `context.storageUri`) and `rebuild` falls
	 * back to today's behavior of always parsing them fresh. */
	constructor(
		private readonly index: SymbolIndex,
		private readonly cacheDir?: string,
		private readonly extensionVersion?: string
	) {}

	/** `forceFresh` (the manual "Rebuild Index" command/button) skips
	 * reading the platform cache entirely — a guaranteed full re-parse,
	 * independent of whatever the fingerprint says — while still writing a
	 * fresh cache afterward. The automatic activation-time call leaves it
	 * `false`: the fingerprint already detects a real change (a BPMSoft
	 * version upgrade, or anything else that touched these files) on its
	 * own, so a normal activation only pays for a full parse when one is
	 * actually needed. */
	async rebuild(progress?: vscode.Progress<{ message?: string }>, forceFresh = false): Promise<number> {
		this.index.clearModules();
		const folders =
			vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];
		this.index.setWorkspaceRoots(folders);
		const layouts = supportedAppLayouts(resolveAppLayouts(folders));
		if (!layouts.length) {
			return 0;
		}

		const enableStubs = enablePlatformStubs();
		this.index.setPlatformStubs(
			enableStubs ? buildPlatformStubs(folders) : []
		);
		this.index.setExtStubs(buildExtStubs(folders));
		const sandbox = buildSandboxStubs(folders);
		this.index.setSandboxStubs(sandbox.members, sandbox.origin);
		this.index.setCoreMessages(buildNavigationMessages(folders));

		let freshFiles = this.collectFreshFiles(layouts);
		let platformFiles = this.collectPlatformFiles(layouts);
		let ownedSchemaFiles = this.collectOwnedSchemaFiles(layouts);
		if (!freshFiles.length && !platformFiles.length && !ownedSchemaFiles.length && layouts.length > 0) {
			freshFiles = await this.collectViaWorkspaceGlobs();
			platformFiles = [];
			ownedSchemaFiles = [];
		}

		let count = 0;
		for (const filePath of freshFiles) {
			progress?.report({ message: path.basename(filePath) });
			if (await this.indexFile(filePath)) {
				count++;
			}
		}
		count += await this.indexPlatformFiles(platformFiles, forceFresh, progress);
		count += await this.indexOwnedSchemaFiles(ownedSchemaFiles, forceFresh, progress);
		return count;
	}

	/** `Resources/ui/BPMSoft` + `conf/content/*Module*.js` — cache-eligible
	 * (see `platformIndexCache.ts`'s own doc for why). On a cache hit,
	 * upserts the cached `IndexedModule`s directly, skipping every file
	 * read/parse; on a miss (or `forceFresh`), parses as usual and writes a
	 * fresh cache from the result. */
	private async indexPlatformFiles(
		files: string[],
		forceFresh: boolean,
		progress?: vscode.Progress<{ message?: string }>
	): Promise<number> {
		if (!files.length) {
			return 0;
		}
		const cacheFilePath = this.cacheDir ? path.join(this.cacheDir, PLATFORM_CACHE_FILE_NAME) : undefined;
		const fingerprint = cacheFilePath ? computeDirFingerprint(files) : undefined;
		const cached =
			cacheFilePath && fingerprint && !forceFresh && this.extensionVersion
				? loadPlatformIndexCache(cacheFilePath, this.extensionVersion, fingerprint)
				: undefined;
		if (cached) {
			progress?.report({ message: `platform index (${cached.length} cached)` });
			for (const mod of cached) {
				this.index.upsertModule(mod);
			}
			return cached.length;
		}

		let count = 0;
		const parsed: IndexedModule[] = [];
		for (const filePath of files) {
			progress?.report({ message: path.basename(filePath) });
			const mod = await this.parseAndUpsert(filePath);
			if (mod) {
				parsed.push(mod);
				count++;
			}
		}
		if (cacheFilePath && fingerprint && this.extensionVersion) {
			savePlatformIndexCache(cacheFilePath, this.extensionVersion, fingerprint, parsed);
		}
		return count;
	}

	/** `Pkg/{OwnedPackage}/Schemas/**\/*.js` — one cache entry per schema
	 * (see `ownedSchemaCache.ts`'s own doc for why this needs per-file
	 * granularity, unlike `indexPlatformFiles`'s single fingerprint), keyed
	 * on that schema's own descriptor.json `ModifiedOnUtc` (kept current by
	 * `touchSchemaModifiedOnUtc` in `extension.ts` on every save). */
	private async indexOwnedSchemaFiles(
		files: string[],
		forceFresh: boolean,
		progress?: vscode.Progress<{ message?: string }>
	): Promise<number> {
		if (!files.length) {
			return 0;
		}
		const cacheFilePath = this.cacheDir ? path.join(this.cacheDir, OWNED_SCHEMA_CACHE_FILE_NAME) : undefined;
		const previousEntries =
			cacheFilePath && !forceFresh && this.extensionVersion
				? loadOwnedSchemaCache(cacheFilePath, this.extensionVersion)
				: undefined;
		const nextEntries: Record<string, OwnedSchemaCacheEntry> = {};

		let count = 0;
		for (const filePath of files) {
			const key = path.normalize(filePath);
			const descriptorPath = path.join(path.dirname(filePath), "descriptor.json");
			const modifiedOnUtc = readModifiedOnUtc(descriptorPath);
			const cached = modifiedOnUtc ? previousEntries?.[key] : undefined;
			if (cached && cached.modifiedOnUtc === modifiedOnUtc) {
				this.index.upsertModule(cached.module);
				nextEntries[key] = cached;
				count++;
				continue;
			}
			progress?.report({ message: path.basename(filePath) });
			const mod = await this.parseAndUpsert(filePath);
			if (mod) {
				count++;
				if (modifiedOnUtc) {
					nextEntries[key] = { modifiedOnUtc, module: mod };
				}
			}
		}
		if (cacheFilePath && this.extensionVersion) {
			saveOwnedSchemaCache(cacheFilePath, this.extensionVersion, nextEntries);
		}
		return count;
	}

	/**
	 * `BPMSoft.Configuration/Autogenerated/Src/*.js` — always parsed fresh,
	 * never cached (this is generated by every real WorkspaceConsole build,
	 * so it changes far too often for a between-activation cache to help).
	 */
	private collectFreshFiles(layouts: BpmsoftAppLayout[]): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		const add = (filePath: string) => {
			const key = path.normalize(filePath);
			if (seen.has(key)) {
				return;
			}
			seen.add(key);
			out.push(key);
		};
		for (const layout of layouts) {
			if (layout.autogeneratedRoot) {
				const src = path.join(layout.autogeneratedRoot, "Src");
				for (const file of walkJsFiles(src, (p) => p.endsWith(".js"))) {
					add(file);
				}
			}
		}
		return out;
	}

	/** `Resources/ui/BPMSoft` + `conf/content/*Module*.js` (platform-wide,
	 * see `indexPlatformFiles` for why these get the cache treatment) plus
	 * each *boxed* package's own `Autogenerated/Src/*.js` — a boxed package
	 * (see `isBoxedPackage`) ships only compiled output, no unlocked
	 * `Schemas/`, so this is the only content it can contribute; previously
	 * not indexed at all (not just uncached — e.g. a real installed
	 * package's own schemas, `Pkg/CentrexTelephony/Autogenerated/Src/*.js`,
	 * were invisible to hover/completion/definition). Equally safe to cache
	 * wholesale — a boxed package is by definition never edited here. */
	private collectPlatformFiles(layouts: BpmsoftAppLayout[]): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		const add = (filePath: string) => {
			const key = path.normalize(filePath);
			if (seen.has(key)) {
				return;
			}
			seen.add(key);
			out.push(key);
		};
		for (const layout of layouts) {
			if (layout.resourcesRoot) {
				const ui = path.join(layout.resourcesRoot, "ui", "BPMSoft");
				for (const file of walkJsFiles(ui, (p) => p.endsWith(".js"))) {
					add(file);
				}
			}
			if (layout.confContent) {
				for (const file of walkJsFiles(layout.confContent, isConfModuleFile)) {
					add(file);
				}
			}
			if (layout.pkgRoot) {
				for (const packageDir of boxedPackageDirs(layout.pkgRoot)) {
					const src = path.join(packageDir, "Autogenerated", "Src");
					for (const file of walkJsFiles(src, (p) => p.endsWith(".js"))) {
						add(file);
					}
				}
			}
		}
		return out;
	}

	/** `Pkg/{OwnedPackage}/Schemas/**\/*.js` — see `indexOwnedSchemaFiles`
	 * for the per-schema cache these go through. */
	private collectOwnedSchemaFiles(layouts: BpmsoftAppLayout[]): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		const add = (filePath: string) => {
			const key = path.normalize(filePath);
			if (seen.has(key)) {
				return;
			}
			seen.add(key);
			out.push(key);
		};
		for (const layout of layouts) {
			if (!layout.pkgRoot) {
				continue;
			}
			for (const packageDir of ownedPackageDirs(layout.pkgRoot)) {
				for (const file of walkJsFiles(path.join(packageDir, "Schemas"), (p) => p.endsWith(".js"))) {
					add(file);
				}
			}
		}
		return out;
	}

	private async collectViaWorkspaceGlobs(): Promise<string[]> {
		const cfg = vscode.workspace.getConfiguration("bpmsoft");
		const pkgGlob = cfg.get<string>("pkgGlob", "**/Pkg/**/Schemas/**/*.js");
		const autoGlob = cfg.get<string>(
			"autogeneratedGlob",
			"**/Autogenerated/Src/*.js"
		);
		const uiGlob = cfg.get<string>(
			"platformUiGlob",
			"**/Resources/ui/BPMSoft/**/*.js"
		);
		const confModuleGlob = "**/conf/content/*Module*.js";
		const globs = [pkgGlob, autoGlob, uiGlob, confModuleGlob].filter(
			(g) => g && g.trim().length > 0
		);
		const seen = new Set<string>();
		const out: string[] = [];
		for (const glob of globs) {
			const uris = await vscode.workspace.findFiles(glob, "**/node_modules/**");
			for (const uri of uris) {
				if (seen.has(uri.fsPath)) {
					continue;
				}
				seen.add(uri.fsPath);
				out.push(uri.fsPath);
			}
		}
		return out;
	}

	async indexFile(filePath: string): Promise<boolean> {
		return (await this.parseAndUpsert(filePath)) !== undefined;
	}

	/** Same as `indexFile`, but returns the parsed `IndexedModule` itself
	 * (not just whether it succeeded) — `indexPlatformFiles` needs the
	 * actual modules to write into the cache after a miss. */
	private async parseAndUpsert(filePath: string): Promise<IndexedModule | undefined> {
		try {
			const source = await fs.promises.readFile(filePath, "utf8");
			const mod = parseAmdModule(source, filePath);
			if (!mod) {
				this.index.removeByPath(filePath);
				return undefined;
			}
			this.index.upsertModule(mod);
			return mod;
		} catch {
			this.index.removeByPath(filePath);
			return undefined;
		}
	}

	removeFile(filePath: string): void {
		this.index.removeByPath(filePath);
	}
}

function isConfModuleFile(filePath: string): boolean {
	return /\/conf\/content\/[^/]*Module[^/]*\.js$/i.test(
		filePath.replace(/\\/g, "/")
	);
}

function packageDirs(pkgRoot: string, keep: (packageDir: string) => boolean): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(pkgRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.isDirectory())
		.map((e) => path.join(pkgRoot, e.name))
		.filter(keep);
}

function boxedPackageDirs(pkgRoot: string): string[] {
	return packageDirs(pkgRoot, isBoxedPackage);
}

function ownedPackageDirs(pkgRoot: string): string[] {
	return packageDirs(pkgRoot, (dir) => !isBoxedPackage(dir));
}

/** `descriptorPath`'s own `ModifiedOnUtc`, or `undefined` on any read/parse
 * failure or missing field — the caller treats that as "can't cache this
 * one reliably", not an error. */
function readModifiedOnUtc(descriptorPath: string): string | undefined {
	try {
		return parseDescriptorModifiedOnUtc(fs.readFileSync(descriptorPath, "utf8"));
	} catch {
		return undefined;
	}
}
