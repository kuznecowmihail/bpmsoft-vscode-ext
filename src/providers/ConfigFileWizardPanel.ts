import * as vscode from "vscode";
import { AppConfigEntry } from "../index/appConfigDiscovery";
import {
	APP_SETTINGS_SPEC,
	CONNECTION_STRINGS_SPEC,
	XmlAddBlockSpec,
	addXmlAddEntry,
	deleteXmlAddEntry,
	listXmlAddEntries,
	renameXmlAddEntry,
	setXmlAddEntryValue
} from "../index/dotnetConfigEditor";
import {
	JsonLeafKind,
	addJsonLeaf,
	deleteJsonLeaf,
	listJsonLeaves,
	setJsonLeafValue
} from "../index/jsonSettingsEditor";

/** Key/path names whose value is masked (password toggle) by default — a
 * best-effort net for `appSettings`/`appsettings.json` leaves (e.g.
 * `MsgUserPasswordDESCryptoServiceKey`, `Certificate.Password`).
 * `connectionString` values are masked unconditionally instead (see
 * `ConfigFileWizardPanel.loadRows`) — a connection string is one blob that
 * almost always embeds `Password=...` inline, so name-matching on it isn't
 * reliable. */
const SENSITIVE_KEY_RE = /password|secret|pwd|token|apikey/i;

interface WireRow {
	id: string;
	value: string;
	sensitive: boolean;
	kind?: JsonLeafKind;
}

function nonce(): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let out = "";
	for (let i = 0; i < 32; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}

/**
 * Webview "wizard" for the three config-file shapes `appConfigDiscovery.ts`
 * finds — a filterable name/path -> value table with add/rename/delete, built
 * on the same shell/postMessage pattern as `LocalizationWizardPanel`. XML
 * entries (`connectionStrings`/`appSettings`) support rename; JSON leaves
 * (`appsettings.json`) don't (see `jsonSettingsEditor.ts`'s own doc for why).
 */
export class ConfigFileWizardPanel {
	private static readonly panels = new Map<string, ConfigFileWizardPanel>();

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly isJson: boolean;
	private readonly xmlSpec?: XmlAddBlockSpec;

	static show(entry: AppConfigEntry): void {
		const panelKey = `${entry.kind}:${entry.filePath}`;
		const existing = ConfigFileWizardPanel.panels.get(panelKey);
		if (existing) {
			existing.panel.reveal(vscode.ViewColumn.Active);
			existing.refresh();
			return;
		}
		new ConfigFileWizardPanel(entry, panelKey);
	}

