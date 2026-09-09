import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "child_process";
import { escapeRegExp, readFileSafe, readFileSafeAsync } from "../fsUtils";
import { offsetToLineCharacter } from "../textOffset";
import { resolveAppLayouts, walkFiles } from "./workspaceLayout";
import { pMap } from "./concurrency";
import { IndexingProgressReporter } from "./indexingProgress";
import {
	CachedFinding,
	NamingIssuesCacheData,
	buildStamps,
	emptyNamingIssuesCache,
	loadNamingIssuesCache,
	saveNamingIssuesCache,
	stampsMatch
} from "./namingIssuesCache";
import {
	parseDescriptorInfo,
	parseDescriptorParent,
	parseSqlScriptDescriptorName
} from "./schemaStructureParse";
import { findResourceDirs, findSchemaDir, readModuleSource } from "./schemaResourceLookup";
import { findPkgRoot, packageNameFromPkgPath } from "./pkgPath";
import {
	ClientSchemaNamingContext,
	ClientSchemaNamingSettings,
	checkClientSchemaNaming
} from "../parse/schemaNamingAnalyzer";
import { checkCaptionCoverage, extractNamingSubject } from "../parse/namingCommon";
import { CsharpNamingSettings, checkCsharpSchemaNaming } from "../parse/csharpSchemaAnalyzer";
import { checkSqlScriptNaming } from "../parse/sqlNamingAnalyzer";
import {
	EntityCodeOccurrence,
	EntityNamingSettings,
	checkEntityCodeNaming,
	checkEntityColumnNaming,
	findEntityCodeCollisions,
	stripPrefix
} from "../parse/entityNamingAnalyzer";
import { parsePkgEntityColumns } from "../parse/entityMetadata";
import {
	ProcessNamingSettings,
	checkProcessCodeNaming,
	checkProcessElementNaming
} from "../parse/processNamingAnalyzer";
import {
	findProcessElementCaption,
	findResourceItemCaption,
	locateProcessElementOffset,
	parseProcessMetadataItemsByClassName,
	parseProcessSchemaElements
} from "../parse/processElementsMetadata";
import {
	ProcessUserTaskNamingSettings,
	checkProcessUserTaskCodeNaming,
	checkProcessUserTaskParameterNaming
} from "../parse/processUserTaskNamingAnalyzer";
import { parseDataSchemaDescriptor, readDataRowColumnValue } from "../parse/dataSchemaMetadata";
import {
	SysSettingsOccurrence,
	SysSettingsValueOccurrence,
	checkDataSchemaCodeNaming,
	findSysSettingsPairingIssues
} from "../parse/dataSchemaNamingAnalyzer";
import { SymbolIndex } from "./SymbolIndex";
import {
	csharpNamingDiagnosticsEnabled,
	csharpNamingRoleSuffixes,
	dataNamingDiagnosticsEnabled,
	entityNamingCheckSingular,
	entityNamingDateSuffixes,
	entityNamingDiagnosticsEnabled,
	entityNamingBooleanPrefixes,
	entityNamingSingularExceptions,
	namingDiagnosticsEnabled,
	namingIgnoredNames,
	namingPrefixes,
	processNamingDiagnosticsEnabled,
	processUserTaskActionVerbs,
	processUserTaskNamingDiagnosticsEnabled,
	sqlTempScriptMaxAgeDays
} from "../config";

export interface NamingFinding {
	packageName: string;
	label: string;
	message: string;
	filePath: string;
	position: vscode.Position;
}

const NAMING_CACHE_FILE_NAME = "naming-issues-cache.json";

function toCachedFinding(finding: NamingFinding): CachedFinding {
	return {
		packageName: finding.packageName,
		label: finding.label,
		message: finding.message,
		filePath: finding.filePath,
		position: { line: finding.position.line, character: finding.position.character }
	};
}

function fromCachedFinding(finding: CachedFinding): NamingFinding {
	return {
		packageName: finding.packageName,
		label: finding.label,
		message: finding.message,
		filePath: finding.filePath,
		position: new vscode.Position(finding.position.line, finding.position.character)
	};
}

/** Drops any finding whose subject name (extracted from its own message —
 * see `extractNamingSubject`) is in `bpmsoft.naming.ignoredNames` — a
 * confirmed false positive the user marked via the "Пометить как ложное
 * срабатывание" quick action. Applied once, centrally, at the end of every
 * path that produces a finished `NamingFinding[]`, rather than threading an
 * ignore-check into each individual check function. */
function filterIgnoredNames(findings: NamingFinding[]): NamingFinding[] {
	const ignored = namingIgnoredNames();
	if (!ignored.length) {
		return findings;
	}
	const ignoredSet = new Set(ignored);
	return findings.filter((finding) => {
		const subject = extractNamingSubject(finding.message);
		return !subject || !ignoredSet.has(subject);
	});
}

/**
 * Single workspace-wide scan for naming-guidelines.md violations, shared by
 * `NamingIssuesTreeProvider` (flat list) and `PackagesTreeProvider`
 * (decorations on the real file tree) so the (potentially large) Pkg walk
 * only happens once per refresh, not once per consumer.
 */
export class NamingIssuesIndex {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeFindings = this.changeEmitter.event;
	private _findings: NamingFinding[] = [];
	private readonly findingsByPath = new Map<string, NamingFinding[]>();
	private readonly dirsWithIssues = new Set<string>();
	private scanned = false;
	private scanPromise: Promise<void> | undefined;

	constructor(
		private readonly index: SymbolIndex,
		private readonly cacheDir?: string,
		private readonly extensionVersion?: string,
		private readonly reporter?: IndexingProgressReporter
	) {}

	get findings(): readonly NamingFinding[] {
		return this._findings;
	}

	get hasScanned(): boolean {
		return this.scanned;
	}

	async ensureScanned(): Promise<void> {
		if (this.scanned) {
			return;
		}
		if (this.scanPromise) {
			await this.scanPromise;
			return;
		}
		this.scanPromise = this.refresh().finally(() => {
			this.scanPromise = undefined;
		});
		await this.scanPromise;
	}

