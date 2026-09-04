import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { resolveAppLayouts, walkFiles } from "./workspaceLayout";
import {
	parseDescriptorInfo,
	parseDescriptorParent,
	parseSqlScriptDescriptorName
} from "./schemaStructureParse";
import { findResourceDirs, findSchemaDir } from "./schemaResourceLookup";
import { checkClientSchemaNaming } from "../parse/schemaNamingAnalyzer";
import { CsharpNamingSettings, checkCsharpSchemaNaming } from "../parse/csharpSchemaAnalyzer";
import { checkSqlScriptNaming } from "../parse/sqlNamingAnalyzer";
import {
	EntityCodeOccurrence,
	EntityNamingSettings,
	checkEntityCaptionCoverage,
	checkEntityCodeNaming,
	checkEntityColumnNaming,
	findEntityCodeCollisions,
	stripPrefix
} from "../parse/entityNamingAnalyzer";
import { parsePkgEntityColumns } from "../parse/entityMetadata";
import {
	ProcessNamingSettings,
	checkProcessCaptionCoverage,
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
	checkProcessUserTaskCaptionCoverage,
	checkProcessUserTaskCodeNaming,
	checkProcessUserTaskParameterDirectionSuffix,
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
	csharpNamingCheckRoleSuffix,
	csharpNamingCheckSingleClassPerSchema,
	csharpNamingDiagnosticsEnabled,
	csharpNamingRoleSuffixes,
	dataNamingDiagnosticsEnabled,
	entityNamingCheckSingular,
	entityNamingDateSuffixes,
	entityNamingDiagnosticsEnabled,
	entityNamingBooleanPrefixes,
	entityNamingSingularExceptions,
	namingDiagnosticsEnabled,
	namingPrefixes,
	processNamingDiagnosticsEnabled,
	processUserTaskActionVerbs,
	processUserTaskCheckParameterDirectionSuffix,
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

	constructor(private readonly index: SymbolIndex) {}

	get findings(): readonly NamingFinding[] {
		return this._findings;
	}

	/** Full workspace rescan — every descriptor.json/.cs file gets re-read and
	 * re-parsed. Only worth paying for when something that could change *any*
	 * file's verdict just happened (extension startup, index rebuild, the
	 * naming config itself changing) — for a single file being saved/created/
	 * deleted, use `refreshFile` instead. Async since the `_Temp` SQL script
	 * age check (see `checkTempScriptAge`) needs `git log`, unlike everything
	 * else here which is plain file I/O. */
	async refresh(): Promise<void> {
		this._findings = namingDiagnosticsEnabled() ? await this.scanWorkspace() : [];
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
		if (!namingDiagnosticsEnabled()) {
			return;
		}
		const fresh = await this.findingsForFile(filePath, namingPrefixes());
		const normPath = path.normalize(filePath);
		this._findings = [
			...this._findings.filter((f) => path.normalize(f.filePath) !== normPath),
			...fresh
		];
		this.changeEmitter.fire();
	}

	getForPath(fileAbsPath: string): NamingFinding[] {
		const normalized = path.normalize(fileAbsPath);
		return this._findings.filter((f) => path.normalize(f.filePath) === normalized);
	}

	/** Whether any finding's file lives under `dirAbsPath` — for bubbling a
	 * warning indicator up to folder/package tree nodes. */
	hasIssuesUnder(dirAbsPath: string): boolean {
		const normalized = path.normalize(dirAbsPath) + path.sep;
		return this._findings.some((f) => path.normalize(f.filePath).startsWith(normalized));
	}

	private async scanWorkspace(): Promise<NamingFinding[]> {
		const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];
		const layouts = resolveAppLayouts(folders);
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
			actionVerbs: processUserTaskActionVerbs(),
			checkParameterDirectionSuffix: processUserTaskCheckParameterDirectionSuffix()
		};
		const userTaskDiagnosticsOn = processUserTaskNamingDiagnosticsEnabled();
		const dataDiagnosticsOn = dataNamingDiagnosticsEnabled();
		const csharpDiagnosticsOn = csharpNamingDiagnosticsEnabled();
		const csharpSettings: CsharpNamingSettings = {
			prefixes,
			checkRoleSuffix: csharpNamingCheckRoleSuffix(),
			roleSuffixes: csharpNamingRoleSuffixes(),
			checkSingleClassPerSchema: csharpNamingCheckSingleClassPerSchema()
		};
		const out: NamingFinding[] = [];
		const entityOccurrences: EntityCodeOccurrence[] = [];
		const sysSettingsOccurrences: SysSettingsOccurrence[] = [];
		const sysSettingsValueOccurrences: SysSettingsValueOccurrence[] = [];
		for (const layout of layouts) {
			if (!layout.pkgRoot) {
				continue;
			}
			const schemaDescriptorFiles = walkFiles(
				layout.pkgRoot,
				(name) => name === "descriptor.json",
				(p) => /\/Schemas\/[^/]+\/descriptor\.json$/i.test(p.replace(/\\/g, "/"))
			);
			for (const filePath of schemaDescriptorFiles) {
				const text = readFileSafe(filePath);
				if (text === undefined) {
					continue;
				}
				const info = parseDescriptorInfo(text);
				if (info?.managerName === "EntitySchemaManager") {
					if (!entityDiagnosticsOn) {
						continue;
					}
					const result = this.findingsForEntitySchema(filePath, text, info, entitySettings);
					out.push(...result.findings);
					if (result.occurrence) {
						entityOccurrences.push(result.occurrence);
					}
					continue;
				}
				if (info?.managerName === "ProcessSchemaManager") {
					if (!processDiagnosticsOn) {
						continue;
					}
					out.push(...this.findingsForProcessSchema(filePath, text, info, processSettings));
					continue;
				}
				if (info?.managerName === "ProcessUserTaskSchemaManager") {
					if (!userTaskDiagnosticsOn) {
						continue;
					}
					out.push(...this.findingsForProcessUserTaskSchema(filePath, text, info, userTaskSettings));
					continue;
				}
				out.push(...this.findingsForClientSchemaText(filePath, text, prefixes));
			}
			if (csharpDiagnosticsOn) {
				const csharpFiles = walkFiles(
					layout.pkgRoot,
					(name) => name.endsWith(".cs"),
					(p) => /\/Schemas\//i.test(p.replace(/\\/g, "/"))
				);
				for (const filePath of csharpFiles) {
					out.push(...this.findingsForCsharpSchema(filePath, csharpSettings));
				}
			}
			const sqlScriptFiles = walkFiles(
				layout.pkgRoot,
				(name) => name === "descriptor.json",
				(p) => /\/SqlScripts\/[^/]+\/descriptor\.json$/i.test(p.replace(/\\/g, "/"))
			);
			const sqlFindings = await Promise.all(
				sqlScriptFiles.map((filePath) =>
					this.findingsForSqlScript(filePath, layout.pkgRoot, tempMaxAgeDays)
				)
			);
			for (const findings of sqlFindings) {
				out.push(...findings);
			}
			if (dataDiagnosticsOn) {
				const dataDescriptorFiles = walkFiles(
					layout.pkgRoot,
					(name) => name === "descriptor.json",
					(p) => /\/Data\/[^/]+\/descriptor\.json$/i.test(p.replace(/\\/g, "/"))
				);
				for (const filePath of dataDescriptorFiles) {
					out.push(...this.findingsForDataSchema(filePath, sysSettingsOccurrences, sysSettingsValueOccurrences));
				}
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
			return this.findingsForSqlScript(filePath, pkgRootFromFilePath(filePath), sqlTempScriptMaxAgeDays());
		}
		if (/\/Schemas\/[^/]+\/descriptor\.json$/i.test(normalized)) {
			const text = readFileSafe(filePath);
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
				return this.findingsForEntitySchema(filePath, text, info, entitySettings).findings;
			}
			if (info?.managerName === "ProcessSchemaManager") {
				if (!processNamingDiagnosticsEnabled()) {
					return [];
				}
				return this.findingsForProcessSchema(filePath, text, info, { prefixes });
			}
			if (info?.managerName === "ProcessUserTaskSchemaManager") {
				if (!processUserTaskNamingDiagnosticsEnabled()) {
					return [];
				}
				return this.findingsForProcessUserTaskSchema(filePath, text, info, {
					prefixes,
					actionVerbs: processUserTaskActionVerbs(),
					checkParameterDirectionSuffix: processUserTaskCheckParameterDirectionSuffix()
				});
			}
			return this.findingsForClientSchemaText(filePath, text, prefixes);
		}
		if (/\.cs$/i.test(normalized) && /\/Schemas\//i.test(normalized)) {
			if (!csharpNamingDiagnosticsEnabled()) {
				return [];
			}
			return this.findingsForCsharpSchema(filePath, {
				prefixes,
				checkRoleSuffix: csharpNamingCheckRoleSuffix(),
				roleSuffixes: csharpNamingRoleSuffixes(),
				checkSingleClassPerSchema: csharpNamingCheckSingleClassPerSchema()
			});
		}
		if (/\/Data\/[^/]+\/descriptor\.json$/i.test(normalized)) {
			if (!dataNamingDiagnosticsEnabled()) {
				return [];
			}
			// SysSettings/SysSettingsValue pairing needs every occurrence in
			// the workspace at once — same trade-off as the EntitySchemaManager
			// cross-package uniqueness check above; it settles again on the
			// next full `refresh()`.
			return this.findingsForDataSchema(filePath, [], []);
		}
		return [];
	}

	private findingsForClientSchemaText(filePath: string, text: string, prefixes: string[]): NamingFinding[] {
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
		return checkClientSchemaNaming(schemaName, schemaType, prefixes, parentName).map((issue) => ({
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
	private findingsForEntitySchema(
		filePath: string,
		text: string,
		info: { name?: string; managerName?: string },
		settings: EntityNamingSettings
	): { findings: NamingFinding[]; occurrence: EntityCodeOccurrence | undefined } {
		const schemaName = info.name || path.basename(path.dirname(filePath));
		if (!schemaName) {
			return { findings: [], occurrence: undefined };
		}
		const schemaDir = path.dirname(filePath);
		const parentName = parseDescriptorParent(text);
		const isSubstitution = parentName === schemaName;
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
			const resourceDirs = findResourceDirs(schemaDir, schemaName);
			let hasRu = false;
			let hasEn = false;
			for (const dir of resourceDirs) {
				hasRu = hasRu || hasNonEmptyCaption(readFileSafe(path.join(dir, "resource.ru-RU.xml")));
				hasEn = hasEn || hasNonEmptyCaption(readFileSafe(path.join(dir, "resource.en-US.xml")));
			}
			for (const issue of checkEntityCaptionCoverage(schemaName, hasRu, hasEn)) {
				findings.push({
					packageName: packageFromPath(filePath),
					label: schemaName,
					message: issue.message,
					filePath,
					position: namePosition
				});
			}
		}

		const metadataPath = path.join(schemaDir, "metadata.json");
		const metadataText = readFileSafe(metadataPath);
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

		return { findings, occurrence: { name: schemaName, filePath, isSubstitution } };
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
	private findingsForProcessSchema(
		filePath: string,
		text: string,
		info: { name?: string; managerName?: string },
		settings: ProcessNamingSettings
	): NamingFinding[] {
		const schemaName = info.name || path.basename(path.dirname(filePath));
		if (!schemaName) {
			return [];
		}
		const schemaDir = path.dirname(filePath);
		const parentName = parseDescriptorParent(text);
		const isSubstitution = parentName === schemaName;
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

		const resourceDirs = findResourceDirs(schemaDir, schemaName);
		let hasRu = false;
		let hasEn = false;
		let elementResourceText: string | undefined;
		for (const dir of resourceDirs) {
			const ruText = readFileSafe(path.join(dir, "resource.ru-RU.xml"));
			hasRu = hasRu || hasNonEmptyCaption(ruText);
			hasEn = hasEn || hasNonEmptyCaption(readFileSafe(path.join(dir, "resource.en-US.xml")));
			// Element titles are Russian-specific checks (verb prefix, past
			// tense, closed question) — the ru-RU resource file is the right
			// one to read them from.
			elementResourceText = elementResourceText || ruText;
		}
		if (!isSubstitution) {
			for (const issue of checkProcessCaptionCoverage(schemaName, hasRu, hasEn)) {
				findings.push({
					packageName: packageFromPath(filePath),
					label: schemaName,
					message: issue.message,
					filePath,
					position: namePosition
				});
			}
		}

		const metadataPath = path.join(schemaDir, "metadata.json");
		const metadataText = readFileSafe(metadataPath);
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
	private findingsForProcessUserTaskSchema(
		filePath: string,
		text: string,
		info: { name?: string; managerName?: string },
		settings: ProcessUserTaskNamingSettings
	): NamingFinding[] {
		const schemaName = info.name || path.basename(path.dirname(filePath));
		if (!schemaName) {
			return [];
		}
		const schemaDir = path.dirname(filePath);
		const parentName = parseDescriptorParent(text);
		const isSubstitution = parentName === schemaName;
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

		const resourceDirs = findResourceDirs(schemaDir, schemaName);
		let hasRu = false;
		let hasEn = false;
		let parameterResourceText: string | undefined;
		for (const dir of resourceDirs) {
			const ruText = readFileSafe(path.join(dir, "resource.ru-RU.xml"));
			hasRu = hasRu || hasNonEmptyCaption(ruText);
			hasEn = hasEn || hasNonEmptyCaption(readFileSafe(path.join(dir, "resource.en-US.xml")));
			parameterResourceText = parameterResourceText || ruText;
		}
		if (!isSubstitution) {
			for (const issue of checkProcessUserTaskCaptionCoverage(schemaName, hasRu, hasEn)) {
				findings.push({
					packageName: packageFromPath(filePath),
					label: schemaName,
					message: issue.message,
					filePath,
					position: namePosition
				});
			}
		}

		const metadataPath = path.join(schemaDir, "metadata.json");
		const metadataText = readFileSafe(metadataPath);
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
			for (const issue of checkProcessUserTaskParameterDirectionSuffix(parameterNames, settings)) {
				findings.push({
					packageName: packageFromPath(filePath),
					label: schemaName,
					message: issue.message,
					filePath,
					position: namePosition
				});
			}
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
	private findingsForCsharpSchema(filePath: string, settings: CsharpNamingSettings): NamingFinding[] {
		const text = readFileSafe(filePath);
		if (text === undefined) {
			return [];
		}
		const schema = findSchemaDir(filePath);
		const descriptorPath = schema ? path.join(schema.schemaDir, "descriptor.json") : undefined;
		const descriptorText = descriptorPath ? readFileSafe(descriptorPath) : undefined;
		const info = descriptorText ? parseDescriptorInfo(descriptorText) : undefined;
		const schemaName = info?.name;
		if (schemaName && descriptorText && parseDescriptorParent(descriptorText) === schemaName) {
			return [];
		}
		// The role-suffix vocabulary is naming-guidelines.md §4's own — a
		// Process/UserTask/Entity schema's own attached .cs file is subject
		// to that OTHER guideline point's own suffix instead (e.g.
		// "UserTask", not in §4's list), so checking it here would just be a
		// guaranteed false positive. Same scoping as the Title-coverage
		// check below.
		const effectiveSettings: CsharpNamingSettings = {
			...settings,
			checkRoleSuffix: settings.checkRoleSuffix && info?.managerName === "SourceCodeSchemaManager"
		};
		const findings = checkCsharpSchemaNaming(text, effectiveSettings, schemaName).map((issue) => ({
			packageName: packageFromPath(filePath),
			label: schemaName || path.basename(filePath, ".cs"),
			message: issue.message,
			filePath,
			position: offsetToPosition(text, issue.start)
		}));

		if (info?.managerName === "SourceCodeSchemaManager" && schema && descriptorPath && descriptorText) {
			const name = schemaName || schema.schemaName;
			const namePosition = offsetToPosition(descriptorText, locateJsonNameOffset(descriptorText, name));
			let hasRu = false;
			let hasEn = false;
			for (const dir of findResourceDirs(schema.schemaDir, name)) {
				hasRu = hasRu || hasNonEmptyCaption(readFileSafe(path.join(dir, "resource.ru-RU.xml")));
				hasEn = hasEn || hasNonEmptyCaption(readFileSafe(path.join(dir, "resource.en-US.xml")));
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

		return findings;
	}

	private async findingsForSqlScript(
		filePath: string,
		gitRoot: string | undefined,
		tempMaxAgeDays: number
	): Promise<NamingFinding[]> {
		const text = readFileSafe(filePath);
		if (text === undefined) {
			return [];
		}
		const scriptName = parseSqlScriptDescriptorName(text);
		if (!scriptName) {
			return [];
		}
		const findings = checkSqlScriptNaming(scriptName).map((issue) => ({
			packageName: packageFromPath(filePath),
			label: scriptName,
			message: issue.message,
			filePath,
			position: offsetToPosition(text, locateJsonNameOffset(text, scriptName))
		}));
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
	private findingsForDataSchema(
		filePath: string,
		sysSettingsOccurrences: SysSettingsOccurrence[],
		sysSettingsValueOccurrences: SysSettingsValueOccurrence[]
	): NamingFinding[] {
		const text = readFileSafe(filePath);
		if (text === undefined) {
			return [];
		}
		const info = parseDataSchemaDescriptor(text);
		if (!info) {
			return [];
		}
		const findings = checkDataSchemaCodeNaming(info.code, info.tableName).map((issue) => ({
			packageName: packageFromPath(filePath),
			label: info.code,
			message: issue.message,
			filePath,
			position: offsetToPosition(text, locateJsonNameOffset(text, info.code))
		}));

		if (info.tableName === "SysSettings" || info.tableName === "SysSettingsValue") {
			const dataText = readFileSafe(path.join(path.dirname(filePath), "data.json"));
			if (dataText !== undefined) {
				if (info.tableName === "SysSettings") {
					sysSettingsOccurrences.push({
						code: info.code,
						filePath,
						rowId: readDataRowColumnValue(text, dataText, "Id")
					});
				} else {
					sysSettingsValueOccurrences.push({
						code: info.code,
						filePath,
						referencedSysSettingsId: readDataRowColumnValue(text, dataText, "SysSettings")
					});
				}
			}
		}

		return findings;
	}
}

/** `.../Pkg/...` → `.../Pkg` — the git root, per the confirmed repo topology
 * (the whole `Pkg` folder is one git repo). Used only by the single-file
 * `findingsForFile` path; `scanWorkspace` already has `layout.pkgRoot` from
 * its own loop. */
function pkgRootFromFilePath(filePath: string): string | undefined {
	const match = /^(.*\/Pkg)\//.exec(filePath.replace(/\\/g, "/"));
	return match ? match[1].replace(/\//g, path.sep) : undefined;
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

function readFileSafe(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
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
	const match = /\/Pkg\/([^/]+)\//.exec(filePath.replace(/\\/g, "/"));
	return match ? match[1] : "?";
}

function locateJsonNameOffset(text: string, name: string): number {
	const re = new RegExp(`"Name"\\s*:\\s*"${escapeRegExp(name)}"`);
	const match = re.exec(text);
	if (!match) {
		return 0;
	}
	return match.index + match[0].lastIndexOf(`"${name}"`) + 1;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function offsetToPosition(text: string, offset: number): vscode.Position {
	const before = text.slice(0, Math.max(0, offset));
	const lines = before.split(/\r\n|\r|\n/);
	const line = lines.length - 1;
	const character = lines[lines.length - 1].length;
	return new vscode.Position(line, character);
}
