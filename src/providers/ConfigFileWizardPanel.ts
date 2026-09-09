import * as vscode from "vscode";
import { AppConfigEntry } from "../index/appConfigDiscovery";
import {
	APP_SETTINGS_SPEC,
	CONNECTION_STRINGS_SPEC,
	EditResult,
	addXmlAddEntry,
	deleteXmlAddEntry,
	listXmlAddEntries,
	renameXmlAddEntry,
	setXmlAddEntryValue
} from "../index/dotnetConfigEditor";
import {
	JsonLeafKind,
	addAnonymousRoute,
	addJsonLeaf,
	deleteAnonymousRoute,
	deleteJsonLeaf,
	listAnonymousRoutes,
	listJsonLeaves,
	renameAnonymousRoute,
	setAnonymousRouteRoutes,
	setJsonLeafValue
} from "../index/jsonSettingsEditor";
import {
	addExtension,
	addVariable,
	deleteExtension,
	deleteVariable,
	listExtensions,
	listVariables,
	renameVariable,
	setExtensionType,
	setVariable
} from "../index/nlogConfigEditor";
import { NLOG_LAYOUT_RENDERERS } from "../index/nlogCatalog";
import { DIALOG_CLIENT_SCRIPT, DIALOG_HTML, DIALOG_STYLE } from "./webviewDialogs";

type WizardMode = "connectionStrings" | "appSettings" | "json" | "nlogVariables" | "nlogExtensions";

