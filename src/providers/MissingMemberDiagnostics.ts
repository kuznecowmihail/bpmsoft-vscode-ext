import * as path from "path";
import * as vscode from "vscode";
import { SymbolIndex } from "../index/SymbolIndex";
import { IndexedMember, isPrivateMemberFromOtherFile, IndexedSchemaMessage, sandboxMessageIssue, schemaMessageDirectionLabel } from "../index/types";
import { collectThisMemberAccesses, parseAmdAst, ThisMemberAccess } from "../parse/amdParser";
import { clearDebounceTimers, debounceDocument, isJsFile } from "./jsDocuments";

export const DIAG_SOURCE = "BPMSoft";
export const DIAG_MISSING_METHOD = "bpmsoft.missingMethod";
export const DIAG_MISSING_BINDTO = "bpmsoft.missingBindTo";
export const DIAG_MISSING_PROPERTY = "bpmsoft.missingProperty";
export const DIAG_MISSING_ATTRIBUTE = "bpmsoft.missingAttribute";
export const DIAG_MISSING_MIXIN = "bpmsoft.missingMixin";
export const DIAG_MISSING_MIXIN_METHOD = "bpmsoft.missingMixinMethod";
export const DIAG_MISSING_MIXIN_PROPERTY = "bpmsoft.missingMixinProperty";
export const DIAG_PRIVATE_MEMBER = "bpmsoft.privateMember";
export const DIAG_UNKNOWN_SANDBOX_MESSAGE = "bpmsoft.unknownSandboxMessage";
export const DIAG_SANDBOX_MESSAGE_DIRECTION = "bpmsoft.sandboxMessageDirection";

const METHOD_ALLOWLIST = new Set(["callParent"]);
const BARE_ALLOWLIST = new Set(["callParent", "mixins"]);

export class MissingMemberDiagnostics implements vscode.Disposable {
	private readonly collection: vscode.DiagnosticCollection;
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(private readonly index: SymbolIndex) {
		this.collection = vscode.languages.createDiagnosticCollection("bpmsoft");
	}

	dispose(): void {
		clearDebounceTimers(this.timers);
		this.collection.dispose();
	}

	schedule(document: vscode.TextDocument): void {
		debounceDocument(this.timers, document, (doc) => this.refresh(doc));
	}

