import * as vscode from "vscode";
import { AppConfigEntry } from "../index/appConfigDiscovery";
import {
	FileTargetRetention,
	NLOG_ARCHIVE_EVERY_VALUES,
	NLOG_ARCHIVE_NUMBERING_VALUES,
	addTarget,
	deleteTarget,
	duplicateTarget,
	getFileTargetRetention,
	listTargets,
	replaceTarget,
	setFileTargetRetention,
	toggleTargetEnabled
} from "../index/nlogConfigEditor";
import { NLOG_TARGET_TYPES } from "../index/nlogCatalog";

function nonce(): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let out = "";
	for (let i = 0; i < 32; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}

/** Starter skeletons for the target types real BPMSoft nlog configs actually
 * reach for most often (per the plan behind this feature) — anything else
 * from the 115-entry catalog still gets a bare `<target name="…"
 * xsi:type="Type" />` to build on, just without a curated starting point.
 * Kept here (not in `nlogCatalog.ts`, which is frozen reference data) since
 * these are this wizard's own editorial choices, not something NLog's docs
 * publish as "the" skeleton. */
const TARGET_SKELETONS: Record<string, (name: string) => string> = {
	File: (name) =>
		`<target name="${name}" xsi:type="File" layout="\${longdate} \${level:uppercase=true} \${logger} \${message}\${onexception:\${newline}\${exception:format=tostring}}" fileName="\${basedir}/Logs/${name}.log" />`,
	Console: (name) => `<target name="${name}" xsi:type="Console" layout="\${longdate} \${level:uppercase=true} \${message}" />`,
	ColoredConsole: (name) => `<target name="${name}" xsi:type="ColoredConsole" layout="\${longdate} \${level:uppercase=true} \${message}" />`,
	Debug: (name) => `<target name="${name}" xsi:type="Debug" layout="\${message}" />`,
	Debugger: (name) => `<target name="${name}" xsi:type="Debugger" layout="\${message}" />`,
	Mail: (name) =>
		`<target name="${name}" xsi:type="Mail" smtpServer="smtp.example.com" smtpPort="587" smtpAuthentication="Basic" smtpUserName="user" smtpPassword="secret" enableSsl="true" from="noreply@example.com" to="admin@example.com" subject="\${level} \${logger}" body="\${message}\${newline}\${exception:format=tostring}" />`,
	Network: (name) => `<target name="${name}" xsi:type="Network" address="tcp://127.0.0.1:4505" layout="\${longdate} \${level:uppercase=true} \${message}" />`,
	EventLog: (name) => `<target name="${name}" xsi:type="EventLog" log="Application" source="BPMSoft" layout="\${message}\${newline}\${exception:format=ToString}" />`,
	Database: (name) =>
		`<target name="${name}" xsi:type="Database" connectionString="Pooling=true; Database=___; Host=localhost; Port=5432; Username=___; Password=___; maxPoolSize=50; Timeout=5; CommandTimeout=400">\n\t\t\t<commandType>Text</commandType>\n\t\t\t<commandText>INSERT INTO "Log" ("Date","Level","Logger","Message") VALUES (@log_date, @log_level, @log_logger, @log_message)</commandText>\n\t\t\t<parameter name="@log_date" layout="\${date:universalTime=true}" dbType="DateTime" />\n\t\t\t<parameter name="@log_level" size="20" layout="\${level}" />\n\t\t\t<parameter name="@log_logger" size="255" layout="\${logger}" />\n\t\t\t<parameter name="@log_message" layout="\${message}" />\n\t\t\t<dbProvider>Npgsql.NpgsqlConnection, Npgsql</dbProvider>\n\t\t</target>`,
	Memory: (name) => `<target name="${name}" xsi:type="Memory" layout="\${message}" />`,
	Null: (name) => `<target name="${name}" xsi:type="Null" />`,
	AsyncWrapper: (name) =>
		`<target name="${name}" xsi:type="AsyncWrapper" queueLimit="200" overflowAction="Grow">\n\t\t\t<target xsi:type="File" fileName="\${basedir}/Logs/${name}.log" layout="\${longdate} \${level:uppercase=true} \${message}" />\n\t\t</target>`,
	BufferingWrapper: (name) =>
		`<target name="${name}" xsi:type="BufferingWrapper" bufferSize="100" flushTimeout="5000">\n\t\t\t<target xsi:type="File" fileName="\${basedir}/Logs/${name}.log" layout="\${longdate} \${level:uppercase=true} \${message}" />\n\t\t</target>`,
	FilteringWrapper: (name) =>
		`<target name="${name}" xsi:type="FilteringWrapper" condition="level >= LogLevel.Info">\n\t\t\t<target xsi:type="Console" layout="\${message}" />\n\t\t</target>`,
	RetryingWrapper: (name) =>
		`<target name="${name}" xsi:type="RetryingWrapper" retryCount="3" retryDelayMilliseconds="1000">\n\t\t\t<target xsi:type="File" fileName="\${basedir}/Logs/${name}.log" layout="\${longdate} \${level:uppercase=true} \${message}" />\n\t\t</target>`,
	FallbackGroup: (name) =>
		`<target name="${name}" xsi:type="FallbackGroup">\n\t\t\t<target xsi:type="File" fileName="\${basedir}/Logs/${name}.log" layout="\${longdate} \${level:uppercase=true} \${message}" />\n\t\t\t<target xsi:type="Console" layout="\${message}" />\n\t\t</target>`,
	SplitGroup: (name) =>
		`<target name="${name}" xsi:type="SplitGroup">\n\t\t\t<target xsi:type="File" fileName="\${basedir}/Logs/${name}-a.log" layout="\${message}" />\n\t\t\t<target xsi:type="File" fileName="\${basedir}/Logs/${name}-b.log" layout="\${message}" />\n\t\t</target>`,
	RoundRobinGroup: (name) =>
		`<target name="${name}" xsi:type="RoundRobinGroup">\n\t\t\t<target xsi:type="File" fileName="\${basedir}/Logs/${name}-a.log" layout="\${message}" />\n\t\t\t<target xsi:type="File" fileName="\${basedir}/Logs/${name}-b.log" layout="\${message}" />\n\t\t</target>`
};