function modeForKind(kind: AppConfigEntry["kind"]): WizardMode {
	switch (kind) {
		case "appSettingsJson":
			return "json";
		case "xmlAppSettings":
			return "appSettings";
		case "nlogVariables":
			return "nlogVariables";
		case "nlogExtensions":
			return "nlogExtensions";
		default:
			return "connectionStrings";
	}
}

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
	private readonly mode: WizardMode;

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
		this.mode = modeForKind(entry.kind);

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

	/** XML add-block spec for the two `dotnetConfigEditor.ts`-backed modes —
	 * meaningless (never called) for json/nlogVariables/nlogExtensions. */
	private xmlSpec() {
		return this.mode === "appSettings" ? APP_SETTINGS_SPEC : CONNECTION_STRINGS_SPEC;
	}

	private idLabel(): string {
		switch (this.mode) {
			case "json":
				return "Путь";
			case "appSettings":
				return "Ключ";
			case "nlogExtensions":
				return "Assembly";
			default:
				return "Имя";
		}
	}

	private introText(): string {
		switch (this.mode) {
			case "connectionStrings":
				return "Строки подключения (БД, Redis, S3 и т.п.) — «Имя» это то, на что ссылаются из остального конфига (например <code>connectionStringName=\"db\"</code>), «Значение» — сама строка подключения целиком. Показывается скрытым (как пароль), т.к. почти всегда содержит Password= внутри — глазок показывает/скрывает конкретную строку.";
			case "appSettings":
				return "Плоский список настроек приложения «ключ → значение» (флаги, тайм-ауты, лимиты) — то же самое, что вручную искать нужный &lt;add key=... value=.../&gt; внутри большого &lt;appSettings&gt; в .dll.config, только с фильтром.";
			case "json":
				return "Настройки appsettings.json (Kestrel, логирование, DataProtection и т.д.) — «Путь» показан через точку (например <code>Kestrel.Endpoints.Https.Certificate.Password</code>). Массивы редактируются целиком как JSON-текст в поле значения.";
			case "nlogVariables":
				return "Именованные переменные NLog — заданное здесь значение можно переиспользовать где угодно в конфиге как <code>${ИмяПеременной}</code> (в т.ч. внутри значения другой переменной). Часто здесь собирают общий формат строки лога (layout) из более простых функций — см. справочник функций ниже.";
			case "nlogExtensions":
				return "Сборки (.dll), из которых NLog подгружает типы таргетов/layout, которых нет в его ядре (например поддержка Kafka, ElasticSearch, Syslog, Loki) — без нужной записи здесь таргет с таким xsi:type просто не заработает. Добавляется вместе с таргетом, который его требует — отдельно трогать нужно редко.";
		}
	}

	private loadRows(): WireRow[] | undefined {
		switch (this.mode) {
			case "json": {
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
			case "nlogVariables": {
				const vars = listVariables(this.entry.filePath);
				if (!vars) {
					return undefined;
				}
				return vars.map((v) => ({ id: v.name, value: v.value, sensitive: SENSITIVE_KEY_RE.test(v.name) }));
			}
			case "nlogExtensions": {
				const exts = listExtensions(this.entry.filePath);
				if (!exts) {
					return undefined;
				}
				return exts.map((e) => ({ id: e.assembly, value: e.type ?? "", sensitive: false }));
			}
			default: {
				const spec = this.xmlSpec();
				const entries = listXmlAddEntries(this.entry.filePath, spec);
				if (!entries) {
					return undefined;
				}
				const alwaysMask = spec === CONNECTION_STRINGS_SPEC;
				return entries.map((e) => ({
					id: e.name,
					value: e.value,
					sensitive: alwaysMask || SENSITIVE_KEY_RE.test(e.name)
				}));
			}
		}
	}

	private refresh(): void {
		const rows = this.loadRows();
		if (rows === undefined) {
			void this.panel.webview.postMessage({ type: "error", message: "Не удалось прочитать файл" });
			return;
		}
		void this.panel.webview.postMessage({
			type: "init",
			canRename: this.mode !== "json" && this.mode !== "nlogExtensions",
			idLabel: this.idLabel(),
			rows,
			anonymousRoutes: this.mode === "json" ? listAnonymousRoutes(this.entry.filePath) ?? [] : undefined
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

	private setValue(id: string, value: string, kind?: JsonLeafKind): EditResult {
		switch (this.mode) {
			case "json":
				return setJsonLeafValue(this.entry.filePath, id, value, kind ?? "string");
			case "nlogVariables":
				return setVariable(this.entry.filePath, id, value);
			case "nlogExtensions":
				return setExtensionType(this.entry.filePath, id, value);
			default:
				return setXmlAddEntryValue(this.entry.filePath, this.xmlSpec(), id, value);
		}
	}

	private addEntry(id: string, value: string, kind?: JsonLeafKind): EditResult {
		switch (this.mode) {
			case "json":
				return addJsonLeaf(this.entry.filePath, id, value, kind ?? "string");
			case "nlogVariables":
				return addVariable(this.entry.filePath, id, value);
			case "nlogExtensions":
				return addExtension(this.entry.filePath, id, value || undefined);
			default:
				return addXmlAddEntry(this.entry.filePath, this.xmlSpec(), id, value);
		}
	}

	private deleteEntry(id: string): EditResult {
		switch (this.mode) {
			case "json":
				return deleteJsonLeaf(this.entry.filePath, id);
			case "nlogVariables":
				return deleteVariable(this.entry.filePath, id);
			case "nlogExtensions":
				return deleteExtension(this.entry.filePath, id);
			default:
				return deleteXmlAddEntry(this.entry.filePath, this.xmlSpec(), id);
		}
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
					if (this.mode === "json" || this.mode === "nlogExtensions") {
						return;
					}
					if (this.mode === "nlogVariables") {
						this.reportEdit(renameVariable(this.entry.filePath, String(msg.oldId), String(msg.newId)), true);
						return;
					}
					this.reportEdit(renameXmlAddEntry(this.entry.filePath, this.xmlSpec(), String(msg.oldId), String(msg.newId)), true);
					break;
				case "deleteEntry":
					this.reportEdit(this.deleteEntry(String(msg.id)), true);
					break;
				case "setAnonymousRoute":
					this.reportEdit(
						setAnonymousRouteRoutes(this.entry.filePath, String(msg.serviceClassName), msg.routes as string[]),
						true
					);
					break;
				case "addAnonymousRoute":
					this.reportEdit(
						addAnonymousRoute(this.entry.filePath, String(msg.serviceClassName), msg.routes as string[]),
						true
					);
					break;
				case "renameAnonymousRoute":
					this.reportEdit(
						renameAnonymousRoute(this.entry.filePath, String(msg.oldName), String(msg.newName)),
						true
					);
					break;
				case "deleteAnonymousRoute":
					this.reportEdit(deleteAnonymousRoute(this.entry.filePath, String(msg.serviceClassName)), true);
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
${DIALOG_STYLE}
</style>
</head>
<body>
<p class="intro">${this.introText()}</p>
${
	this.mode === "json"
		? `<div id="anonBox">
  <div class="boxHeader">Анонимные веб-сервисы (без авторизации)</div>
  <p class="muted">Сервисы, к которым можно обращаться по HTTP БЕЗ авторизации BPMSoft (<code>ConfigurationServices.AnonymousRoutes</code>) — например вебхуки от внешних систем, которые не могут прислать логин/пароль или токен. «Класс сервиса» — полное имя класса (с namespace), «Маршруты» — один или несколько (через запятую) адресов вида <code>/ServiceModel/ИмяСервиса.svc</code>. ⚠ Любой, кто знает маршрут, может вызвать сервис без входа в систему — добавляйте сюда только то, что действительно должно быть публичным.</p>
  <input id="anonFilter" type="text" placeholder="Поиск по классу/маршруту..." />
  <div id="anonGridWrap"><table id="anonGrid"><thead><tr><th>Класс сервиса</th><th>Маршруты</th><th></th></tr></thead><tbody id="anonRows"></tbody></table></div>
  <div id="anonAddBox"></div>
</div>`
		: ""
}
<div id="toolbar">
  <input id="filter" type="text" placeholder="Поиск..." />
  <span id="count"></span>
  ${this.mode === "nlogVariables" ? '<button id="referenceBtn" class="secondary">ℹ Справочник функций \${...}</button>' : ""}
  <span class="muted">${this.entry.filePath}</span>
</div>
${
	this.mode === "nlogVariables"
		? `<div id="referenceBox" hidden>
  <div class="boxHeader">Справочник функций layout (<code>\${...}</code>)</div>
  <p class="muted">Функции вида <code>\${shortdate}</code>, <code>\${whenEmpty:...}</code>, которые можно подставлять в значение переменной. Список — просто справка для копирования.</p>
  <input id="referenceFilter" type="text" placeholder="Поиск функции (напр. shortdate, whenEmpty, exception...)" />
  <div id="referenceList"></div>
  <div class="actionsRow"><button id="referenceCloseBtn" class="secondary">Закрыть</button></div>
</div>`
		: ""
}
<div id="gridWrap"><table id="grid"><thead><tr id="headRow"></tr></thead><tbody id="rows"></tbody></table></div>
<div id="addBox"></div>
<div id="toast"></div>
${DIALOG_HTML}
<script nonce="${csp}">
window.__isJson = ${JSON.stringify(this.mode === "json")};
window.__LAYOUT_RENDERERS = ${this.mode === "nlogVariables" ? JSON.stringify(NLOG_LAYOUT_RENDERERS) : "[]"};
${DIALOG_CLIENT_SCRIPT}
${CLIENT_SCRIPT}
</script>
</body>
</html>`;
	}
}

const STYLE = `
	/* Must come before any "#foo { display: flex/... }" rule below — an ID
	   selector otherwise outranks the browser's default "[hidden]{display:none}"
	   (attribute selector, lowest specificity) and the box stays visibly open
	   even after its "hidden" property is set to true from script. */
	[hidden] { display: none !important; }
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
	.intro { color: var(--vscode-descriptionForeground); font-size: 12px; max-width: 900px; margin: 0 0 10px; }
	.boxHeader { font-weight: 600; }
	code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); padding: 0 3px; }
	.actionsRow { display: flex; gap: 8px; }
	#referenceBox { margin-bottom: 10px; padding: 10px; border: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; gap: 8px; }
	#referenceFilter { padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
	#referenceList { max-height: 40vh; overflow: auto; border: 1px solid var(--vscode-panel-border); }
	.refItem { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
	.refItem .refDesc { color: var(--vscode-descriptionForeground); font-size: 12px; }
	#anonBox { margin-bottom: 14px; padding: 10px; border: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; gap: 8px; }
	#anonBox .muted { max-width: 900px; }
	#anonFilter { padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
	#anonGridWrap { max-height: 30vh; overflow: auto; border: 1px solid var(--vscode-panel-border); }
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
		btn.addEventListener('click', async () => {
			const tr = btn.closest('tr');
			const oldId = tr.dataset.id;
			const newId = await showPrompt('Новое имя для "' + oldId + '":', oldId);
			if (newId && newId !== oldId) vscode.postMessage({ type: 'renameEntry', oldId, newId });
		});
	});
	rowsEl.querySelectorAll('button[data-act="delete"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const tr = btn.closest('tr');
			const id = tr.dataset.id;
			if (await showConfirm('Удалить "' + id + '"?')) vscode.postMessage({ type: 'deleteEntry', id });
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

// --- Anonymous web services (ConfigurationServices.AnonymousRoutes) ----

let anonRoutes = [];
const anonRowsEl = document.getElementById('anonRows');
if (anonRowsEl) {
	const anonFilterEl = document.getElementById('anonFilter');
	const anonAddBox = document.getElementById('anonAddBox');

	const anonMatchesFilter = (row) => {
		const q = anonFilterEl.value.trim().toLowerCase();
		return !q || row.serviceClassName.toLowerCase().includes(q) || row.routes.join(',').toLowerCase().includes(q);
	};

	function renderAnonRows() {
		let html = '';
		for (const row of anonRoutes) {
			if (!anonMatchesFilter(row)) continue;
			html += '<tr data-name="' + escapeHtml(row.serviceClassName) + '">';
			html += '<td class="key">' + escapeHtml(row.serviceClassName) + '</td>';
			html += '<td class="valCell"><input class="val anonRoutesInput" type="text" value="' + escapeHtml(row.routes.join(', ')) + '" /></td>';
			html += '<td class="actions"><button class="icon" data-act="rename" title="Переименовать">✎</button> ' +
				'<button class="icon" data-act="delete" title="Убрать анонимный доступ">\u{1F5D1}</button></td>';
			html += '</tr>';
		}
		anonRowsEl.innerHTML = html || '<tr><td colspan="3" class="muted">Ничего не найдено</td></tr>';

		anonRowsEl.querySelectorAll('input.anonRoutesInput').forEach((el) => {
			const initial = el.value;
			el.addEventListener('blur', () => {
				if (el.value === initial) return;
				const tr = el.closest('tr');
				const routes = el.value.split(',').map((s) => s.trim()).filter(Boolean);
				vscode.postMessage({ type: 'setAnonymousRoute', serviceClassName: tr.dataset.name, routes });
			});
		});
		anonRowsEl.querySelectorAll('button[data-act="rename"]').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const tr = btn.closest('tr');
				const oldName = tr.dataset.name;
				const newName = await showPrompt('Новое имя класса сервиса для "' + oldName + '":', oldName);
				if (newName && newName !== oldName) vscode.postMessage({ type: 'renameAnonymousRoute', oldName, newName });
			});
		});
		anonRowsEl.querySelectorAll('button[data-act="delete"]').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const tr = btn.closest('tr');
				const serviceClassName = tr.dataset.name;
				if (await showConfirm('Убрать анонимный доступ для "' + serviceClassName + '"?')) {
					vscode.postMessage({ type: 'deleteAnonymousRoute', serviceClassName });
				}
			});
		});
	}

	function renderAnonAddBox() {
		anonAddBox.innerHTML =
			'<strong>Добавить сервис:</strong> <input type="text" id="newAnonName" placeholder="напр. BPMSoft.Configuration.MyService" style="min-width:320px;" />' +
			'<input type="text" id="newAnonRoutes" placeholder="/ServiceModel/MyService.svc" style="flex:1;min-width:200px;" />' +
			'<button id="addAnonBtn">Добавить</button>';
		document.getElementById('addAnonBtn').addEventListener('click', () => {
			const serviceClassName = document.getElementById('newAnonName').value.trim();
			if (!serviceClassName) return;
			const routes = document.getElementById('newAnonRoutes').value.split(',').map((s) => s.trim()).filter(Boolean);
			vscode.postMessage({ type: 'addAnonymousRoute', serviceClassName, routes });
		});
	}

	anonFilterEl.addEventListener('input', renderAnonRows);
	renderAnonAddBox();
	window.__renderAnonRows = renderAnonRows;
}