	refresh(document: vscode.TextDocument): void {
		if (!isJsFile(document)) {
			return;
		}
		const filePath = document.uri.fsPath;
		const source = document.getText();
		const parsed = parseAmdAst(source, filePath);
		if (!parsed) {
			this.collection.delete(document.uri);
			return;
		}
		this.index.upsertModule(parsed.module);

		const known = indexKnownMembers(this.index.resolveThisMembers(filePath));
		const messages = this.index.resolveSchemaMessages(filePath);
		const isPage = parsed.module.kind === "page";
		const diags: vscode.Diagnostic[] = [];
		for (const access of collectThisMemberAccesses(source, parsed.ast)) {
			const diag = diagnosticForAccess(
				document,
				access,
				known,
				isPage,
				filePath,
				messages
			);
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

interface MemberCatalog {
	methods: Set<string>;
	all: Set<string>;
	origins: Map<string, string>;
}

interface MixinCatalog extends MemberCatalog {
	resolved: boolean;
}

function catalogMembers(members: IndexedMember[]): MemberCatalog {
	const methods = new Set<string>();
	const all = new Set<string>();
	const origins = new Map<string, string>();
	for (const member of members) {
		all.add(member.name);
		if (member.filePath) {
			origins.set(member.name, member.filePath);
		}
		if (member.kind === "method") {
			methods.add(member.name);
		}
	}
	return { methods, all, origins };
}

function indexKnownMembers(members: IndexedMember[]): {
	methods: Set<string>;
	attributes: Set<string>;
	all: Set<string>;
	origins: Map<string, string>;
	mixins: Set<string>;
	mixinMembers: Map<string, MixinCatalog>;
} {
	const catalog = catalogMembers(members);
	const attributes = new Set<string>();
	for (const member of members) {
		if (member.kind === "attribute") {
			attributes.add(member.name);
		}
	}
	const mixins = new Set<string>();
	const mixinMembers = new Map<string, MixinCatalog>();
	const bag = members.find((m) => m.name === "mixins");
	for (const child of bag?.children || []) {
		mixins.add(child.name);
		const nested = catalogMembers(child.children || []);
		if (child.filePath) {
			for (const item of child.children || []) {
				if (!nested.origins.has(item.name)) {
					nested.origins.set(item.name, child.filePath);
				}
			}
		}
		mixinMembers.set(child.name, {
			...nested,
			resolved: Boolean(child.filePath)
		});
	}
	return {
		methods: catalog.methods,
		attributes,
		all: catalog.all,
		origins: catalog.origins,
		mixins,
		mixinMembers
	};
}

function diagnosticForAccess(
	document: vscode.TextDocument,
	access: ThisMemberAccess,
	known: ReturnType<typeof indexKnownMembers>,
	isPage: boolean,
	currentFilePath: string,
	messages: Record<string, IndexedSchemaMessage>
): vscode.Diagnostic | undefined {
	if (access.kind === "sandboxPublish" || access.kind === "sandboxSubscribe") {
		return diagnosticForSandboxMessage(document, access, messages);
	}
	if (access.kind === "mixin") {
		if (known.mixins.has(access.name)) {
			return undefined;
		}
		return makeDiag(
			document,
			access,
			vscode.DiagnosticSeverity.Error,
			DIAG_MISSING_MIXIN,
			`Миксин «${access.name}» не найден в схеме или иерархии`
		);
	}
	if (access.kind === "mixinMethod" || access.kind === "mixinProperty") {
		return diagnosticForMixinMember(document, access, known, currentFilePath);
	}
	if (access.kind === "methodCall") {
		if (METHOD_ALLOWLIST.has(access.name) || known.methods.has(access.name)) {
			return privateMemberDiag(
				document,
				access,
				"метод",
				known.origins.get(access.name),
				currentFilePath
			);
		}
		return makeDiag(
			document,
			access,
			vscode.DiagnosticSeverity.Error,
			DIAG_MISSING_METHOD,
			`Метод «${access.name}» не найден в схеме или иерархии`
		);
	}
	if (access.kind === "diffBindTo") {
		if (
			known.methods.has(access.name) ||
			known.attributes.has(access.name)
		) {
			return undefined;
		}
		return makeDiag(
			document,
			access,
			vscode.DiagnosticSeverity.Error,
			DIAG_MISSING_BINDTO,
			`«${access.name}» из bindTo не найден как метод или атрибут схемы или иерархии`
		);
	}
	if (access.kind === "bare") {
		if (BARE_ALLOWLIST.has(access.name) || known.all.has(access.name)) {
			return privateMemberDiag(
				document,
				access,
				"свойство",
				known.origins.get(access.name),
				currentFilePath
			);
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

function diagnosticForSandboxMessage(
	document: vscode.TextDocument,
	access: ThisMemberAccess,
	messages: Record<string, IndexedSchemaMessage>
): vscode.Diagnostic | undefined {
	const action = access.kind === "sandboxPublish" ? "publish" : "subscribe";
	const issue = sandboxMessageIssue(messages, access.name, action);
	if (!issue) {
		return undefined;
	}
	if (issue === "missing") {
		return makeDiag(
			document,
			access,
			vscode.DiagnosticSeverity.Warning,
			DIAG_UNKNOWN_SANDBOX_MESSAGE,
			`Сообщение «${access.name}» не объявлено в блоке messages схемы, модуля или иерархии`
		);
	}
	const declared = messages[access.name];
	const needed =
		action === "publish" ? "PUBLISH или BIDIRECTIONAL" : "SUBSCRIBE или BIDIRECTIONAL";
	const verb = action === "publish" ? "публиковать" : "подписывать";
	return makeDiag(
		document,
		access,
		vscode.DiagnosticSeverity.Warning,
		DIAG_SANDBOX_MESSAGE_DIRECTION,
		`Сообщение «${access.name}» нельзя ${verb}: в messages направление ${schemaMessageDirectionLabel(declared.direction)}, нужно ${needed}`
	);
}

function diagnosticForMixinMember(
	document: vscode.TextDocument,
	access: ThisMemberAccess,
	known: ReturnType<typeof indexKnownMembers>,
	currentFilePath: string
): vscode.Diagnostic | undefined {
	const mixinName = access.mixinName;
	if (!mixinName || !known.mixins.has(mixinName)) {
		return undefined;
	}
	const members = known.mixinMembers.get(mixinName);
	if (!members?.resolved) {
		return undefined;
	}
	if (access.kind === "mixinMethod") {
		if (METHOD_ALLOWLIST.has(access.name) || members.methods.has(access.name)) {
			return privateMemberDiag(
				document,
				access,
				"метод",
				members.origins.get(access.name),
				currentFilePath,
				mixinName
			);
		}
		return makeDiag(
			document,
			access,
			vscode.DiagnosticSeverity.Error,
			DIAG_MISSING_MIXIN_METHOD,
			`Метод «${access.name}» не найден в миксине «${mixinName}»`
		);
	}
	if (METHOD_ALLOWLIST.has(access.name) || members.all.has(access.name)) {
		return privateMemberDiag(
			document,
			access,
			"свойство",
			members.origins.get(access.name),
			currentFilePath,
			mixinName
		);
	}
	return makeDiag(
		document,
		access,
		vscode.DiagnosticSeverity.Error,
		DIAG_MISSING_MIXIN_PROPERTY,
		`Свойство «${access.name}» не найдено в миксине «${mixinName}»`
	);
}

function privateMemberDiag(
	document: vscode.TextDocument,
	access: ThisMemberAccess,
	kindLabel: "метод" | "свойство",
	originFilePath: string | undefined,
	currentFilePath: string,
	mixinName?: string
): vscode.Diagnostic | undefined {
	if (!isPrivateMemberFromOtherFile(access.name, originFilePath, currentFilePath)) {
		return undefined;
	}
	const where = mixinName
		? `миксине «${mixinName}»`
		: path.basename(originFilePath as string);
	return makeDiag(
		document,
		access,
		vscode.DiagnosticSeverity.Warning,
		DIAG_PRIVATE_MEMBER,
		`Приватный ${kindLabel} «${access.name}» вызывается вне файла определения (${where})`
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