function buildSkeleton(typeName: string, name: string): string {
	const safeName = name.trim() || "NewTarget";
	return (TARGET_SKELETONS[typeName] ?? ((n: string) => `<target name="${n}" xsi:type="${typeName}" />`))(safeName);
}

/**
 * Webview wizard for `<targets>` — see `nlogConfigEditor.ts`'s file-level doc
 * for why each target is edited whole as raw XML rather than through a
 * typed-per-attribute form: NLog has 115+ target types with unrelated
 * attribute sets and arbitrary nested content (wrapped targets, `<layout>`
 * children, `<highlight-row>`, ...). This panel's value-add over opening the
 * file directly is: a filterable overview (name/type/enabled status) of
 * every target including vendor-provided commented-out examples (with an
 * Enable/Disable toggle instead of hand-editing `<!-- -->`), and a described
 * type picker (`nlogCatalog.ts`, frozen from NLog's own docs data) plus a
 * starter skeleton when adding a new one, so the `xsi:type` spelling and
 * starting attributes come from real reference data instead of guesswork.
 */
export class NlogTargetsWizardPanel {
	private static readonly panels = new Map<string, NlogTargetsWizardPanel>();

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	static show(entry: AppConfigEntry): void {
		const existing = NlogTargetsWizardPanel.panels.get(entry.filePath);
		if (existing) {
			existing.panel.reveal(vscode.ViewColumn.Active);
			existing.refresh();
			return;
		}
		new NlogTargetsWizardPanel(entry);
	}