	/** Full workspace rescan — every descriptor.json/.cs file's *dependency
	 * set* gets re-stat'd (cheap) and only actually re-read/re-parsed when
	 * something in it changed since the last `refresh()` — see
	 * `namingIssuesCache.ts`. Only worth paying even the stat cost for when
	 * something that could change *any* file's verdict just happened
	 * (extension startup, index rebuild, the naming config itself changing)
	 * — for a single file being saved/created/deleted, use `refreshFile`
	 * instead. `forceFresh` (the manual "Rebuild Index" command) skips
	 * reading the cache entirely, same convention as
	 * `ModuleIndexer.rebuild`'s own `forceFresh`, while still writing a
	 * fresh one afterward. Async since the `_Temp` SQL script age check (see
	 * `checkTempScriptAge`) needs `git log`, unlike everything else here
	 * which is plain file I/O. */
	async refresh(forceFresh = false): Promise<void> {
		const startedAt = Date.now();
		this._findings = namingDiagnosticsEnabled()
			? filterIgnoredNames(await this.scanWorkspace(forceFresh))
			: [];
		this.rebuildLookups();
		this.scanned = true;
		this.reporter?.finishNaming(this._findings.length, Date.now() - startedAt);
		this.changeEmitter.fire();
	}

	/** Re-checks just one file instead of the whole workspace — this is what
	 * keeps a single schema save from re-reading every descriptor.json/.cs
	 * file under `Pkg` (a full `refresh()` takes ~1s+ on a large install,
	 * which used to run synchronously on every save and freeze the UI).
	 * Works uniformly for modify/create/delete: any existing findings for
	 * `filePath` are dropped first, then re-added only if the file still
	 * exists and is still a naming-relevant target. */
	async refreshFile(filePath: string): Promise<void> {
		if (!this.scanned) {
			return;
		}
		if (!namingDiagnosticsEnabled()) {
			return;
		}
		const fresh = filterIgnoredNames(await this.findingsForFile(filePath, namingPrefixes()));
		const normPath = path.normalize(filePath);
		this._findings = [
			...this._findings.filter((f) => path.normalize(f.filePath) !== normPath),
			...fresh
		];
		this.rebuildLookups();
		this.changeEmitter.fire();
	}

	getForPath(fileAbsPath: string): NamingFinding[] {
		return [...(this.findingsByPath.get(path.normalize(fileAbsPath)) ?? [])];
	}

	/** Whether any finding's file lives under `dirAbsPath` — for bubbling a
	 * warning indicator up to folder/package tree nodes. */
	hasIssuesUnder(dirAbsPath: string): boolean {
		return this.dirsWithIssues.has(path.normalize(dirAbsPath));
	}

	private rebuildLookups(): void {
		this.findingsByPath.clear();
		this.dirsWithIssues.clear();
		for (const finding of this._findings) {
			const p = path.normalize(finding.filePath);
			const existing = this.findingsByPath.get(p);
			if (existing) {
				existing.push(finding);
			} else {
				this.findingsByPath.set(p, [finding]);
			}
			let dir = path.dirname(p);
			while (dir && dir !== path.dirname(dir)) {
				this.dirsWithIssues.add(dir);
				dir = path.dirname(dir);
			}
		}
	}

	private async scanWorkspace(forceFresh: boolean): Promise<NamingFinding[]> {
		const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];
		const layouts = resolveAppLayouts(folders).filter((l) => l.pkgRoot);
		const prefixes = namingPrefixes();
		const tempMaxAgeDays = sqlTempScriptMaxAgeDays();
		const entitySettings: EntityNamingSettings = {
			prefixes,
			checkSingularName: entityNamingCheckSingular(),
			singularExceptions: entityNamingSingularExceptions(),
			dateSuffixes: entityNamingDateSuffixes(),
			booleanPrefixes: entityNamingBooleanPrefixes()
		};
		const entityDiagnosticsOn = entityNamingDiagnosticsEnabled();
		const processSettings: ProcessNamingSettings = { prefixes };
		const processDiagnosticsOn = processNamingDiagnosticsEnabled();
		const userTaskSettings: ProcessUserTaskNamingSettings = {
			prefixes,
			actionVerbs: processUserTaskActionVerbs()
		};
		const userTaskDiagnosticsOn = processUserTaskNamingDiagnosticsEnabled();
		const dataDiagnosticsOn = dataNamingDiagnosticsEnabled();
		const csharpDiagnosticsOn = csharpNamingDiagnosticsEnabled();
		const csharpSettings: CsharpNamingSettings = {
			prefixes,
			roleSuffixes: csharpNamingRoleSuffixes()
		};
		const clientSchemaSettings: ClientSchemaNamingSettings = {
			prefixes
		};

		// A finding's verdict depends on these settings as much as on the
		// file it's read from — a file's own stamp can't detect a *setting*
		// changing, so every setting gathered above that can affect a
		// finding's presence/text is folded into one fingerprint here; a
		// mismatch against what the cache was last written under (handled
		// inside `loadNamingIssuesCache`) invalidates the whole cache, not
		// just one entry, since there's no cheaper way to know which cached
		// entries a given setting change would actually affect.
		const settingsFingerprint = JSON.stringify({
			entitySettings,
			entityDiagnosticsOn,
			processSettings,
			processDiagnosticsOn,
			userTaskSettings,
			userTaskDiagnosticsOn,
			dataDiagnosticsOn,
			csharpDiagnosticsOn,
			csharpSettings,
			clientSchemaSettings,
			tempMaxAgeDays
		});
		const cacheFilePath = this.cacheDir ? path.join(this.cacheDir, NAMING_CACHE_FILE_NAME) : undefined;
		const previousCache: NamingIssuesCacheData | undefined =
			cacheFilePath && !forceFresh && this.extensionVersion
				? loadNamingIssuesCache(cacheFilePath, this.extensionVersion, settingsFingerprint)
				: undefined;
		const nextCache: NamingIssuesCacheData = emptyNamingIssuesCache();