const referenceBtn = document.getElementById('referenceBtn');
if (referenceBtn) {
	const referenceBox = document.getElementById('referenceBox');
	const referenceFilterEl = document.getElementById('referenceFilter');
	const referenceListEl = document.getElementById('referenceList');
	function renderReferenceList() {
		const q = referenceFilterEl.value.trim().toLowerCase();
		const list = window.__LAYOUT_RENDERERS.filter((r) =>
			!q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q) || r.category.toLowerCase().includes(q)
		);
		referenceListEl.innerHTML = list.slice(0, 300).map((r) => {
			let extra = '';
			if (r.category) extra += ' [' + escapeHtml(r.category) + ']';
			if (r.package) extra += ' (пакет: ' + escapeHtml(r.package) + ')';
			return '<div class="refItem"><code>\${' + escapeHtml(r.name) + '}</code>' + extra +
				'<div class="refDesc">' + escapeHtml(r.description) + '</div></div>';
		}).join('') || '<div class="refItem muted">Ничего не найдено</div>';
	}
	referenceBtn.addEventListener('click', () => {
		referenceBox.hidden = !referenceBox.hidden;
		if (!referenceBox.hidden) { referenceFilterEl.value = ''; renderReferenceList(); }
	});
	document.getElementById('referenceCloseBtn').addEventListener('click', () => {
		referenceBox.hidden = true;
		referenceFilterEl.value = '';
	});
	referenceFilterEl.addEventListener('input', renderReferenceList);
}

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (msg.type === 'init') {
		canRename = msg.canRename;
		idLabel = msg.idLabel;
		rows = msg.rows;
		render();
		if (msg.anonymousRoutes) {
			anonRoutes = msg.anonymousRoutes;
			if (window.__renderAnonRows) window.__renderAnonRows();
		}
	} else if (msg.type === 'error') {
		showToast(msg.message);
	}
});
`;
