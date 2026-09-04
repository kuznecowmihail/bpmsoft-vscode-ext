import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
	DescriptorInfo,
	parseDescriptorInfo,
	parseDescriptorParent,
	parseSqlScriptDescriptorName
} from "../index/schemaStructureParse";
import { findSchemaDir } from "../index/schemaResourceLookup";
import { ClientSchemaNamingSettings, checkClientSchemaNaming } from "../parse/schemaNamingAnalyzer";
import { checkCsharpSchemaNaming } from "../parse/csharpSchemaAnalyzer";
import { checkSqlScriptNaming } from "../parse/sqlNamingAnalyzer";
import { parseDataSchemaDescriptor } from "../parse/dataSchemaMetadata";
import { checkDataSchemaCodeNaming } from "../parse/dataSchemaNamingAnalyzer";
import { extractNamingSubject } from "../parse/namingCommon";
import { SymbolIndex } from "../index/SymbolIndex";
import {
	clientSchemaNamingCheckModuleSuffix,
	csharpNamingCheckRoleSuffix,
	csharpNamingCheckSingleClassPerSchema,
	csharpNamingRoleSuffixes,
	namingDiagnosticsEnabled,
	namingIgnoredNames,
	namingPrefixes
} from "../config";
import { clearDebounceTimers, debounceDocument } from "./jsDocuments";

export const NAMING_DIAG_SOURCE = "bpmsoft-naming";

interface PositionedIssue {
	message: string;
	start: number;
	end: number;
}