		// Every file this scan will touch, gathered up front per layout —
		// cheap (directory listings only, via `walkFiles`; no file *content*
		// read yet) and lets the status bar report a real "N/total" instead of
		// an unbounded spinner for the whole scan.
		const layoutFiles = layouts.map((layout) => {
			const pkgRoot = layout.pkgRoot as string;
			return {
				pkgRoot,
				schemaDescriptorFiles: walkFiles(
					pkgRoot,
					(name) => name === "descriptor.json",
					(p) => /\/Schemas\/[^/]+\/descriptor\.json$/i.test(p.replace(/\\/g, "/"))
				),
				csharpFiles: csharpDiagnosticsOn
					? walkFiles(
							pkgRoot,
							(name) => name.endsWith(".cs"),
							(p) => /\/Schemas\//i.test(p.replace(/\\/g, "/"))
						)
					: [],
				sqlScriptFiles: walkFiles(
					pkgRoot,
					(name) => name === "descriptor.json",
					(p) => /\/SqlScripts\/[^/]+\/descriptor\.json$/i.test(p.replace(/\\/g, "/"))
				),
				dataDescriptorFiles: dataDiagnosticsOn
					? walkFiles(
							pkgRoot,
							(name) => name === "descriptor.json",
							(p) => /\/Data\/[^/]+\/descriptor\.json$/i.test(p.replace(/\\/g, "/"))
						)
					: []
			};
		});
		const total = layoutFiles.reduce(
			(sum, l) =>
				sum + l.schemaDescriptorFiles.length + l.csharpFiles.length + l.sqlScriptFiles.length + l.dataDescriptorFiles.length,
			0
		);
		this.reporter?.startNaming(total);
		let processed = 0;
		const bump = () => {
			processed++;
			this.reporter?.reportNamingProgress(processed, total);
		};