	private constructor(private readonly entry: AppConfigEntry) {
		this.panel = vscode.window.createWebviewPanel(
			"bpmsoftNlogTargetsWizard",
			entry.label,
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		NlogTargetsWizardPanel.panels.set(entry.filePath, this);
		this.panel.onDidDispose(
			() => {
				NlogTargetsWizardPanel.panels.delete(entry.filePath);
				this.disposables.forEach((d) => d.dispose());
			},
			null,
			this.disposables
		);
		this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), null, this.disposables);
		this.panel.webview.html = this.buildHtml();
		this.refresh();
	}

	private refresh(): void {
		const targets = listTargets(this.entry.filePath);
		if (targets === undefined) {
			void this.panel.webview.postMessage({ type: "error", message: "Не удалось прочитать файл" });
			return;
		}
		void this.panel.webview.postMessage({ type: "init", targets });
	}

	private reportEdit(result: { ok: boolean; error?: string }, closeEditorOnSuccess = false): void {
		if (!result.ok) {
			void this.panel.webview.postMessage({ type: "error", message: result.error ?? "Не удалось сохранить" });
			return;
		}
		if (closeEditorOnSuccess) {
			void this.panel.webview.postMessage({ type: "saved" });
		}
		this.refresh();
	}

	private async handleMessage(msg: Record<string, unknown>): Promise<void> {
		try {
			switch (msg.type) {
				case "requestSkeleton":
					void this.panel.webview.postMessage({
						type: "skeleton",
						xml: buildSkeleton(String(msg.targetType), String(msg.name))
					});
					break;
				case "add":
					this.reportEdit(addTarget(this.entry.filePath, String(msg.rawXml)), true);
					break;
				case "replace":
					this.reportEdit(replaceTarget(this.entry.filePath, Number(msg.index), String(msg.rawXml)), true);
					break;
				case "delete":
					this.reportEdit(deleteTarget(this.entry.filePath, Number(msg.index)));
					break;
				case "toggle":
					this.reportEdit(toggleTargetEnabled(this.entry.filePath, Number(msg.index)));
					break;
				case "duplicate":
					this.reportEdit(duplicateTarget(this.entry.filePath, Number(msg.index), String(msg.newName)));
					break;
				case "requestRetention": {
					const result = getFileTargetRetention(this.entry.filePath, Number(msg.index));
					if (!result.ok) {
						void this.panel.webview.postMessage({ type: "error", message: result.error });
						break;
					}
					void this.panel.webview.postMessage({ type: "retention", index: Number(msg.index), settings: result.settings });
					break;
				}
				case "saveRetention":
					this.reportEdit(
						setFileTargetRetention(this.entry.filePath, Number(msg.index), msg.settings as FileTargetRetention),
						true
					);
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
  <input id="filter" type="text" placeholder="Поиск по имени/типу..." />
  <span id="count"></span>
  <button id="addBtn">+ Добавить таргет</button>
  <span class="muted">${this.entry.filePath}</span>
</div>
<div id="gridWrap"><table id="grid"><thead><tr>
  <th>Имя</th><th>Тип</th><th>Статус</th><th></th>
</tr></thead><tbody id="rows"></tbody></table></div>
<div id="editorBox" hidden>
  <div id="editorHeader"></div>
  <div id="typePickerWrap">
    <input id="typeFilter" type="text" placeholder="Фильтр по типу (напр. File, Database, Wrapper...)" />
    <select id="typeSelect" size="8"></select>
    <div id="typeDesc" class="muted"></div>
  </div>
  <label class="muted">Имя таргета: <input id="nameInput" type="text" /></label>
  <button id="insertSkeletonBtn">Вставить шаблон</button>
  <textarea id="xmlBox" rows="14" spellcheck="false"></textarea>
  <div id="secretWarning" class="warning" hidden>⚠ Похоже, здесь есть пароль/секрет открытым текстом — расширение его не маскирует, поле редактируется как есть.</div>
  <div id="editorActions">
    <button id="saveBtn">Сохранить</button>
    <button id="cancelBtn" class="secondary">Отмена</button>
  </div>
</div>
<div id="retentionBox" hidden>
  <div id="retentionHeader"></div>
  <p class="muted">Автоматическая архивация и удаление старых лог-файлов этого таргета (настройки NLog).</p>
  <div class="retentionField">
    <label>Создавать новый архив каждые</label>
    <select id="r-archiveEvery" class="cell"></select>
    <div class="hint">Периодичность, с которой текущий файл переименовывается в архив, а запись продолжается в новый файл. «—» — не архивировать по времени.</div>
  </div>
  <div class="retentionField">
    <label>...и/или когда файл превышает размер (байт)</label>
    <input id="r-archiveAboveSize" class="cell" type="number" min="0" />
    <div class="hint">Пусто — не архивировать по размеру. Можно использовать вместе с периодом выше — сработает то условие, которое наступит раньше.</div>
  </div>
  <hr />
  <div class="retentionField">
    <label>Хранить не больше архивов</label>
    <input id="r-maxArchiveFiles" class="cell" type="number" min="0" />
    <div class="hint">Более старые архивы будут автоматически удаляться. Пусто — не ограничивать по количеству.</div>
  </div>
  <div class="retentionField">
    <label>Хранить архивы не старше, дней</label>
    <input id="r-maxArchiveDays" class="cell" type="number" min="0" />
    <div class="hint">Архивы старше указанного числа дней будут автоматически удаляться. Пусто — не ограничивать по возрасту.</div>
  </div>
  <div class="retentionField">
    <label>Схема именования архивов</label>
    <select id="r-archiveNumbering" class="cell"></select>
    <div class="hint" id="r-archiveNumberingHint"></div>
  </div>
  <div class="retentionField">
    <label><input id="r-archiveOldFileOnStartup" type="checkbox" /> Архивировать уже существующий файл при запуске приложения</label>
  </div>
  <div id="retentionWarnings"></div>
  <div id="editorActions">
    <button id="retentionSaveBtn">Сохранить</button>
    <button id="retentionCancelBtn" class="secondary">Отмена</button>
  </div>
</div>
<div id="toast"></div>
<script nonce="${csp}">
window.__CATALOG = ${JSON.stringify(NLOG_TARGET_TYPES)};
window.__ARCHIVE_EVERY_VALUES = ${JSON.stringify(NLOG_ARCHIVE_EVERY_VALUES)};
window.__ARCHIVE_NUMBERING_VALUES = ${JSON.stringify(NLOG_ARCHIVE_NUMBERING_VALUES)};
${CLIENT_SCRIPT}
</script>
</body>
</html>`;
	}
}

const STYLE = `
	body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); padding: 8px 12px; }
	#toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
	#filter { flex: 0 0 260px; padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
	#count { color: var(--vscode-descriptionForeground); font-size: 12px; }
	#gridWrap { max-height: 55vh; overflow: auto; border: 1px solid var(--vscode-panel-border); }
	table { border-collapse: collapse; width: 100%; }
	th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 8px; text-align: left; vertical-align: middle; }
	th { position: sticky; top: 0; background: var(--vscode-sideBar-background); z-index: 1; }
	td.name { font-family: var(--vscode-editor-font-family); }
	.status-enabled { color: var(--vscode-charts-green, #4caf50); }
	.status-disabled { color: var(--vscode-descriptionForeground); font-style: italic; }
	button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 10px; cursor: pointer; }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	button.icon { background: transparent; color: var(--vscode-icon-foreground, inherit); padding: 2px 4px; }
	.actions { white-space: nowrap; }
	.muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
	#editorBox { margin-top: 12px; padding: 10px; border: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; gap: 8px; }
	#editorHeader { font-weight: 600; }
	#typePickerWrap { display: flex; flex-direction: column; gap: 4px; }
	#typeFilter { padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
	#typeSelect { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); }
	#nameInput { padding: 2px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
	#xmlBox { width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); resize: vertical; }
	.warning { color: var(--vscode-inputValidation-warningForeground, #b98600); background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder, orange); padding: 4px 8px; margin-bottom: 4px; }
	#editorActions { display: flex; gap: 8px; }
	#retentionBox { margin-top: 12px; padding: 10px; border: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; gap: 6px; max-width: 560px; }
	#retentionHeader { font-weight: 600; }
	.retentionField { display: flex; flex-direction: column; gap: 2px; margin-bottom: 4px; }
	.retentionField label { font-weight: 500; }
	.retentionField .cell { width: 100%; box-sizing: border-box; }
	.retentionField .hint { color: var(--vscode-descriptionForeground); font-size: 12px; }
	#retentionBox hr { border: none; border-top: 1px solid var(--vscode-panel-border); width: 100%; margin: 4px 0; }
	#toast { position: fixed; bottom: 10px; right: 10px; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); color: var(--vscode-editor-foreground); padding: 6px 10px; display: none; max-width: 50vw; }
`;

const CLIENT_SCRIPT = `
const vscode = acquireVsCodeApi();
let targets = [];
let editorState = null; // { mode: 'add'|'edit', index?: number }

const rowsEl = document.getElementById('rows');
const filterEl = document.getElementById('filter');
const countEl = document.getElementById('count');
const toastEl = document.getElementById('toast');
const editorBox = document.getElementById('editorBox');
const editorHeader = document.getElementById('editorHeader');
const typePickerWrap = document.getElementById('typePickerWrap');
const typeFilterEl = document.getElementById('typeFilter');
const typeSelectEl = document.getElementById('typeSelect');
const typeDescEl = document.getElementById('typeDesc');
const nameInputEl = document.getElementById('nameInput');
const insertSkeletonBtn = document.getElementById('insertSkeletonBtn');
const xmlBox = document.getElementById('xmlBox');
const secretWarning = document.getElementById('secretWarning');
const retentionBox = document.getElementById('retentionBox');
const retentionHeader = document.getElementById('retentionHeader');
const retentionWarnings = document.getElementById('retentionWarnings');
let retentionIndex = null;

const RETENTION_LABELS = {
	'': '— (не архивировать по времени)', Year: 'Год', Month: 'Месяц', Day: 'День', Hour: 'Час', Minute: 'Минуту',
	Sunday: 'Воскресенье', Monday: 'Понедельник', Tuesday: 'Вторник', Wednesday: 'Среда', Thursday: 'Четверг', Friday: 'Пятница', Saturday: 'Суббота'
};
const NUMBERING_LABELS = { '': '— (по умолчанию — Sequence)', Sequence: 'Sequence', Rolling: 'Rolling', Date: 'Date', DateAndSequence: 'DateAndSequence' };
const NUMBERING_HINTS = {
	'': 'Самая частая архивная копия получает наибольший номер (поведение по умолчанию — как у Sequence).',
	Sequence: 'Самая новая архивная копия получает наибольший номер (Log.1, Log.2, ...).',
	Rolling: 'Самая новая копия всегда #0, остальные сдвигаются (#0, #1, ..., #N). ⚠ При этой схеме ограничение «не старше N дней» не работает — используйте только ограничение по количеству файлов.',
	Date: 'Архив именуется датой предыдущего периода.',
	DateAndSequence: 'Архив именуется датой и номером по порядку внутри неё.'
};

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

function matchesFilter(t) {
	const q = filterEl.value.trim().toLowerCase();
	return !q || (t.name || '').toLowerCase().includes(q) || (t.xsiType || '').toLowerCase().includes(q);
}

function renderTable() {
	let html = '';
	let shown = 0;
	targets.forEach((t, index) => {
		if (!matchesFilter(t)) return;
		shown++;
		html += '<tr data-index="' + index + '">';
		html += '<td class="name">' + escapeHtml(t.name || '(без имени)') + '</td>';
		html += '<td>' + escapeHtml(t.xsiType || t.tag) + '</td>';
		html += '<td class="' + (t.enabled ? 'status-enabled' : 'status-disabled') + '">' + (t.enabled ? 'Включен' : 'Закомментирован') + '</td>';
		html += '<td class="actions">' +
			(t.xsiType === 'File' && t.enabled ? '<button class="icon" data-act="retention" title="Хранение логов (автоочистка старых файлов)">\u{1F5C4}</button> ' : '') +
			'<button class="icon" data-act="edit" title="Редактировать XML">✎</button> ' +
			'<button class="icon" data-act="duplicate" title="Дублировать">⧉</button> ' +
			'<button class="icon" data-act="toggle" title="' + (t.enabled ? 'Закомментировать' : 'Включить') + '">' + (t.enabled ? '⏸' : '▶') + '</button> ' +
			'<button class="icon" data-act="delete" title="Удалить">\u{1F5D1}</button></td>';
		html += '</tr>';
	});
	rowsEl.innerHTML = html;
	countEl.textContent = shown + ' / ' + targets.length;

	rowsEl.querySelectorAll('tr').forEach((tr) => {
		const index = Number(tr.dataset.index);
		tr.querySelector('button[data-act="edit"]').addEventListener('click', () => openEditEditor(index));
		tr.querySelector('button[data-act="duplicate"]').addEventListener('click', () => {
			const newName = prompt('Имя для копии таргета "' + targets[index].name + '":', targets[index].name + 'Copy');
			if (newName) vscode.postMessage({ type: 'duplicate', index, newName });
		});
		tr.querySelector('button[data-act="toggle"]').addEventListener('click', () => vscode.postMessage({ type: 'toggle', index }));
		tr.querySelector('button[data-act="delete"]').addEventListener('click', () => {
			if (confirm('Удалить таргет "' + (targets[index].name || '') + '"?')) vscode.postMessage({ type: 'delete', index });
		});
		const retentionBtn = tr.querySelector('button[data-act="retention"]');
		if (retentionBtn) retentionBtn.addEventListener('click', () => vscode.postMessage({ type: 'requestRetention', index }));
	});
}

function renderTypeOptions(filterText) {
	const q = (filterText || '').trim().toLowerCase();
	const list = window.__CATALOG.filter((c) =>
		!q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || c.category.toLowerCase().includes(q)
	);
	typeSelectEl.innerHTML = list.map((c) => '<option value="' + escapeHtml(c.name) + '">' + escapeHtml(c.name) + (c.wrapper ? ' (wrapper)' : '') + '</option>').join('');
	updateTypeDesc();
}

function updateTypeDesc() {
	const name = typeSelectEl.value;
	const entry = window.__CATALOG.find((c) => c.name === name);
	if (!entry) { typeDescEl.textContent = ''; return; }
	let text = entry.description;
	if (entry.category) text += '  [' + entry.category + ']';
	if (entry.package) text += '  (пакет: ' + entry.package + ')';
	if (entry.platformNotes) text += '  — ' + entry.platformNotes;
	typeDescEl.textContent = text;
}

function checkSecretWarning() {
	secretWarning.hidden = !/password|pwd|secret/i.test(xmlBox.value);
}

function openAddEditor() {
	editorState = { mode: 'add' };
	editorHeader.textContent = 'Новый таргет';
	typePickerWrap.hidden = false;
	nameInputEl.value = 'NewTarget';
	xmlBox.value = '';
	renderTypeOptions('');
	editorBox.hidden = false;
	checkSecretWarning();
}

function openEditEditor(index) {
	editorState = { mode: 'edit', index };
	const t = targets[index];
	editorHeader.textContent = 'Редактирование: ' + (t.name || t.tag);
	typePickerWrap.hidden = true;
	xmlBox.value = t.raw;
	editorBox.hidden = false;
	checkSecretWarning();
}

function closeEditor() {
	editorState = null;
	editorBox.hidden = true;
}

function fillSelect(selectEl, values, labels) {
	selectEl.innerHTML = values.map((v) => '<option value="' + escapeHtml(v) + '">' + escapeHtml(labels[v] || v) + '</option>').join('');
}

function openRetention(index, settings) {
	retentionIndex = index;
	retentionHeader.textContent = 'Хранение логов: ' + (targets[index].name || '');
	fillSelect(document.getElementById('r-archiveEvery'), window.__ARCHIVE_EVERY_VALUES, RETENTION_LABELS);
	fillSelect(document.getElementById('r-archiveNumbering'), window.__ARCHIVE_NUMBERING_VALUES, NUMBERING_LABELS);
	document.getElementById('r-archiveEvery').value = settings.archiveEvery;
	document.getElementById('r-archiveAboveSize').value = settings.archiveAboveSize;
	document.getElementById('r-maxArchiveFiles').value = settings.maxArchiveFiles;
	document.getElementById('r-maxArchiveDays').value = settings.maxArchiveDays;
	document.getElementById('r-archiveNumbering').value = settings.archiveNumbering;
	document.getElementById('r-archiveOldFileOnStartup').checked = settings.archiveOldFileOnStartup;
	renderRetentionWarnings();
	retentionBox.hidden = false;
}

function currentRetentionSettings() {
	return {
		archiveEvery: document.getElementById('r-archiveEvery').value,
		archiveAboveSize: document.getElementById('r-archiveAboveSize').value,
		maxArchiveFiles: document.getElementById('r-maxArchiveFiles').value,
		maxArchiveDays: document.getElementById('r-maxArchiveDays').value,
		archiveNumbering: document.getElementById('r-archiveNumbering').value,
		archiveOldFileOnStartup: document.getElementById('r-archiveOldFileOnStartup').checked
	};
}

function renderRetentionWarnings() {
	const s = currentRetentionSettings();
	const warnings = [];
	if ((s.maxArchiveFiles || s.maxArchiveDays) && !s.archiveEvery && !s.archiveAboveSize) {
		warnings.push('Без периода архивации или размера выше очистка старых файлов работать НЕ будет — NLog удаляет старые архивы только в момент создания нового.');
	}
	if (s.maxArchiveDays && s.archiveNumbering === 'Rolling') {
		warnings.push('При схеме именования «Rolling» ограничение по возрасту (в днях) не поддерживается NLog — используйте ограничение по количеству файлов.');
	}
	document.getElementById('r-archiveNumberingHint').textContent = NUMBERING_HINTS[s.archiveNumbering] || '';
	retentionWarnings.innerHTML = warnings.map((w) => '<div class="warning">⚠ ' + escapeHtml(w) + '</div>').join('');
}

function closeRetention() {
	retentionIndex = null;
	retentionBox.hidden = true;
}

['r-archiveEvery', 'r-archiveAboveSize', 'r-maxArchiveFiles', 'r-maxArchiveDays', 'r-archiveNumbering', 'r-archiveOldFileOnStartup'].forEach((id) => {
	document.getElementById(id).addEventListener('input', renderRetentionWarnings);
	document.getElementById(id).addEventListener('change', renderRetentionWarnings);
});
document.getElementById('retentionCancelBtn').addEventListener('click', closeRetention);
document.getElementById('retentionSaveBtn').addEventListener('click', () => {
	vscode.postMessage({ type: 'saveRetention', index: retentionIndex, settings: currentRetentionSettings() });
});

document.getElementById('addBtn').addEventListener('click', openAddEditor);
document.getElementById('cancelBtn').addEventListener('click', closeEditor);
typeFilterEl.addEventListener('input', () => renderTypeOptions(typeFilterEl.value));
typeSelectEl.addEventListener('change', updateTypeDesc);
xmlBox.addEventListener('input', checkSecretWarning);

insertSkeletonBtn.addEventListener('click', () => {
	const targetType = typeSelectEl.value;
	if (!targetType) { showToast('Выберите тип таргета'); return; }
	vscode.postMessage({ type: 'requestSkeleton', targetType, name: nameInputEl.value });
});

document.getElementById('saveBtn').addEventListener('click', () => {
	const rawXml = xmlBox.value.trim();
	if (!rawXml) { showToast('XML пуст'); return; }
	if (editorState.mode === 'add') {
		vscode.postMessage({ type: 'add', rawXml });
	} else {
		vscode.postMessage({ type: 'replace', index: editorState.index, rawXml });
	}
});

filterEl.addEventListener('input', renderTable);

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (msg.type === 'init') {
		targets = msg.targets;
		renderTable();
	} else if (msg.type === 'skeleton') {
		xmlBox.value = msg.xml;
		checkSecretWarning();
	} else if (msg.type === 'retention') {
		openRetention(msg.index, msg.settings);
	} else if (msg.type === 'saved') {
		closeEditor();
		closeRetention();
	} else if (msg.type === 'error') {
		showToast(msg.message);
	}
});
`;