	private constructor(private readonly entry: AppConfigEntry, private readonly panelKey: string) {
		this.isJson = entry.kind === "appSettingsJson";
		this.xmlSpec = entry.kind === "xmlAppSettings" ? APP_SETTINGS_SPEC : this.isJson ? undefined : CONNECTION_STRINGS_SPEC;

		this.panel = vscode.window.createWebviewPanel(
			"bpmsoftConfigFileWizard",
			entry.label,
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		ConfigFileWizardPanel.panels.set(panelKey, this);
		this.panel.onDidDispose(
			() => {
				ConfigFileWizardPanel.panels.delete(this.panelKey);
				this.disposables.forEach((d) => d.dispose());
			},
			null,
			this.disposables
		);
		this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), null, this.disposables);
		this.panel.webview.html = this.buildHtml();
		this.refresh();
	}

	private idLabel(): string {
		if (this.isJson) {
			return "Путь";
		}
		return this.xmlSpec === APP_SETTINGS_SPEC ? "Ключ" : "Имя";
	}

	private loadRows(): WireRow[] | undefined {
		if (this.isJson) {
			const leaves = listJsonLeaves(this.entry.filePath);
			if (!leaves) {
				return undefined;
			}
			return leaves.map((l) => ({
				id: l.path,
				value: l.display,
				sensitive: SENSITIVE_KEY_RE.test(l.path.split(".").pop() ?? ""),
				kind: l.kind
			}));
		}
		const entries = listXmlAddEntries(this.entry.filePath, this.xmlSpec!);
		if (!entries) {
			return undefined;
		}
		const alwaysMask = this.xmlSpec === CONNECTION_STRINGS_SPEC;
		return entries.map((e) => ({
			id: e.name,
			value: e.value,
			sensitive: alwaysMask || SENSITIVE_KEY_RE.test(e.name)
		}));
	}

	private refresh(): void {
		const rows = this.loadRows();
		if (rows === undefined) {
			void this.panel.webview.postMessage({ type: "error", message: "Не удалось прочитать файл" });
			return;
		}
		void this.panel.webview.postMessage({
			type: "init",
			canRename: !this.isJson,
			idLabel: this.idLabel(),
			rows
		});
	}

	private reportEdit(result: { ok: boolean; error?: string }, refreshOnSuccess = false): void {
		if (!result.ok) {
			void this.panel.webview.postMessage({ type: "error", message: result.error ?? "Не удалось сохранить" });
			return;
		}
		if (refreshOnSuccess) {
			this.refresh();
		}
	}

	private setValue(id: string, value: string, kind?: JsonLeafKind) {
		return this.isJson
			? setJsonLeafValue(this.entry.filePath, id, value, kind ?? "string")
			: setXmlAddEntryValue(this.entry.filePath, this.xmlSpec!, id, value);
	}

	private addEntry(id: string, value: string, kind?: JsonLeafKind) {
		return this.isJson
			? addJsonLeaf(this.entry.filePath, id, value, kind ?? "string")
			: addXmlAddEntry(this.entry.filePath, this.xmlSpec!, id, value);
	}

	private deleteEntry(id: string) {
		return this.isJson ? deleteJsonLeaf(this.entry.filePath, id) : deleteXmlAddEntry(this.entry.filePath, this.xmlSpec!, id);
	}

	private async handleMessage(msg: Record<string, unknown>): Promise<void> {
		try {
			switch (msg.type) {
				case "setValue":
					this.reportEdit(this.setValue(String(msg.id), String(msg.value), msg.kind as JsonLeafKind | undefined));
					break;
				case "addEntry":
					this.reportEdit(
						this.addEntry(String(msg.id), String(msg.value), msg.kind as JsonLeafKind | undefined),
						true
					);
					break;
				case "renameEntry":
					if (this.isJson) {
						return;
					}
					this.reportEdit(renameXmlAddEntry(this.entry.filePath, this.xmlSpec!, String(msg.oldId), String(msg.newId)), true);
					break;
				case "deleteEntry":
					this.reportEdit(this.deleteEntry(String(msg.id)), true);
					break;
			}
		} catch (e) {
			void this.panel.webview.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
		}
	}

	private buildHtml(): string {
		const csp = nonce();
		return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${csp}';" />
<title>${this.entry.label}</title>
<style>
${STYLE}
</style>
</head>
<body>
<div id="toolbar">
  <input id="filter" type="text" placeholder="Поиск..." />
  <span id="count"></span>
  <span class="muted">${this.entry.filePath}</span>
</div>
<div id="gridWrap"><table id="grid"><thead><tr id="headRow"></tr></thead><tbody id="rows"></tbody></table></div>
<div id="addBox"></div>
<div id="toast"></div>
<script nonce="${csp}">
window.__isJson = ${JSON.stringify(this.isJson)};
${CLIENT_SCRIPT}
</script>
</body>
</html>`;
	}
}

const STYLE = `
	body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); padding: 8px 12px; }
	#toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
	#filter { flex: 0 0 260px; padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
	#count { color: var(--vscode-descriptionForeground); font-size: 12px; }
	#gridWrap { max-height: 68vh; overflow: auto; border: 1px solid var(--vscode-panel-border); }
	table { border-collapse: collapse; width: 100%; }
	th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 8px; text-align: left; vertical-align: top; }
	th { position: sticky; top: 0; background: var(--vscode-sideBar-background); z-index: 1; }
	td.key { font-family: var(--vscode-editor-font-family); white-space: nowrap; }
	.valCell { display: flex; gap: 4px; align-items: center; }
	input.val { flex: 1; min-width: 220px; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); font-family: var(--vscode-editor-font-family); padding: 2px 4px; }
	input.val.dirty { border-color: var(--vscode-inputValidation-warningBorder, orange); }
	button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 2px 8px; cursor: pointer; }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.icon { background: transparent; color: var(--vscode-icon-foreground, inherit); padding: 2px 4px; }
	.actions { white-space: nowrap; }
	#addBox { margin-top: 10px; padding: 8px; border: 1px dashed var(--vscode-panel-border); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
	#addBox input[type=text] { padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
	#addBox select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); }
	#toast { position: fixed; bottom: 10px; right: 10px; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); color: var(--vscode-editor-foreground); padding: 6px 10px; display: none; max-width: 50vw; }
	.muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