		const out: NamingFinding[] = [];
		const entityOccurrences: EntityCodeOccurrence[] = [];
		const sysSettingsOccurrences: SysSettingsOccurrence[] = [];
		const sysSettingsValueOccurrences: SysSettingsValueOccurrence[] = [];
		for (const { pkgRoot, schemaDescriptorFiles, csharpFiles, sqlScriptFiles, dataDescriptorFiles } of layoutFiles) {
			// Every descriptor's read + per-type checks run through the same
			// bounded-concurrency pool as `ModuleIndexer` — see
			// `concurrency.ts`'s own doc for why a plain serial loop over
			// thousands of files here is the other half of the extension's
			// cold-start hang.
			const schemaResults = await pMap(schemaDescriptorFiles, async (filePath) => {
				const text = await readFileSafeAsync(filePath);
				bump();
				if (text === undefined) {
					return undefined;
				}
				const info = parseDescriptorInfo(text);
				if (info?.managerName === "EntitySchemaManager") {
					return entityDiagnosticsOn
						? await this.findingsForEntitySchema(filePath, text, info, entitySettings, previousCache, nextCache)
						: undefined;
				}
				if (info?.managerName === "ProcessSchemaManager") {
					if (!processDiagnosticsOn) {
						return undefined;
					}
					return {
						findings: await this.findingsForProcessSchema(
							filePath,
							text,
							info,
							processSettings,
							previousCache,
							nextCache
						),
						occurrence: undefined
					};
				}
				if (info?.managerName === "ProcessUserTaskSchemaManager") {
					if (!userTaskDiagnosticsOn) {
						return undefined;
					}
					return {
						findings: await this.findingsForProcessUserTaskSchema(
							filePath,
							text,
							info,
							userTaskSettings,
							previousCache,
							nextCache
						),
						occurrence: undefined
					};
				}
				return {
					findings: this.findingsForClientSchemaText(filePath, text, clientSchemaSettings),
					occurrence: undefined
				};
			});
			for (const result of schemaResults) {
				if (!result) {
					continue;
				}
				out.push(...result.findings);
				if (result.occurrence) {
					entityOccurrences.push(result.occurrence);
				}
			}

			const csharpResults = await pMap(csharpFiles, async (filePath) => {
				const findings = await this.findingsForCsharpSchema(filePath, csharpSettings, previousCache, nextCache);
				bump();
				return findings;
			});
			for (const findings of csharpResults) {
				out.push(...findings);
			}

			const sqlResults = await pMap(sqlScriptFiles, async (filePath) => {
				const findings = await this.findingsForSqlScript(
					filePath,
					pkgRoot,
					tempMaxAgeDays,
					previousCache,
					nextCache
				);
				bump();
				return findings;
			});
			for (const findings of sqlResults) {
				out.push(...findings);
			}

			const dataResults = await pMap(dataDescriptorFiles, async (filePath) => {
				const findings = await this.findingsForDataSchema(
					filePath,
					sysSettingsOccurrences,
					sysSettingsValueOccurrences,
					previousCache,
					nextCache
				);
				bump();
				return findings;
			});
			for (const findings of dataResults) {
				out.push(...findings);
			}
		}
		if (entityDiagnosticsOn) {
			for (const collision of findEntityCodeCollisions(entityOccurrences)) {
				const text = readFileSafe(collision.filePath);
				out.push({
					packageName: packageFromPath(collision.filePath),
					label: collision.name,
					message: `Object "${collision.name}": code already used by a different, non-substituting object in another package`,
					filePath: collision.filePath,
					position: text
						? offsetToPosition(text, locateJsonNameOffset(text, collision.name))
						: new vscode.Position(0, 0)
				});
			}
		}
		if (dataDiagnosticsOn) {
			const pairing = findSysSettingsPairingIssues(sysSettingsOccurrences, sysSettingsValueOccurrences);
			for (const missing of pairing.missingValue) {
				const text = readFileSafe(missing.filePath);
				out.push({
					packageName: packageFromPath(missing.filePath),
					label: missing.code,
					message: `Data "${missing.code}": no matching SysSettingsValue found — reading this setting (e.g. SysSettings.GetValue) can 400 without one`,
					filePath: missing.filePath,
					position: text
						? offsetToPosition(text, locateJsonNameOffset(text, missing.code))
						: new vscode.Position(0, 0)
				});
			}
			for (const missing of pairing.missingSettings) {
				const text = readFileSafe(missing.filePath);
				out.push({
					packageName: packageFromPath(missing.filePath),
					label: missing.code,
					message: `Data "${missing.code}": its "SysSettings" reference doesn't match any SysSettings data schema found in the scanned packages — either an orphaned value, or a value for a stock/platform setting not present under Pkg`,
					filePath: missing.filePath,
					position: text
						? offsetToPosition(text, locateJsonNameOffset(text, missing.code))
						: new vscode.Position(0, 0)
				});
			}
		}
		if (cacheFilePath && this.extensionVersion) {
			saveNamingIssuesCache(cacheFilePath, this.extensionVersion, settingsFingerprint, nextCache);
		}
		return out;
	}

	/** Dispatches a single file to the right per-category check based on its
	 * path shape — mirrors the branches `scanWorkspace` walks, but for
	 * exactly one file. Returns `[]` (not an error) for a file that isn't a
	 * naming target at all, or that no longer exists (deleted). Unlike the
	 * full workspace scan, an `EntitySchemaManager` descriptor here skips the
	 * cross-package uniqueness check (needs every occurrence at once — not
	 * worth a full rescan just to keep that one check current on every
	 * keystroke; it settles again on the next full `refresh()`). */
	private async findingsForFile(filePath: string, prefixes: string[]): Promise<NamingFinding[]> {
		const normalized = filePath.replace(/\\/g, "/");
		if (/\/SqlScripts\/[^/]+\/descriptor\.json$/i.test(normalized)) {
			return this.findingsForSqlScript(filePath, findPkgRoot(filePath), sqlTempScriptMaxAgeDays(), undefined, undefined);
		}
		if (/\/Schemas\/[^/]+\/descriptor\.json$/i.test(normalized)) {
			const text = await readFileSafeAsync(filePath);
			if (text === undefined) {
				return [];
			}
			const info = parseDescriptorInfo(text);
			if (info?.managerName === "EntitySchemaManager") {
				if (!entityNamingDiagnosticsEnabled()) {
					return [];
				}
				const entitySettings: EntityNamingSettings = {
					prefixes,
					checkSingularName: entityNamingCheckSingular(),
					singularExceptions: entityNamingSingularExceptions(),
					dateSuffixes: entityNamingDateSuffixes(),
					booleanPrefixes: entityNamingBooleanPrefixes()
				};
				return (await this.findingsForEntitySchema(filePath, text, info, entitySettings, undefined, undefined))
					.findings;
			}
			if (info?.managerName === "ProcessSchemaManager") {
				if (!processNamingDiagnosticsEnabled()) {
					return [];
				}
				return this.findingsForProcessSchema(filePath, text, info, { prefixes }, undefined, undefined);
			}
			if (info?.managerName === "ProcessUserTaskSchemaManager") {
				if (!processUserTaskNamingDiagnosticsEnabled()) {
					return [];
				}
				return this.findingsForProcessUserTaskSchema(
					filePath,
					text,
					info,
					{
						prefixes,
						actionVerbs: processUserTaskActionVerbs()
					},
					undefined,
					undefined
				);
			}
			return this.findingsForClientSchemaText(filePath, text, {
				prefixes
			});
		}
		if (/\.cs$/i.test(normalized) && /\/Schemas\//i.test(normalized)) {
			if (!csharpNamingDiagnosticsEnabled()) {
				return [];
			}
			return this.findingsForCsharpSchema(
				filePath,
				{
					prefixes,
					roleSuffixes: csharpNamingRoleSuffixes()
				},
				undefined,
				undefined
			);
		}
		if (/\/Data\/[^/]+\/descriptor\.json$/i.test(normalized)) {
			if (!dataNamingDiagnosticsEnabled()) {
				return [];
			}
			// SysSettings/SysSettingsValue pairing needs every occurrence in
			// the workspace at once — same trade-off as the EntitySchemaManager
			// cross-package uniqueness check above; it settles again on the
			// next full `refresh()`.
			return this.findingsForDataSchema(filePath, [], [], undefined, undefined);
		}
		return [];
	}

	private findingsForClientSchemaText(
		filePath: string,
		text: string,
		settings: ClientSchemaNamingSettings
	): NamingFinding[] {
		const info = parseDescriptorInfo(text);
		const schemaName = info?.name || path.basename(path.dirname(filePath));
		if (!schemaName) {
			return [];
		}
		// Same-name Parent = override/extension of a schema from
		// another (often stock) package — the name wasn't chosen here.
		const parentName = parseDescriptorParent(text);
		if (parentName === schemaName) {
			return [];
		}
		const schemaType = this.index.hierarchy.resolveSchemaType(schemaName);
		const moduleSource = schemaType === "MODULE" ? readModuleSource(filePath, schemaName) : undefined;
		const context: ClientSchemaNamingContext = { schemaType, parentName, moduleSource };
		return checkClientSchemaNaming(schemaName, settings, context).map((issue) => ({
			packageName: packageFromPath(filePath),
			label: schemaName,
			message: issue.message,
			filePath,
			position: offsetToPosition(text, locateJsonNameOffset(text, schemaName))
		}));
	}

	/**
	 * `EntitySchemaManager` schema (an "Объект" in the naming guideline) —
	 * unlike `findingsForClientSchemaText`, checks three independent things:
	 * the object's own Code (skipped for a substitution — same `Parent.Name
	 * === Name` signal, confirmed real for entity descriptors too, e.g.
	 * `Account` substituted across `GoMain`/`GoLavkaDarkMain`/
	 * `GoSuppliersMain`), its ru-RU/en-US Title coverage (checked for every
	 * occurrence — each package's own `Resources/{Entity}.Entity` can carry
	 * its own captions), and its own custom columns' Code (also checked
	 * unconditionally — a substituting package routinely adds columns of its
	 * own). Returns the `EntityCodeOccurrence` needed for the workspace-wide
	 * uniqueness check separately, since that needs every occurrence at once.
	 */
	private async findingsForEntitySchema(
		filePath: string,
		text: string,
		info: { name?: string; managerName?: string },
		settings: EntityNamingSettings,
		previousCache: NamingIssuesCacheData | undefined,
		nextCache: NamingIssuesCacheData | undefined
	): Promise<{ findings: NamingFinding[]; occurrence: EntityCodeOccurrence | undefined }> {
		const schemaName = info.name || path.basename(path.dirname(filePath));
		if (!schemaName) {
			return { findings: [], occurrence: undefined };
		}
		const schemaDir = path.dirname(filePath);
		const parentName = parseDescriptorParent(text);
		const isSubstitution = parentName === schemaName;
		const occurrence: EntityCodeOccurrence = { name: schemaName, filePath, isSubstitution };

		// Everything below reads only metadata.json and this schema's own
		// resource dirs (`text`/descriptor is already in hand) — `findResourceDirs`
		// is a cheap directory listing (not content), run fresh every time so a
		// newly added/removed resource file is never silently missed by the
		// cache below; only the *content* of these files is what a cache hit
		// skips reading.
		const resourceDirs = isSubstitution ? [] : findResourceDirs(schemaDir, schemaName);
		const metadataPath = path.join(schemaDir, "metadata.json");
		const dependencyPaths = [
			filePath,
			metadataPath,
			...resourceDirs.flatMap((dir) => [path.join(dir, "resource.ru-RU.xml"), path.join(dir, "resource.en-US.xml")])
		];
		const freshStamps = await buildStamps(dependencyPaths);
		const cached = previousCache?.schemaDescriptors[filePath];
		if (cached && stampsMatch(cached.stamps, freshStamps)) {
			if (nextCache) {
				nextCache.schemaDescriptors[filePath] = cached;
			}
			return { findings: cached.findings.map(fromCachedFinding), occurrence: cached.entityOccurrence ?? occurrence };
		}

		const findings: NamingFinding[] = [];
		const namePosition = offsetToPosition(text, locateJsonNameOffset(text, schemaName));

		if (!isSubstitution) {
			for (const issue of checkEntityCodeNaming(schemaName, settings)) {
				findings.push({
					packageName: packageFromPath(filePath),
					label: schemaName,
					message: issue.message,
					filePath,
					position: namePosition
				});
			}
		}

		// Skipped for substitutions for the same reason as the Code check
		// above: a package extending an existing entity (stock or another
		// package's) routinely doesn't restate the Title at all, relying on
		// the base definition's own Caption — which, for a *stock* base, only
		// lives in conf/content/Autogenerated, outside what this Pkg-only
		// scan can see. Confirmed as a real false-positive source while
		// building this: every Pkg-level substitution of a stock entity
		// (SysModule, Opportunity, Contact, …) showed up as "missing a
		// title" before this guard, none of which is a real issue.
		if (!isSubstitution) {
			let hasRu = false;
			let hasEn = false;
			for (const dir of resourceDirs) {
				hasRu = hasRu || hasNonEmptyCaption(await readFileSafeAsync(path.join(dir, "resource.ru-RU.xml")));
				hasEn = hasEn || hasNonEmptyCaption(await readFileSafeAsync(path.join(dir, "resource.en-US.xml")));
			}
			for (const issue of checkCaptionCoverage("Object", schemaName, hasRu, hasEn)) {
				findings.push({
					packageName: packageFromPath(filePath),
					label: schemaName,
					message: issue.message,
					filePath,
					position: namePosition
				});
			}
		}

		const metadataText = await readFileSafeAsync(metadataPath);
		if (metadataText !== undefined) {
			const businessName = stripPrefix(schemaName, settings.prefixes);
			for (const column of parsePkgEntityColumns(metadataText, metadataPath)) {
				const isLookup = column.detail === "entity lookup";
				const columnIssues = checkEntityColumnNaming(
					businessName,
					{ name: column.name, dataValueType: column.dataValueType, isLookup },
					settings
				);
				for (const issue of columnIssues) {
					findings.push({
						packageName: packageFromPath(filePath),
						label: column.name,
						message: issue.message,
						filePath: metadataPath,
						position: column.position
							? new vscode.Position(column.position.line, column.position.character)
							: new vscode.Position(0, 0)
					});
				}
			}
		}

		if (nextCache) {
			nextCache.schemaDescriptors[filePath] = {
				stamps: freshStamps,
				findings: findings.map(toCachedFinding),
				entityOccurrence: occurrence
			};
		}
		return { findings, occurrence };
	}

	/**
	 * `ProcessSchemaManager` schema (a "Бизнес-процесс" in the naming
	 * guideline, §7) — checks the process's own Code/Title the same way as an
	 * Object (`findingsForEntitySchema`), plus every BPMN-style diagram
	 * element's title, parsed straight from `metadata.json` (confirmed real
	 * plain JSON for this schema type, unlike client schemas' diff-DSL — see
	 * `processElementsMetadata.ts`). Element titles live in the same
	 * `Resources/{Process}.Process/resource.{culture}.xml` as the process's
	 * own Title, under `BaseElements.{A2}.Caption`.
	 */
	private async findingsForProcessSchema(
		filePath: string,
		text: string,
		info: { name?: string; managerName?: string },
		settings: ProcessNamingSettings,
		previousCache: NamingIssuesCacheData | undefined,
		nextCache: NamingIssuesCacheData | undefined
	): Promise<NamingFinding[]> {
		const schemaName = info.name || path.basename(path.dirname(filePath));
		if (!schemaName) {
			return [];
		}
		const schemaDir = path.dirname(filePath);
		const parentName = parseDescriptorParent(text);
		const isSubstitution = parentName === schemaName;

		const resourceDirs = findResourceDirs(schemaDir, schemaName);
		const metadataPath = path.join(schemaDir, "metadata.json");
		const dependencyPaths = [
			filePath,
			metadataPath,
			...resourceDirs.flatMap((dir) => [path.join(dir, "resource.ru-RU.xml"), path.join(dir, "resource.en-US.xml")])
		];
		const freshStamps = await buildStamps(dependencyPaths);
		const cached = previousCache?.schemaDescriptors[filePath];
		if (cached && stampsMatch(cached.stamps, freshStamps)) {
			if (nextCache) {
				nextCache.schemaDescriptors[filePath] = cached;
			}
			return cached.findings.map(fromCachedFinding);
		}

		const findings: NamingFinding[] = [];
		const namePosition = offsetToPosition(text, locateJsonNameOffset(text, schemaName));

		if (!isSubstitution) {
			for (const issue of checkProcessCodeNaming(schemaName, settings)) {
				findings.push({
					packageName: packageFromPath(filePath),
					label: schemaName,
					message: issue.message,
					filePath,
					position: namePosition
				});
			}
		}

		let hasRu = false;
		let hasEn = false;
		let elementResourceText: string | undefined;
		for (const dir of resourceDirs) {
			const ruText = await readFileSafeAsync(path.join(dir, "resource.ru-RU.xml"));
			hasRu = hasRu || hasNonEmptyCaption(ruText);
			hasEn = hasEn || hasNonEmptyCaption(await readFileSafeAsync(path.join(dir, "resource.en-US.xml")));
			// Element titles are Russian-specific checks (verb prefix, past
			// tense, closed question) — the ru-RU resource file is the right
			// one to read them from.
			elementResourceText = elementResourceText || ruText;
		}
		if (!isSubstitution) {
			for (const issue of checkCaptionCoverage("Process", schemaName, hasRu, hasEn)) {
				findings.push({
					packageName: packageFromPath(filePath),
					label: schemaName,
					message: issue.message,
					filePath,
					position: namePosition
				});
			}
		}

		const metadataText = await readFileSafeAsync(metadataPath);
		if (metadataText !== undefined) {
			for (const element of parseProcessSchemaElements(metadataText)) {
				const caption = elementResourceText
					? findProcessElementCaption(elementResourceText, element.name)
					: undefined;
				const elementIssues = checkProcessElementNaming({
					name: element.name,
					category: element.category,
					caption
				});
				for (const issue of elementIssues) {
					findings.push({
						packageName: packageFromPath(filePath),
						label: caption || element.name,
						message: issue.message,
						filePath: metadataPath,
						position: offsetToPosition(metadataText, locateProcessElementOffset(metadataText, element.name))
					});
				}
			}
		}

		if (nextCache) {
			nextCache.schemaDescriptors[filePath] = { stamps: freshStamps, findings: findings.map(toCachedFinding) };
		}
		return findings;
	}

	/**
	 * `ProcessUserTaskSchemaManager` schema (a "Действие процесса (UserTask)"
	 * in the naming guideline, §8) — its own Code (mandatory `UserTask`
	 * suffix + verb-first business name, English) and Title, same mechanism
	 * as a Process, plus its own parameters (also plain `ProcessSchemaParameter`
	 * items in `metadata.json`, same shape a Process's diagram elements use —
	 * see `processElementsMetadata.ts`). Parameter titles live in
	 * `Resources/{UserTask}.ProcessUserTask/resource.{culture}.xml` under
	 * `Parameters.{A2}.Caption`. Doesn't look at the schema's own hand-written
	 * `.cs` (business logic) or the `Autogenerated/Src` counterpart — both
	 * just mirror the same parameter Codes already checked here, they don't
	 * introduce a separate naming surface.
	 */
	private async findingsForProcessUserTaskSchema(
		filePath: string,
		text: string,
		info: { name?: string; managerName?: string },
		settings: ProcessUserTaskNamingSettings,
		previousCache: NamingIssuesCacheData | undefined,
		nextCache: NamingIssuesCacheData | undefined
	): Promise<NamingFinding[]> {
		const schemaName = info.name || path.basename(path.dirname(filePath));
		if (!schemaName) {
			return [];
		}
		const schemaDir = path.dirname(filePath);
		const parentName = parseDescriptorParent(text);
		const isSubstitution = parentName === schemaName;

		const resourceDirs = findResourceDirs(schemaDir, schemaName);
		const metadataPath = path.join(schemaDir, "metadata.json");
		const dependencyPaths = [
			filePath,
			metadataPath,
			...resourceDirs.flatMap((dir) => [path.join(dir, "resource.ru-RU.xml"), path.join(dir, "resource.en-US.xml")])
		];
		const freshStamps = await buildStamps(dependencyPaths);
		const cached = previousCache?.schemaDescriptors[filePath];
		if (cached && stampsMatch(cached.stamps, freshStamps)) {
			if (nextCache) {
				nextCache.schemaDescriptors[filePath] = cached;
			}
			return cached.findings.map(fromCachedFinding);
		}

		const findings: NamingFinding[] = [];
		const namePosition = offsetToPosition(text, locateJsonNameOffset(text, schemaName));

		if (!isSubstitution) {
			for (const issue of checkProcessUserTaskCodeNaming(schemaName, settings)) {
				findings.push({
					packageName: packageFromPath(filePath),
					label: schemaName,
					message: issue.message,
					filePath,
					position: namePosition
				});
			}
		}

		let hasRu = false;
		let hasEn = false;
		let parameterResourceText: string | undefined;
		for (const dir of resourceDirs) {
			const ruText = await readFileSafeAsync(path.join(dir, "resource.ru-RU.xml"));
			hasRu = hasRu || hasNonEmptyCaption(ruText);
			hasEn = hasEn || hasNonEmptyCaption(await readFileSafeAsync(path.join(dir, "resource.en-US.xml")));
			parameterResourceText = parameterResourceText || ruText;
		}
		if (!isSubstitution) {
			for (const issue of checkCaptionCoverage("UserTask", schemaName, hasRu, hasEn)) {
				findings.push({
					packageName: packageFromPath(filePath),
					label: schemaName,
					message: issue.message,
					filePath,
					position: namePosition
				});
			}
		}

		const metadataText = await readFileSafeAsync(metadataPath);
		if (metadataText !== undefined) {
			const parameterNames = parseProcessMetadataItemsByClassName(metadataText, "ProcessSchemaParameter");
			for (const paramName of parameterNames) {
				for (const issue of checkProcessUserTaskParameterNaming(paramName)) {
					const caption = parameterResourceText
						? findResourceItemCaption(parameterResourceText, "Parameters", paramName)
						: undefined;
					findings.push({
						packageName: packageFromPath(filePath),
						label: caption || paramName,
						message: issue.message,
						filePath: metadataPath,
						position: offsetToPosition(metadataText, locateProcessElementOffset(metadataText, paramName))
					});
				}
			}
		}

		if (nextCache) {
			nextCache.schemaDescriptors[filePath] = { stamps: freshStamps, findings: findings.map(toCachedFinding) };
		}
		return findings;
	}

	/**
	 * Any `.cs` file under `Schemas/` — deliberately not narrowed to
	 * `SourceCodeSchemaManager` schemas alone, matching naming-guidelines.md
	 * §4's own scope ("Схемы типа «Исходный код» **и аналогичные серверные
	 * артефакты**"): a Process/UserTask/Entity schema's own `.cs` file is
	 * just as much "C# code" and gets the same Code-level checks (prefix,
	 * class/schema-name correspondence, no `SourceCode`/temp-designation/
	 * chained-suffix junk). The RU/EN Title-coverage check is the one
	 * exception — it's gated to actual `SourceCodeSchemaManager` schemas,
	 * since a Process/UserTask/Entity's own Title is already checked once,
	 * against its *own* Resources suffix (`.Process`/`.ProcessUserTask`/
	 * `.Entity`), by that schema type's own findings method; re-running it
	 * here against a `.SourceCode` Resources folder that doesn't exist for
	 * those schemas would just misreport "missing" every time.
	 *
	 * Also skips everything for a *substitution* — `Parent.Name === Name`,
	 * confirmed real here too (e.g. a stock `Lead`/`Account` entity's own
	 * `Lead.cs`/`Account.cs` custom-logic file, `ManagerName:
	 * "EntitySchemaManager"`, no team prefix because the name itself is
	 * inherited from the platform, not chosen in this package) — same
	 * reasoning as every other schema type's own substitution guard.
	 */
	private async findingsForCsharpSchema(
		filePath: string,
		settings: CsharpNamingSettings,
		previousCache: NamingIssuesCacheData | undefined,
		nextCache: NamingIssuesCacheData | undefined
	): Promise<NamingFinding[]> {
		// Descriptor content is read unconditionally (small, cheap) to
		// determine manager type/substitution/resource dirs *before* the
		// cache check — the payoff is skipping the .cs file's own (often
		// much larger) content read entirely on a hit.
		const schema = findSchemaDir(filePath);
		const descriptorPath = schema ? path.join(schema.schemaDir, "descriptor.json") : undefined;
		const descriptorText = descriptorPath ? await readFileSafeAsync(descriptorPath) : undefined;
		const info = descriptorText ? parseDescriptorInfo(descriptorText) : undefined;
		const schemaName = info?.name;
		if (schemaName && descriptorText && parseDescriptorParent(descriptorText) === schemaName) {
			return [];
		}
		const isSourceCode = info?.managerName === "SourceCodeSchemaManager";
		const name = schemaName || schema?.schemaName;
		const resourceDirs = isSourceCode && schema && name ? findResourceDirs(schema.schemaDir, name) : [];
		const dependencyPaths = [
			filePath,
			...(descriptorPath ? [descriptorPath] : []),
			...resourceDirs.flatMap((dir) => [path.join(dir, "resource.ru-RU.xml"), path.join(dir, "resource.en-US.xml")])
		];
		const freshStamps = await buildStamps(dependencyPaths);
		const cached = previousCache?.csharpFiles[filePath];
		if (cached && stampsMatch(cached.stamps, freshStamps)) {
			if (nextCache) {
				nextCache.csharpFiles[filePath] = cached;
			}
			return cached.findings.map(fromCachedFinding);
		}

		const text = await readFileSafeAsync(filePath);
		if (text === undefined) {
			return [];
		}
		const findings = checkCsharpSchemaNaming(text, settings, schemaName).map((issue) => ({
			packageName: packageFromPath(filePath),
			label: schemaName || path.basename(filePath, ".cs"),
			message: issue.message,
			filePath,
			position: offsetToPosition(text, issue.start)
		}));

		if (isSourceCode && schema && descriptorPath && descriptorText && name) {
			const namePosition = offsetToPosition(descriptorText, locateJsonNameOffset(descriptorText, name));
			let hasRu = false;
			let hasEn = false;
			for (const dir of resourceDirs) {
				hasRu = hasRu || hasNonEmptyCaption(await readFileSafeAsync(path.join(dir, "resource.ru-RU.xml")));
				hasEn = hasEn || hasNonEmptyCaption(await readFileSafeAsync(path.join(dir, "resource.en-US.xml")));
			}
			if (!hasRu) {
				findings.push({
					packageName: packageFromPath(descriptorPath),
					label: name,
					message: `Класс «${name}»: отсутствует заголовок на русском (ru-RU Caption)`,
					filePath: descriptorPath,
					position: namePosition
				});
			}
			if (!hasEn) {
				findings.push({
					packageName: packageFromPath(descriptorPath),
					label: name,
					message: `Класс «${name}»: отсутствует заголовок на английском (en-US Caption)`,
					filePath: descriptorPath,
					position: namePosition
				});
			}
		}

		if (nextCache) {
			nextCache.csharpFiles[filePath] = { stamps: freshStamps, findings: findings.map(toCachedFinding) };
		}
		return findings;
	}

	private async findingsForSqlScript(
		filePath: string,
		gitRoot: string | undefined,
		tempMaxAgeDays: number,
		previousCache: NamingIssuesCacheData | undefined,
		nextCache: NamingIssuesCacheData | undefined
	): Promise<NamingFinding[]> {
		const text = await readFileSafeAsync(filePath);
		if (text === undefined) {
			return [];
		}
		const scriptName = parseSqlScriptDescriptorName(text);
		if (!scriptName) {
			return [];
		}

		// Only the naming-pattern part is cacheable — the `_Temp` age check
		// below is time-dependent (crosses `tempMaxAgeDays` with no file
		// changing at all) and always runs fresh, cache hit or not.
		const freshStamps = await buildStamps([filePath]);
		const cached = previousCache?.sqlScripts[filePath];
		const findings =
			cached && stampsMatch(cached.stamps, freshStamps)
				? cached.findings.map(fromCachedFinding)
				: checkSqlScriptNaming(scriptName).map((issue) => ({
						packageName: packageFromPath(filePath),
						label: scriptName,
						message: issue.message,
						filePath,
						position: offsetToPosition(text, locateJsonNameOffset(text, scriptName))
					}));
		if (nextCache) {
			nextCache.sqlScripts[filePath] = { stamps: freshStamps, findings: findings.map(toCachedFinding) };
		}

		if (scriptName.endsWith("_Temp") && gitRoot && tempMaxAgeDays > 0) {
			const ageDays = await gitFileFirstAddedAgeDays(gitRoot, filePath);
			if (ageDays !== undefined && ageDays > tempMaxAgeDays) {
				findings.push({
					packageName: packageFromPath(filePath),
					label: scriptName,
					message: `SQL-скрипт «${scriptName}»: временный скрипт (_Temp) в репозитории уже ${Math.floor(ageDays)} дн. — возможно, забыли удалить после релиза`,
					filePath,
					position: offsetToPosition(text, locateJsonNameOffset(text, scriptName))
				});
			}
		}
		return findings;
	}

	/**
	 * `Data/{Name}/` package item (naming-guidelines.md §5 "Данные") — Code
	 * naming against its own real target table (`descriptor.json`'s
	 * `Descriptor.Schema.Name`, see `dataSchemaMetadata.ts`). For a
	 * SysSettings/SysSettingsValue row specifically, also records its
	 * pairing key (own row Id / "SysSettings" reference) into the
	 * caller-owned accumulator arrays — the actual pairing gap is only
	 * detectable with every occurrence in hand, so `scanWorkspace` computes
	 * it once after the whole workspace has been walked (same pattern as
	 * `findEntityCodeCollisions`).
	 */
	private async findingsForDataSchema(
		filePath: string,
		sysSettingsOccurrences: SysSettingsOccurrence[],
		sysSettingsValueOccurrences: SysSettingsValueOccurrence[],
		previousCache: NamingIssuesCacheData | undefined,
		nextCache: NamingIssuesCacheData | undefined
	): Promise<NamingFinding[]> {
		// Descriptor content is read unconditionally (needed either way, to
		// know `tableName`/`code` — cheap, small JSON); a cache hit then
		// skips reading the sibling data.json (which, for a SysSettings row,
		// carries the actual configured value and can be sizable).
		const text = await readFileSafeAsync(filePath);
		if (text === undefined) {
			return [];
		}
		const info = parseDataSchemaDescriptor(text);
		if (!info) {
			return [];
		}
		const isSysSettingsRow = info.tableName === "SysSettings" || info.tableName === "SysSettingsValue";
		const dataJsonPath = path.join(path.dirname(filePath), "data.json");
		const dependencyPaths = [filePath, ...(isSysSettingsRow ? [dataJsonPath] : [])];
		const freshStamps = await buildStamps(dependencyPaths);
		const cached = previousCache?.dataDescriptors[filePath];
		if (cached && stampsMatch(cached.stamps, freshStamps)) {
			if (nextCache) {
				nextCache.dataDescriptors[filePath] = cached;
			}
			if (cached.sysSettingsOccurrence) {
				sysSettingsOccurrences.push(cached.sysSettingsOccurrence);
			}
			if (cached.sysSettingsValueOccurrence) {
				sysSettingsValueOccurrences.push(cached.sysSettingsValueOccurrence);
			}
			return cached.findings.map(fromCachedFinding);
		}

		const findings = checkDataSchemaCodeNaming(info.code, info.tableName).map((issue) => ({
			packageName: packageFromPath(filePath),
			label: info.code,
			message: issue.message,
			filePath,
			position: offsetToPosition(text, locateJsonNameOffset(text, info.code))
		}));

		let sysSettingsOccurrence: SysSettingsOccurrence | undefined;
		let sysSettingsValueOccurrence: SysSettingsValueOccurrence | undefined;
		if (isSysSettingsRow) {
			const dataText = await readFileSafeAsync(dataJsonPath);
			if (dataText !== undefined) {
				if (info.tableName === "SysSettings") {
					sysSettingsOccurrence = { code: info.code, filePath, rowId: readDataRowColumnValue(text, dataText, "Id") };
					sysSettingsOccurrences.push(sysSettingsOccurrence);
				} else {
					sysSettingsValueOccurrence = {
						code: info.code,
						filePath,
						referencedSysSettingsId: readDataRowColumnValue(text, dataText, "SysSettings")
					};
					sysSettingsValueOccurrences.push(sysSettingsValueOccurrence);
				}
			}
		}

		if (nextCache) {
			nextCache.dataDescriptors[filePath] = {
				stamps: freshStamps,
				findings: findings.map(toCachedFinding),
				sysSettingsOccurrence,
				sysSettingsValueOccurrence
			};
		}
		return findings;
	}
}

