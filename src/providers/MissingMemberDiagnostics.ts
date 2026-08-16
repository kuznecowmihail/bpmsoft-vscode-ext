import * as vscode from "vscode";
import { SymbolIndex } from "../index/SymbolIndex";
import { IndexedMember } from "../index/types";
import { collectThisMemberAccesses, parseAmdModule, ThisMemberAccess } from "../parse/amdParser";

export const DIAG_SOURCE = "BPMSoft";
export const DIAG_MISSING_METHOD = "bpmsoft.missingMethod";
export const DIAG_MISSING_PROPERTY = "bpmsoft.missingProperty";
export const DIAG_MISSING_ATTRIBUTE = "bpmsoft.missingAttribute";

const DEBOUNCE_MS = 300;
const METHOD_ALLOWLIST = new Set(["callParent"]);
const BARE_ALLOWLIST = new Set(["callParent", "mixins"]);

export class MissingMemberDiagnostics implements vscode.Disposable {
	private readonly collection: vscode.DiagnosticCollection;
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(private readonly index: SymbolIndex) {
		this.collection = vscode.languages.createDiagnosticCollection("bpmsoft");
	}

	dispose(): void {
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();
		this.collection.dispose();
	}

	schedule(document: vscode.TextDocument): void {
		if (!isJsFile(document)) {
			return;
		}
		const key = document.uri.toString();
		const prev = this.timers.get(key);
		if (prev) {
			clearTimeout(prev);
		}
		this.timers.set(
			key,
			setTimeout(() => {
				this.timers.delete(key);
				this.refresh(document);
			}, DEBOUNCE_MS)
		);
	}

	refresh(document: vscode.TextDocument): void {
		if (!isJsFile(document)) {
			return;
		}
		const filePath = document.uri.fsPath;
		const source = document.getText();
		const parsed = parseAmdModule(source, filePath);
		if (!parsed) {
			this.collection.delete(document.uri);
			return;
		}
		this.index.upsertModule(parsed);

		const known = indexKnownMembers(this.index.resolveThisMembers(filePath));
		const isPage = parsed.kind === "page";
		const diags: vscode.Diagnostic[] = [];
		for (const access of collectThisMemberAccesses(source)) {
			const diag = diagnosticForAccess(document, access, known, isPage);
			if (diag) {
				diags.push(diag);
			}
		}
		this.collection.set(document.uri, diags);
	}

	refreshOpenDocuments(): void {
		for (const document of vscode.workspace.textDocuments) {
			this.refresh(document);
		}
	}

	clear(uri: vscode.Uri): void {
		this.collection.delete(uri);
	}
}

function isJsFile(document: vscode.TextDocument): boolean {
	return document.languageId === "javascript" && document.uri.scheme === "file";
}

function indexKnownMembers(members: IndexedMember[]): {
	methods: Set<string>;
	attributes: Set<string>;
	all: Set<string>;
} {
	const methods = new Set<string>();
	const attributes = new Set<string>();
	const all = new Set<string>();
	for (const member of members) {
		all.add(member.name);
		if (member.kind === "method") {
			methods.add(member.name);
		} else if (member.kind === "attribute") {
			attributes.add(member.name);
		}
	}
	return { methods, attributes, all };
}

function diagnosticForAccess(
	document: vscode.TextDocument,
	access: ThisMemberAccess,
	known: { methods: Set<string>; attributes: Set<string>; all: Set<string> },
	isPage: boolean
): vscode.Diagnostic | undefined {
	if (access.kind === "methodCall") {
		if (METHOD_ALLOWLIST.has(access.name) || known.methods.has(access.name)) {
			return undefined;
		}
		return makeDiag(
			document,
			access,
			vscode.DiagnosticSeverity.Error,
			DIAG_MISSING_METHOD,
			`Метод «${access.name}» не найден в схеме или иерархии`
		);
	}
	if (access.kind === "bare") {
		if (BARE_ALLOWLIST.has(access.name) || known.all.has(access.name)) {
			return undefined;
		}
		return makeDiag(
			document,
			access,
			vscode.DiagnosticSeverity.Warning,
			DIAG_MISSING_PROPERTY,
			`Свойство «${access.name}» не найдено в схеме или иерархии`
		);
	}
	if (!isPage || known.attributes.has(access.name)) {
		return undefined;
	}
	return makeDiag(
		document,
		access,
		vscode.DiagnosticSeverity.Warning,
		DIAG_MISSING_ATTRIBUTE,
		`Атрибут «${access.name}» не найден в схеме или иерархии`
	);
}

function makeDiag(
	document: vscode.TextDocument,
	access: { start: number; end: number },
	severity: vscode.DiagnosticSeverity,
	code: string,
	message: string
): vscode.Diagnostic {
	const diag = new vscode.Diagnostic(
		new vscode.Range(
			document.positionAt(access.start),
			document.positionAt(access.end)
		),
		message,
		severity
	);
	diag.source = DIAG_SOURCE;
	diag.code = code;
	return diag;
}