`;

/** Plain browser JS, no build step — same CSP-friendly convention as
 * `LocalizationWizardPanel`'s own `CLIENT_SCRIPT`. */
const CLIENT_SCRIPT = `
const vscode = acquireVsCodeApi();
let rows = [];
let canRename = true;
let idLabel = 'Имя';

const headRow = document.getElementById('headRow');
const rowsEl = document.getElementById('rows');
const addBox = document.getElementById('addBox');
const filterEl = document.getElementById('filter');
const countEl = document.getElementById('count');
const toastEl = document.getElementById('toast');

let toastTimer;
function showToast(message) {
	toastEl.textContent = message;
	toastEl.style.display = 'block';
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 4000);
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderHead() {
	headRow.innerHTML = '<th>' + escapeHtml(idLabel) + '</th><th>Значение</th><th></th>';
}

function matchesFilter(text) {
	const q = filterEl.value.trim().toLowerCase();
	return !q || text.toLowerCase().includes(q);
}

function renderRows() {
	let html = '';
	let shown = 0;
	for (const row of rows) {
		if (!matchesFilter(row.id)) continue;
		shown++;
		const inputType = row.sensitive ? 'password' : 'text';
		html += '<tr data-id="' + escapeHtml(row.id) + '" data-kind="' + escapeHtml(row.kind || '') + '">';
		html += '<td class="key">' + escapeHtml(row.id) + '</td>';
		html += '<td class="valCell"><input class="val" type="' + inputType + '" value="' + escapeHtml(row.value) + '" />';
		if (row.sensitive) html += '<button class="icon eye" type="button" title="Показать/скрыть">\u{1F441}</button>';
		html += '</td>';
		html += '<td class="actions">';
		if (canRename) html += '<button class="icon" data-act="rename" title="Переименовать">✎</button> ';
		html += '<button class="icon" data-act="delete" title="Удалить">\u{1F5D1}</button></td></tr>';
	}
	rowsEl.innerHTML = html;
	countEl.textContent = shown + ' / ' + rows.length;

	rowsEl.querySelectorAll('input.val').forEach((el) => {
		const initial = el.value;
		el.addEventListener('blur', () => {
			if (el.value === initial) return;
			const tr = el.closest('tr');
			vscode.postMessage({ type: 'setValue', id: tr.dataset.id, value: el.value, kind: tr.dataset.kind || undefined });
		});
	});
	rowsEl.querySelectorAll('button.eye').forEach((btn) => {
		btn.addEventListener('click', () => {
			const input = btn.previousElementSibling;
			input.type = input.type === 'password' ? 'text' : 'password';
		});
	});
	rowsEl.querySelectorAll('button[data-act="rename"]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const tr = btn.closest('tr');
			const oldId = tr.dataset.id;
			const newId = prompt('Новое имя для "' + oldId + '":', oldId);
			if (newId && newId !== oldId) vscode.postMessage({ type: 'renameEntry', oldId, newId });
		});
	});
	rowsEl.querySelectorAll('button[data-act="delete"]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const tr = btn.closest('tr');
			const id = tr.dataset.id;
			if (confirm('Удалить "' + id + '"?')) vscode.postMessage({ type: 'deleteEntry', id });
		});
	});
}

function renderAddBox() {
	let html = '<strong>Добавить:</strong> <input type="text" id="newId" placeholder="' + escapeHtml(idLabel) + '" />';
	html += '<input type="text" id="newVal" placeholder="Значение" style="flex:1;min-width:200px;" />';
	if (window.__isJson) {
		html += '<select id="newKind"><option value="string">string</option><option value="number">number</option>' +
			'<option value="boolean">boolean</option><option value="null">null</option><option value="array">array (JSON)</option></select>';
	}
	html += '<button id="addBtn">Добавить</button>';
	addBox.innerHTML = html;
	document.getElementById('addBtn').addEventListener('click', () => {
		const id = document.getElementById('newId').value.trim();
		if (!id) return;
		const value = document.getElementById('newVal').value;
		const kindEl = document.getElementById('newKind');
		vscode.postMessage({ type: 'addEntry', id, value, kind: kindEl ? kindEl.value : undefined });
	});
}

function render() {
	renderHead();
	renderRows();
	renderAddBox();
}

filterEl.addEventListener('input', renderRows);

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (msg.type === 'init') {
		canRename = msg.canRename;
		idLabel = msg.idLabel;
		rows = msg.rows;
		render();
	} else if (msg.type === 'error') {
		showToast(msg.message);
	}
});
`;