export function isNamingDiagnosticsTarget(fsPath: string): boolean {
	const normalized = fsPath.replace(/\\/g, "/");
	return (
		/\/SqlScripts\/[^/]+\/descriptor\.json$/i.test(normalized) ||
		/\/Schemas\/[^/]+\/descriptor\.json$/i.test(normalized) ||
		(/\.cs$/i.test(normalized) && /\/Schemas\//i.test(normalized)) ||
		/\/Data\/[^/]+\/descriptor\.json$/i.test(normalized)
	);
}

export class NamingDiagnostics implements vscode.Disposable {
	private readonly collection: vscode.DiagnosticCollection;
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(private readonly index: SymbolIndex) {
		this.collection = vscode.languages.createDiagnosticCollection("bpmsoft-naming");
	}

	dispose(): void {
		this.clearAll();
		this.collection.dispose();
	}

	clearAll(): void {
		clearDebounceTimers(this.timers);
		this.collection.clear();
	}

	schedule(document: vscode.TextDocument): void {
		debounceDocument(
			this.timers,
			document,
			(doc) => this.refresh(doc),
			300,
			(doc) => isNamingDiagnosticsTarget(doc.uri.fsPath)
		);
	}

	refresh(document: vscode.TextDocument): void {
		if (!isNamingDiagnosticsTarget(document.uri.fsPath)) {
			return;
		}
		if (!namingDiagnosticsEnabled()) {
			this.collection.delete(document.uri);
			return;
		}
		try {
			const normalized = document.uri.fsPath.replace(/\\/g, "/");
			const issues = /\/SqlScripts\//i.test(normalized)
				? this.checkSqlDescriptor(document)
				: /\/Data\//i.test(normalized)
					? this.checkDataDescriptor(document)
					: normalized.endsWith(".cs")
						? this.checkCsharpSchema(document)
						: this.checkSchemaDescriptor(document);
			const ignored = new Set(namingIgnoredNames());
			const filtered = ignored.size
				? issues.filter((issue) => {
						const subject = extractNamingSubject(issue.message);
						return !subject || !ignored.has(subject);
					})
				: issues;
			this.collection.set(document.uri, filtered.map((issue) => toDiagnostic(document, issue)));
		} catch {
			this.collection.delete(document.uri);
		}
	}

	refreshOpenDocuments(): void {
		for (const document of vscode.workspace.textDocuments) {
			this.refresh(document);
		}
	}

	clear(uri: vscode.Uri): void {
		this.collection.delete(uri);
	}

	private checkSchemaDescriptor(document: vscode.TextDocument): PositionedIssue[] {
		const text = document.getText();
		const info = parseDescriptorInfo(text);
		const schemaName = info?.name || path.basename(path.dirname(document.uri.fsPath));
		if (!schemaName) {
			return [];
		}
		// Parent.Name === own Name means this schema is a same-name
		// override/extension of a schema from another (often stock) package
		// — the name itself wasn't chosen here, so naming it isn't this
		// package's call to get right or wrong.
		const parentName = parseDescriptorParent(text);
		if (parentName === schemaName) {
			return [];
		}
		const schemaType = this.index.hierarchy.resolveSchemaType(schemaName);
		const moduleSource = schemaType === "MODULE" ? readModuleSource(document.uri.fsPath, schemaName) : undefined;
		const settings: ClientSchemaNamingSettings = {
			prefixes: namingPrefixes(),
			checkModuleSuffix: clientSchemaNamingCheckModuleSuffix()
		};
		const pos = locateJsonNameValue(text, schemaName);
		return checkClientSchemaNaming(schemaName, schemaType, settings, parentName, moduleSource).map(
			(issue) => ({
				...issue,
				...pos
			})
		);
	}

	private checkSqlDescriptor(document: vscode.TextDocument): PositionedIssue[] {
		const text = document.getText();
		const scriptName = parseSqlScriptDescriptorName(text);
		if (!scriptName) {
			return [];
		}
		const pos = locateJsonNameValue(text, scriptName);
		return checkSqlScriptNaming(scriptName).map((issue) => ({ ...issue, ...pos }));
	}

	/** `Data/{Name}/descriptor.json` (naming-guidelines.md §5) — Code naming
	 * only (against its own target table, `Descriptor.Schema.Name`). The
	 * SysSettings/SysSettingsValue pairing check needs every occurrence in
	 * the workspace at once, so it only ever shows up via `NamingIssuesIndex`
	 * (tree view / Packages decorations), not here. */
	private checkDataDescriptor(document: vscode.TextDocument): PositionedIssue[] {
		const text = document.getText();
		const info = parseDataSchemaDescriptor(text);
		if (!info) {
			return [];
		}
		const pos = locateJsonNameValue(text, info.code);
		return checkDataSchemaCodeNaming(info.code, info.tableName).map((issue) => ({ ...issue, ...pos }));
	}

	private checkCsharpSchema(document: vscode.TextDocument): PositionedIssue[] {
		const info = csharpSchemaDescriptorInfo(document.uri.fsPath);
		return checkCsharpSchemaNaming(
			document.getText(),
			{
				prefixes: namingPrefixes(),
				// The role-suffix vocabulary is naming-guidelines.md §4's own
				// (Service/Helper/Manager/...) — a Process/UserTask/Entity
				// schema's own attached .cs file is subject to that OTHER
				// guideline point's own suffix instead (e.g. "UserTask"),
				// which isn't in §4's list, so checking it here would just be
				// a guaranteed false positive. Same scoping as the
				// Title-coverage check in NamingIssuesIndex.ts.
				checkRoleSuffix: csharpNamingCheckRoleSuffix() && info?.managerName === "SourceCodeSchemaManager",
				roleSuffixes: csharpNamingRoleSuffixes(),
				checkSingleClassPerSchema: csharpNamingCheckSingleClassPerSchema()
			},
			info?.name
		);
	}
}

/** The schema's registered name and ManagerName, from `descriptor.json` in
 * the same `Schemas/{Name}/` folder as `filePath` (a .cs file) — the
 * authoritative source naming-guidelines.md checks are meant to validate
 * against, same as for JS/SQL schemas. `undefined` if the descriptor is
 * missing/unreadable, letting the caller fall back to the source-extracted
 * class name. */
function csharpSchemaDescriptorInfo(filePath: string): DescriptorInfo | undefined {
	const schema = findSchemaDir(filePath);
	if (!schema) {
		return undefined;
	}
	try {
		const descriptorText = fs.readFileSync(path.join(schema.schemaDir, "descriptor.json"), "utf8");
		return parseDescriptorInfo(descriptorText);
	} catch {
		return undefined;
	}
}

/** A Module-type client schema's own `{Name}.js`/`{Name}.less` — siblings of
 * `descriptorPath` in the same `Schemas/{Name}/` folder. Mirrors
 * `NamingIssuesIndex.ts`'s own `readModuleSource`. */
function readModuleSource(
	descriptorPath: string,
	schemaName: string
): { js: string; less?: string } | undefined {
	const dir = path.dirname(descriptorPath);
	try {
		const js = fs.readFileSync(path.join(dir, `${schemaName}.js`), "utf8");
		let less: string | undefined;
		try {
			less = fs.readFileSync(path.join(dir, `${schemaName}.less`), "utf8");
		} catch {
			less = undefined;
		}
		return { js, less };
	} catch {
		return undefined;
	}
}

function locateJsonNameValue(text: string, name: string): { start: number; end: number } {
	const re = new RegExp(`"Name"\\s*:\\s*"${escapeRegExp(name)}"`);
	const match = re.exec(text);
	if (match) {
		const valueStart = match.index + match[0].lastIndexOf(`"${name}"`) + 1;
		return { start: valueStart, end: valueStart + name.length };
	}
	return { start: 0, end: Math.min(text.length, 1) };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toDiagnostic(document: vscode.TextDocument, issue: PositionedIssue): vscode.Diagnostic {
	const diag = new vscode.Diagnostic(
		new vscode.Range(document.positionAt(issue.start), document.positionAt(issue.end)),
		issue.message,
		vscode.DiagnosticSeverity.Warning
	);
	diag.source = NAMING_DIAG_SOURCE;
	return diag;
}