/** Days since the commit that (most recently) added `filePath` — the
 * closest proxy available for "how long has this `_Temp` script been
 * sitting here" (naming-guidelines.md §6: `_Temp` scripts are meant to be
 * deleted after their one-time run on target environments). Not
 * authoritative — this extension has no visibility into what's actually
 * been deployed where, so it's surfaced as a nudge ("possibly forgotten"),
 * not a hard violation. `undefined` on any git failure (not a repo, file
 * never committed, git not installed, …) — the caller treats that as
 * "nothing to say", not an error. */
function gitFileFirstAddedAgeDays(gitRoot: string, filePath: string): Promise<number | undefined> {
	const relPath = path.relative(gitRoot, filePath).replace(/\\/g, "/");
	return new Promise((resolve) => {
		execFile(
			"git",
			["log", "--follow", "--diff-filter=A", "--format=%ct", "-1", "--", relPath],
			{ cwd: gitRoot },
			(error, stdout) => {
				const epochSeconds = Number(stdout?.trim());
				if (error || !Number.isFinite(epochSeconds) || epochSeconds <= 0) {
					resolve(undefined);
					return;
				}
				resolve((Date.now() - epochSeconds * 1000) / (1000 * 60 * 60 * 24));
			}
		);
	});
}

/** `<Item Name="Caption" Value="..." />` — the entity's own title, at the
 * top level of `Resources/{Entity}.Entity/resource.{culture}.xml` (confirmed
 * real shape: `GoTicket.Entity`'s own `resource.ru-RU.xml` has `Value="Тикет"`
 * alongside the per-column `Columns.X.Caption` items this codebase already
 * reads elsewhere). */
function hasNonEmptyCaption(xmlText: string | undefined): boolean {
	if (!xmlText) {
		return false;
	}
	const match = /<Item\s+Name="Caption"\s+Value="([^"]*)"\s*\/>/.exec(xmlText);
	return !!match && match[1].trim().length > 0;
}

function packageFromPath(filePath: string): string {
	return packageNameFromPkgPath(filePath) ?? "?";
}

function locateJsonNameOffset(text: string, name: string): number {
	const re = new RegExp(`"Name"\\s*:\\s*"${escapeRegExp(name)}"`);
	const match = re.exec(text);
	if (!match) {
		return 0;
	}
	return match.index + match[0].lastIndexOf(`"${name}"`) + 1;
}

function offsetToPosition(text: string, offset: number): vscode.Position {
	const { line, character } = offsetToLineCharacter(text, offset);
	return new vscode.Position(line, character);
}
