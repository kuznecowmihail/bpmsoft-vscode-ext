import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { resolveAppLayouts, walkFiles } from "./workspaceLayout";
import {
	parseDescriptorInfo,
	parseDescriptorParent,
	parseSqlScriptDescriptorName
} from "./schemaStructureParse";
import { findSchemaDir } from "./schemaResourceLookup";
import { checkClientSchemaNaming } from "../parse/schemaNamingAnalyzer";
import { checkCsharpSchemaNaming } from "../parse/csharpSchemaAnalyzer";
import { checkSqlScriptNaming } from "../parse/sqlNamingAnalyzer";
import { SymbolIndex } from "./SymbolIndex";
import { namingDiagnosticsEnabled, namingPrefixes } from "../config";

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
	 * deleted, use `refreshFile` instead. */
	refresh(): void {
		this._findings = namingDiagnosticsEnabled() ? this.scanWorkspace() : [];
		this.changeEmitter.fire();
	}

	/** Re-checks just one file instead of the whole workspace — this is what
	 * keeps a single schema save from re-reading every descriptor.json/.cs
	 * file under `Pkg` (a full `refresh()` takes ~1s+ on a large install,
	 * which used to run synchronously on every save and freeze the UI).
	 * Works uniformly for modify/create/delete: any existing findings for
	 * `filePath` are dropped first, then re-added only if the file still
	 * exists and is still a naming-relevant target. */
	refreshFile(filePath: string): void {
		if (!namingDiagnosticsEnabled()) {
			return;
		}
		const fresh = this.findingsForFile(filePath, namingPrefixes());
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

	private scanWorkspace(): NamingFinding[] {
		const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];
		const layouts = resolveAppLayouts(folders);
		const prefixes = namingPrefixes();
		const out: NamingFinding[] = [];
		for (const layout of layouts) {
			if (!layout.pkgRoot) {
				continue;
			}
			const clientSchemaFiles = walkFiles(
				layout.pkgRoot,
				(name) => name === "descriptor.json",
				(p) => /\/Schemas\/[^/]+\/descriptor\.json$/i.test(p.replace(/\\/g, "/"))
			);
			for (const filePath of clientSchemaFiles) {
				out.push(...this.findingsForClientSchema(filePath, prefixes));
			}
			const csharpFiles = walkFiles(
				layout.pkgRoot,
				(name) => name.endsWith(".cs"),
				(p) => /\/Schemas\//i.test(p.replace(/\\/g, "/"))
			);
			for (const filePath of csharpFiles) {
				out.push(...this.findingsForCsharpSchema(filePath, prefixes));
			}
			const sqlScriptFiles = walkFiles(
				layout.pkgRoot,
				(name) => name === "descriptor.json",
				(p) => /\/SqlScripts\/[^/]+\/descriptor\.json$/i.test(p.replace(/\\/g, "/"))
			);
			for (const filePath of sqlScriptFiles) {
				out.push(...this.findingsForSqlScript(filePath));
			}
		}
		return out;
	}

	/** Dispatches a single file to the right per-category check based on its
	 * path shape — mirrors the three branches `scanWorkspace` walks, but for
	 * exactly one file. Returns `[]` (not an error) for a file that isn't a
	 * naming target at all, or that no longer exists (deleted). */
	private findingsForFile(filePath: string, prefixes: string[]): NamingFinding[] {
		const normalized = filePath.replace(/\\/g, "/");
		if (/\/SqlScripts\/[^/]+\/descriptor\.json$/i.test(normalized)) {
			return this.findingsForSqlScript(filePath);
		}
		if (/\/Schemas\/[^/]+\/descriptor\.json$/i.test(normalized)) {
			return this.findingsForClientSchema(filePath, prefixes);
		}
		if (/\.cs$/i.test(normalized) && /\/Schemas\//i.test(normalized)) {
			return this.findingsForCsharpSchema(filePath, prefixes);
		}
		return [];
	}

	private findingsForClientSchema(filePath: string, prefixes: string[]): NamingFinding[] {
		const text = readFileSafe(filePath);
		if (text === undefined) {
			return [];
		}
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

	private findingsForCsharpSchema(filePath: string, prefixes: string[]): NamingFinding[] {
		const text = readFileSafe(filePath);
		if (text === undefined) {
			return [];
		}
		const schemaName = csharpSchemaDescriptorName(filePath);
		return checkCsharpSchemaNaming(text, prefixes, schemaName).map((issue) => ({
			packageName: packageFromPath(filePath),
			label: schemaName || path.basename(filePath, ".cs"),
			message: issue.message,
			filePath,
			position: offsetToPosition(text, issue.start)
		}));
	}

	private findingsForSqlScript(filePath: string): NamingFinding[] {
		const text = readFileSafe(filePath);
		if (text === undefined) {
			return [];
		}
		const scriptName = parseSqlScriptDescriptorName(text);
		if (!scriptName) {
			return [];
		}
		return checkSqlScriptNaming(scriptName).map((issue) => ({
			packageName: packageFromPath(filePath),
			label: scriptName,
			message: issue.message,
			filePath,
			position: offsetToPosition(text, locateJsonNameOffset(text, scriptName))
		}));
	}
}

function readFileSafe(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

/** The schema's registered name, from `descriptor.json` in the same
 * `Schemas/{Name}/` folder as `filePath` (a .cs file) — the authoritative
 * source naming-guidelines.md checks are meant to validate against, same as
 * for JS/SQL schemas. `undefined` if the descriptor is missing/unreadable,
 * letting the caller fall back to the source-extracted class name. */
function csharpSchemaDescriptorName(filePath: string): string | undefined {
	const schema = findSchemaDir(filePath);
	if (!schema) {
		return undefined;
	}
	const descriptorText = readFileSafe(path.join(schema.schemaDir, "descriptor.json"));
	if (!descriptorText) {
		return undefined;
	}
	return parseDescriptorInfo(descriptorText)?.name;
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
