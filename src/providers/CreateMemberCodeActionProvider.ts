import * as vscode from "vscode";
import {
	collectThisMemberAccesses,
	CreateMemberKind,
	planCreateMemberInsert,
	ThisMemberAccess
} from "../parse/amdParser";
import {
	DIAG_MISSING_ATTRIBUTE,
	DIAG_MISSING_METHOD,
	DIAG_MISSING_PROPERTY,
	DIAG_SOURCE,
	MissingMemberDiagnostics
} from "./MissingMemberDiagnostics";

export const CREATE_MEMBER_COMMAND = "bpmsoft.createMember";

export interface CreateMemberArgs {
	filePath: string;
	kind: CreateMemberKind;
	name: string;
	params?: string[];
}

const MEMBER_FIX_CODES = new Set([
	DIAG_MISSING_METHOD,
	DIAG_MISSING_PROPERTY,
	DIAG_MISSING_ATTRIBUTE
]);

export class CreateMemberCodeActionProvider implements vscode.CodeActionProvider {
	provideCodeActions(
		document: vscode.TextDocument,
		_range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext
	): vscode.CodeAction[] {
		const diags = context.diagnostics.filter(
			(d) => d.source === DIAG_SOURCE && MEMBER_FIX_CODES.has(String(d.code ?? ""))
		);
		if (!diags.length) {
			return [];
		}
		const needAccesses = diags.some((d) => String(d.code) === DIAG_MISSING_METHOD);
		const accesses = needAccesses ? collectThisMemberAccesses(document.getText()) : [];
		const actions: vscode.CodeAction[] = [];
		for (const diag of diags) {
			createsForDiagnostic(document, diag, accesses).forEach((req, i) => {
				const action = new vscode.CodeAction(
					titleFor(req.kind, req.name),
					vscode.CodeActionKind.QuickFix
				);
				action.diagnostics = [diag];
				action.isPreferred = i === 0;
				action.command = {
					title: action.title,
					command: CREATE_MEMBER_COMMAND,
					arguments: [req]
				};
				actions.push(action);
			});
		}
		return actions;
	}
}

export async function executeCreateMember(
	args: CreateMemberArgs | undefined,
	diagnostics: MissingMemberDiagnostics
): Promise<void> {
	if (!args?.filePath || !args.name || !args.kind) {
		return;
	}
	const uri = vscode.Uri.file(args.filePath);
	const document = await vscode.workspace.openTextDocument(uri);
	const insert = planCreateMemberInsert(
		document.getText(),
		args.kind,
		args.name,
		args.params
	);
	if (!insert) {
		void vscode.window.showWarningMessage(
			`BPMSoft: не удалось найти секцию для «${args.name}»`
		);
		return;
	}
	const edit = new vscode.WorkspaceEdit();
	edit.replace(
		uri,
		new vscode.Range(
			document.positionAt(insert.start),
			document.positionAt(insert.end)
		),
		insert.text
	);
	if (await vscode.workspace.applyEdit(edit)) {
		diagnostics.refresh(document);
	}
}

function titleFor(kind: CreateMemberKind, name: string): string {
	if (kind === "method") {
		return `Создать метод ${name}`;
	}
	if (kind === "property") {
		return `Создать свойство ${name}`;
	}
	return `Создать атрибут ${name}`;
}

function createsForDiagnostic(
	document: vscode.TextDocument,
	diag: vscode.Diagnostic,
	accesses: ThisMemberAccess[]
): CreateMemberArgs[] {
	const raw = document.getText(diag.range);
	const name = raw.startsWith("$") ? raw.slice(1) : raw;
	if (!name) {
		return [];
	}
	const filePath = document.uri.fsPath;
	const code = String(diag.code ?? "");
	if (code === DIAG_MISSING_METHOD) {
		const start = document.offsetAt(diag.range.start);
		const end = document.offsetAt(diag.range.end);
		const access = accesses.find(
			(item) =>
				item.kind === "methodCall" && item.start === start && item.end === end
		);
		return [{ filePath, kind: "method", name, params: access?.argNames }];
	}
	if (code === DIAG_MISSING_PROPERTY) {
		return [
			{ filePath, kind: "property", name },
			{ filePath, kind: "method", name }
		];
	}
	if (code === DIAG_MISSING_ATTRIBUTE) {
		return [{ filePath, kind: "attribute", name }];
	}
	return [];
}
