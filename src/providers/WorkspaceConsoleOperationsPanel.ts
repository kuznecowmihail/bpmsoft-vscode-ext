import * as vscode from "vscode";
import * as path from "path";
import {
	CONF_RUNTIME_PARENT_DIRECTORY_REQUIRED,
	WORKSPACE_CONSOLE_BASE_PARAMS,
	WORKSPACE_CONSOLE_OPERATIONS,
	buildWorkspaceConsoleCommand
} from "../index/workspaceConsoleOperations";
import { DIALOG_CLIENT_SCRIPT, DIALOG_HTML, DIALOG_STYLE } from "./webviewDialogs";

function nonce(): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let out = "";
	for (let i = 0; i < 32; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}

let sharedTerminal: vscode.Terminal | undefined;

/** Persisted across sessions (not per-workspace — favorites are a personal
 * shortlist of operations, not something tied to a specific app root). */
const FAVORITES_KEY = "bpmsoft.workspaceConsole.favoriteOperations";

/**
 * Webview for building and launching a `WorkspaceConsole` command line —
 * picks one operation from `workspaceConsoleOperations.ts`'s catalog, fills
 * in its parameters, and hands the generated command to an integrated
 * terminal for the user to review before pressing Enter. Deliberately never
 * runs the command itself (`Terminal.sendText(cmd, false)` only types it in)
 * — these operations mutate the database, sometimes destructively, and this
 * extension has no way to know whether the target DB is prod.
 */
export class WorkspaceConsoleOperationsPanel {
	private static panel: WorkspaceConsoleOperationsPanel | undefined;

	private readonly webviewPanel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	static show(appRoot: string, dllPath: string, globalState: vscode.Memento): void {
		if (WorkspaceConsoleOperationsPanel.panel) {
			WorkspaceConsoleOperationsPanel.panel.webviewPanel.reveal(vscode.ViewColumn.Active);
			WorkspaceConsoleOperationsPanel.panel.init(appRoot, dllPath);
			return;
		}
		WorkspaceConsoleOperationsPanel.panel = new WorkspaceConsoleOperationsPanel(appRoot, dllPath, globalState);
	}

	private constructor(private appRoot: string, private dllPath: string, private readonly globalState: vscode.Memento) {
		this.webviewPanel = vscode.window.createWebviewPanel(
			"bpmsoftWorkspaceConsoleOperations",
			"Workspace Console: операции",
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		this.webviewPanel.onDidDispose(
			() => {
				WorkspaceConsoleOperationsPanel.panel = undefined;
				this.disposables.forEach((d) => d.dispose());
			},
			null,
			this.disposables
		);
		this.webviewPanel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), null, this.disposables);
		this.webviewPanel.webview.html = this.buildHtml();
		this.init(appRoot, dllPath);
	}

	private init(appRoot: string, dllPath: string): void {
		this.appRoot = appRoot;
		this.dllPath = dllPath;
		void this.webviewPanel.webview.postMessage({
			type: "init",
			appRoot,
			dllPath,
			baseParams: WORKSPACE_CONSOLE_BASE_PARAMS,
			operations: WORKSPACE_CONSOLE_OPERATIONS,
			confRuntimeRequiredOps: Array.from(CONF_RUNTIME_PARENT_DIRECTORY_REQUIRED),
			favorites: this.globalState.get<string[]>(FAVORITES_KEY, [])
		});
	}

	private handleMessage(msg: Record<string, unknown>): void {
		switch (msg.type) {
			case "toggleFavorite": {
				const opName = String(msg.opName);
				const favorites = this.globalState.get<string[]>(FAVORITES_KEY, []);
				const next = favorites.includes(opName) ? favorites.filter((f) => f !== opName) : [...favorites, opName];
				void this.globalState.update(FAVORITES_KEY, next);
				void this.webviewPanel.webview.postMessage({ type: "favorites", favorites: next });
				break;
			}
			case "updateValues": {
				const op = WORKSPACE_CONSOLE_OPERATIONS.find((o) => o.op === msg.opName);
				if (!op) {
					return;
				}
				const command = buildWorkspaceConsoleCommand(
					this.dllPath,
					op,
					(msg.baseValues as Record<string, string | boolean>) ?? {},
					(msg.opValues as Record<string, string | boolean>) ?? {},
					String(msg.extraArgs ?? "")
				);
				void this.webviewPanel.webview.postMessage({ type: "commandPreview", command });
				break;
			}
			case "openTerminal": {
				const workspaceConsoleDir = path.dirname(this.dllPath);
				if (!sharedTerminal || sharedTerminal.exitStatus !== undefined) {
					sharedTerminal = vscode.window.createTerminal({ name: "Workspace Console", cwd: workspaceConsoleDir });
				}
				sharedTerminal.show();
				sharedTerminal.sendText(String(msg.command), false);
				break;
			}
			case "copyCommand":
				void vscode.env.clipboard.writeText(String(msg.command));
				void vscode.window.showInformationMessage("Команда скопирована в буфер обмена");
				break;
		}
	}

	private buildHtml(): string {
		const csp = nonce();
		return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${csp}';" />
<title>Workspace Console: операции</title>
<style>
${STYLE}
${DIALOG_STYLE}
</style>
</head>
<body>
<p class="intro">Собирает команду запуска <code>BPMSoft.Tools.WorkspaceConsole.dll</code> (полный справочник операций — см. <a href="https://edu.bpmsoft.ru/baza-znaniy/workspaceconsole/nachalo-raboty-s-workspaceconsole/">edu.bpmsoft.ru</a>) и открывает её в терминале для проверки — команда только вставляется в терминал, <b>не выполняется автоматически</b>: часть операций необратимо меняет БД, проверьте всё перед Enter.</p>
<div id="layout">
  <div id="opList">
    <input id="opFilter" type="text" placeholder="Поиск операции..." />
    <div id="opTree"></div>
  </div>
  <div id="formArea">
    <div id="emptyState" class="muted">Выберите операцию слева.</div>
    <div id="opForm" hidden>
      <h2 id="opCaption"></h2>
      <p id="opDescription" class="muted"></p>
      <div id="warningBox" class="warning" hidden></div>
      <div class="boxHeader">Общие параметры</div>
      <div id="baseFields" class="fields"></div>
      <div class="boxHeader" id="opFieldsHeader" hidden>Параметры операции</div>
      <div id="opFields" class="fields"></div>
      <div class="boxHeader">Дополнительно</div>
      <div class="fields">
        <label class="field wide">
          <span>Другие аргументы (добавляются как есть)</span>
          <input id="extraArgs" type="text" placeholder='например -includedSchemas="MyPackage"' />
        </label>
      </div>
      <div class="boxHeader">Команда</div>
      <textarea id="commandPreview" readonly rows="3"></textarea>
      <div class="actionsRow">
        <button id="copyBtn" class="secondary">Скопировать</button>
        <button id="openTerminalBtn">Открыть в терминале</button>
      </div>
    </div>
  </div>
</div>
${DIALOG_HTML}
<script nonce="${csp}">
${DIALOG_CLIENT_SCRIPT}
${CLIENT_SCRIPT}
</script>
</body>
</html>`;
	}
}

const STYLE = `
	[hidden] { display: none !important; }
	body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); padding: 8px 12px; }
	.intro { color: var(--vscode-descriptionForeground); font-size: 12px; max-width: 1000px; margin: 0 0 10px; }
	.intro a { color: var(--vscode-textLink-foreground); }
	code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); padding: 0 3px; }
	#layout { display: flex; gap: 14px; align-items: flex-start; }
	#opList { flex: 0 0 320px; display: flex; flex-direction: column; gap: 6px; }
	#opFilter { padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
	#opTree { max-height: 78vh; overflow: auto; border: 1px solid var(--vscode-panel-border); }
	.catHeader { padding: 4px 8px; font-weight: 600; font-size: 12px; background: var(--vscode-sideBar-background); position: sticky; top: 0; }
	.catHeader.favHeader { color: var(--vscode-charts-yellow, #cca700); }
	.opRow { padding: 4px 8px 4px 4px; cursor: pointer; border-bottom: 1px solid var(--vscode-panel-border); font-size: 13px; display: flex; align-items: center; gap: 2px; }
	.opRow:hover { background: var(--vscode-list-hoverBackground); }
	.opRow.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
	.opRow .destructiveMark { color: var(--vscode-errorForeground, #f14c4c); margin-right: 3px; }
	.starBtn { background: transparent; border: none; padding: 0 2px; cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1; flex: 0 0 auto; }
	.starBtn:hover { background: transparent; color: var(--vscode-charts-yellow, #cca700); }
	.starBtn.active { color: var(--vscode-charts-yellow, #cca700); }
	#formArea { flex: 1; min-width: 0; }
	.muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
	.boxHeader { font-weight: 600; margin: 12px 0 6px; }
	.warning { border: 1px solid var(--vscode-inputValidation-warningBorder, orange); background: var(--vscode-inputValidation-warningBackground, rgba(255,165,0,0.1)); padding: 6px 10px; font-size: 12px; margin-bottom: 8px; }
	.fields { display: flex; flex-wrap: wrap; gap: 10px; }
	.field { display: flex; flex-direction: column; gap: 2px; font-size: 12px; flex: 0 0 260px; }
	.field.wide { flex: 1 1 100%; }
	.field.boolField { flex-direction: row; align-items: center; gap: 6px; }
	.field span { color: var(--vscode-descriptionForeground); }
	.field .req { color: var(--vscode-errorForeground, #f14c4c); }
	.field input[type=text], .field input[type=password] { padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); font-family: var(--vscode-editor-font-family); }
	#commandPreview { width: 100%; box-sizing: border-box; padding: 6px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); color: var(--vscode-editor-foreground); border: 1px solid var(--vscode-panel-border); font-family: var(--vscode-editor-font-family); resize: vertical; }
	.actionsRow { display: flex; gap: 8px; margin-top: 8px; }
	button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
`;

/** Plain browser JS, no build step — same convention as the other wizard panels. */
const CLIENT_SCRIPT = `
const vscode = acquireVsCodeApi();
let operations = [];
let baseParams = [];
let confRuntimeRequiredOps = [];
let favorites = [];
let selectedOp = null;
const baseValues = {};
let opValues = {};

/** Same as baseParams, except confRuntimeParentDirectory's "required" is
 * true only for the operations where WorkspaceConsole itself enforces it
 * (see CONF_RUNTIME_PARENT_DIRECTORY_REQUIRED) — it's optional for the rest —
 * and any flag the selected operation lists in optionalBaseParams (e.g.
 * LoadLicResponse doesn't need -workspaceName) is never required. */
function effectiveBaseParams() {
	const needsConfRuntime = selectedOp && confRuntimeRequiredOps.includes(selectedOp.op);
	const optedOut = (selectedOp && selectedOp.optionalBaseParams) || [];
	return baseParams.map((p) => {
		if (optedOut.includes(p.flag)) return { ...p, required: false };
		if (p.flag === 'confRuntimeParentDirectory') return { ...p, required: needsConfRuntime };
		return p;
	});
}

const opTreeEl = document.getElementById('opTree');
const opFilterEl = document.getElementById('opFilter');
const emptyStateEl = document.getElementById('emptyState');
const opFormEl = document.getElementById('opForm');
const opCaptionEl = document.getElementById('opCaption');
const opDescriptionEl = document.getElementById('opDescription');
const warningBoxEl = document.getElementById('warningBox');
const baseFieldsEl = document.getElementById('baseFields');
const opFieldsHeaderEl = document.getElementById('opFieldsHeader');
const opFieldsEl = document.getElementById('opFields');
const extraArgsEl = document.getElementById('extraArgs');
const commandPreviewEl = document.getElementById('commandPreview');

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function opRowHtml(op) {
	const mark = op.destructive ? '<span class="destructiveMark" title="Меняет/удаляет данные">⚠</span>' : '';
	const isFav = favorites.includes(op.op);
	const star = '<button class="starBtn' + (isFav ? ' active' : '') + '" type="button" data-op="' + escapeHtml(op.op) + '" title="' +
		(isFav ? 'Убрать из избранного' : 'Добавить в избранное') + '">' + (isFav ? '★' : '☆') + '</button>';
	return '<div class="opRow' + (selectedOp && selectedOp.op === op.op ? ' selected' : '') + '" data-op="' + escapeHtml(op.op) + '">' +
		star + mark + escapeHtml(op.caption) + '</div>';
}

function wireOpRows(container) {
	container.querySelectorAll('.opRow').forEach((el) => {
		el.addEventListener('click', (e) => {
			if (e.target.closest('.starBtn')) return;
			selectOp(el.dataset.op);
		});
	});
	container.querySelectorAll('.starBtn').forEach((el) => {
		el.addEventListener('click', (e) => {
			e.stopPropagation();
			vscode.postMessage({ type: 'toggleFavorite', opName: el.dataset.op });
		});
	});
}

function renderOpTree() {
	const q = opFilterEl.value.trim().toLowerCase();
	const matches = (op) => !q || op.caption.toLowerCase().includes(q) || op.op.toLowerCase().includes(q) || op.category.toLowerCase().includes(q);
	let html = '';
	if (favorites.length) {
		const favOps = favorites.map((name) => operations.find((o) => o.op === name)).filter((o) => o && matches(o));
		if (favOps.length) {
			html += '<div class="catHeader favHeader">★ Избранное</div>';
			for (const op of favOps) html += opRowHtml(op);
		}
	}
	const byCategory = new Map();
	for (const op of operations) {
		if (!matches(op)) continue;
		if (!byCategory.has(op.category)) byCategory.set(op.category, []);
		byCategory.get(op.category).push(op);
	}
	for (const [category, ops] of byCategory) {
		html += '<div class="catHeader">' + escapeHtml(category) + '</div>';
		for (const op of ops) html += opRowHtml(op);
	}
	opTreeEl.innerHTML = html || '<div class="muted" style="padding:8px;">Ничего не найдено</div>';
	wireOpRows(opTreeEl);
}

function fieldHtml(param, value, store) {
	const req = param.required ? '<span class="req"> *</span>' : '';
	const hint = param.hint ? ' title="' + escapeHtml(param.hint) + '"' : '';
	if (param.kind === 'bool') {
		const checked = value ? 'checked' : '';
		return '<label class="field boolField"' + hint + '><input type="checkbox" data-store="' + store + '" data-flag="' + escapeHtml(param.flag) + '" ' + checked + ' /><span>' + escapeHtml(param.label) + req + '</span></label>';
	}
	const inputType = param.kind === 'password' ? 'password' : 'text';
	return '<label class="field"' + hint + '><span>' + escapeHtml(param.label) + req + '</span>' +
		'<input type="' + inputType + '" data-store="' + store + '" data-flag="' + escapeHtml(param.flag) + '" value="' + escapeHtml(value || '') + '" /></label>';
}

function renderBaseFields() {
	baseFieldsEl.innerHTML = effectiveBaseParams().map((p) => fieldHtml(p, baseValues[p.flag], 'base')).join('');
	wireFields(baseFieldsEl, baseValues);
}

function renderOpFields() {
	if (!selectedOp.params.length) {
		opFieldsHeaderEl.hidden = true;
		opFieldsEl.innerHTML = '';
		return;
	}
	opFieldsHeaderEl.hidden = false;
	opFieldsEl.innerHTML = selectedOp.params.map((p) => fieldHtml(p, opValues[p.flag], 'op')).join('');
	wireFields(opFieldsEl, opValues);
}

function wireFields(container, store) {
	container.querySelectorAll('input[type=checkbox]').forEach((el) => {
		el.addEventListener('change', () => { store[el.dataset.flag] = el.checked; updatePreview(); });
	});
	container.querySelectorAll('input[type=text], input[type=password]').forEach((el) => {
		el.addEventListener('input', () => { store[el.dataset.flag] = el.value; updatePreview(); });
	});
}

function renderWarnings() {
	const missing = [];
	for (const p of effectiveBaseParams()) if (p.required && !baseValues[p.flag]) missing.push(p.label);
	for (const p of selectedOp.params) if (p.required && !opValues[p.flag]) missing.push(p.label);
	if (missing.length) {
		warningBoxEl.hidden = false;
		warningBoxEl.textContent = 'Не заполнены обязательные поля: ' + missing.join(', ');
	} else {
		warningBoxEl.hidden = true;
	}
}

function updatePreview() {
	renderWarnings();
	vscode.postMessage({
		type: 'updateValues',
		opName: selectedOp.op,
		baseValues,
		opValues,
		extraArgs: extraArgsEl.value
	});
}

function selectOp(opName) {
	selectedOp = operations.find((o) => o.op === opName);
	opValues = {};
	if (!selectedOp) return;
	emptyStateEl.hidden = true;
	opFormEl.hidden = false;
	opCaptionEl.textContent = selectedOp.caption;
	opDescriptionEl.textContent = selectedOp.description;
	renderOpTree();
	renderBaseFields();
	renderOpFields();
	extraArgsEl.value = '';
	updatePreview();
}

opFilterEl.addEventListener('input', renderOpTree);
extraArgsEl.addEventListener('input', updatePreview);

document.getElementById('copyBtn').addEventListener('click', () => {
	vscode.postMessage({ type: 'copyCommand', command: commandPreviewEl.value });
});
document.getElementById('openTerminalBtn').addEventListener('click', async () => {
	if (selectedOp && selectedOp.destructive) {
		const ok = await showConfirm('Эта операция может необратимо изменить или удалить данные («' + selectedOp.caption + '»). Команда будет вставлена в терминал, но не выполнена — проверьте её перед Enter. Продолжить?');
		if (!ok) return;
	}
	vscode.postMessage({ type: 'openTerminal', command: commandPreviewEl.value });
});

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (msg.type === 'init') {
		operations = msg.operations;
		baseParams = msg.baseParams;
		confRuntimeRequiredOps = msg.confRuntimeRequiredOps || [];
		favorites = msg.favorites || [];
		for (const p of baseParams) {
			if (p.defaultFromAppRoot && !baseValues[p.flag]) baseValues[p.flag] = msg.appRoot;
		}
		renderOpTree();
		if (selectedOp) selectOp(selectedOp.op);
	} else if (msg.type === 'favorites') {
		favorites = msg.favorites || [];
		renderOpTree();
	} else if (msg.type === 'commandPreview') {
		commandPreviewEl.value = msg.command;
	}
});
`;
