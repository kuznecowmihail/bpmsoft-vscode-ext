import * as vscode from "vscode";
import { AppConfigEntry } from "../index/appConfigDiscovery";
import { NlogRule, addRule, deleteRule, listRules, moveRule, updateRule } from "../index/nlogConfigEditor";

const LEVELS = ["", "Trace", "Debug", "Info", "Warn", "Error", "Fatal", "Off"];

function nonce(): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let out = "";
	for (let i = 0; i < 32; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}

/**
 * Webview wizard for `<rules>` — an ordered table of `<logger>` rows (the
 * full NLog 5.x attribute set: name/level/levels/minlevel/maxlevel/writeTo/
 * final/enabled/ruleName/finalMinLevel, per `nlogConfigEditor.ts`'s own doc).
 * Order is semantically load-bearing (top-to-bottom precedence, `final`/
 * `finalMinLevel` short-circuit further rules) — hence the ▲/▼ move buttons,
 * the one thing this panel has that `ConfigFileWizardPanel`'s generic table
 * doesn't need.
 */
export class NlogRulesWizardPanel {
	private static readonly panels = new Map<string, NlogRulesWizardPanel>();

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	static show(entry: AppConfigEntry): void {
		const existing = NlogRulesWizardPanel.panels.get(entry.filePath);
		if (existing) {
			existing.panel.reveal(vscode.ViewColumn.Active);
			existing.refresh();
			return;
		}
		new NlogRulesWizardPanel(entry);
	}

	private constructor(private readonly entry: AppConfigEntry) {
		this.panel = vscode.window.createWebviewPanel(
			"bpmsoftNlogRulesWizard",
			entry.label,
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		NlogRulesWizardPanel.panels.set(entry.filePath, this);
		this.panel.onDidDispose(
			() => {
				NlogRulesWizardPanel.panels.delete(entry.filePath);
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
		const rules = listRules(this.entry.filePath);
		if (rules === undefined) {
			void this.panel.webview.postMessage({ type: "error", message: "Не удалось прочитать файл" });
			return;
		}
		void this.panel.webview.postMessage({ type: "init", rules });
	}

	private reportEdit(result: { ok: boolean; error?: string }, refreshOnSuccess = true): void {
		if (!result.ok) {
			void this.panel.webview.postMessage({ type: "error", message: result.error ?? "Не удалось сохранить" });
			return;
		}
		if (refreshOnSuccess) {
			this.refresh();
		}
	}

	private async handleMessage(msg: Record<string, unknown>): Promise<void> {
		try {
			switch (msg.type) {
				case "update":
					this.reportEdit(updateRule(this.entry.filePath, Number(msg.index), msg.rule as NlogRule));
					break;
				case "add":
					this.reportEdit(addRule(this.entry.filePath, { name: "NewLogger" }));
					break;
				case "delete":
					this.reportEdit(deleteRule(this.entry.filePath, Number(msg.index)));
					break;
				case "move":
					this.reportEdit(moveRule(this.entry.filePath, Number(msg.index), msg.direction as "up" | "down"));
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
<p class="intro">Правила связывают источник логов (по имени логгера, часто с <code>*</code> в конце) с таргетами, в которые он пишется. Проверяются <b>сверху вниз</b>, и <code>final</code> останавливает дальнейшую проверку — поэтому порядок важен (стрелки ▲▼ ниже). <code>minlevel</code>/<code>maxlevel</code> — диапазон уровней (Trace &lt; Debug &lt; Info &lt; Warn &lt; Error &lt; Fatal), <code>level</code> — ровно один уровень, <code>levels</code> — список через запятую. <code>writeTo</code> — имя одного или нескольких (через запятую) таргетов из вкладки Targets. <code>enabled</code> (галочка) — выключить правило, не удаляя его.</p>
<div id="toolbar">
  <input id="filter" type="text" placeholder="Поиск по имени логгера..." />
  <span id="count"></span>
  <button id="addBtn">+ Добавить правило</button>
  <span class="muted">${this.entry.filePath}</span>
</div>
<div id="gridWrap"><table id="grid"><thead><tr>
  <th></th>
  <th title="Имя логгера, к которому применяется правило. Часто с * в конце (напр. BPMSoft.Core.*) — совпадение по префиксу.">Logger name</th>
  <th title="Применить правило только для этого ОДНОГО уровня (Trace/Debug/Info/Warn/Error/Fatal). Обычно не используется вместе с minlevel/maxlevel.">level</th>
  <th title="Применить правило для списка уровней через запятую (напр. Warn,Error). Альтернатива minlevel/maxlevel.">levels</th>
  <th title="Минимальный уровень, начиная с которого правило срабатывает (включительно).">minlevel</th>
  <th title="Максимальный уровень, до которого правило срабатывает (включительно).">maxlevel</th>
  <th title="Куда писать — имя таргета с вкладки Targets. Несколько — через запятую.">writeTo</th>
  <th title="Если включено — после этого правила остальные для того же логгера/уровня уже не проверяются.">final</th>
  <th title="Выключить правило, не удаляя его (по умолчанию включено).">enabled</th>
  <th title="Имя правила для программного управления (NLog API) — необязательно, редко используется.">ruleName</th>
  <th title="NLog 5.0+: последующие правила применяются только начиная с этого уровня — редко используется.">finalMinLevel</th>
  <th></th>
</tr></thead><tbody id="rows"></tbody></table></div>
<div id="toast"></div>
<script nonce="${csp}">
window.__LEVELS = ${JSON.stringify(LEVELS)};
${CLIENT_SCRIPT}
</script>
</body>
</html>`;
	}
}

const STYLE = `
	body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); padding: 8px 12px; }
	#toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
	#filter { flex: 0 0 220px; padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
	#count { color: var(--vscode-descriptionForeground); font-size: 12px; }
	#gridWrap { max-height: 72vh; overflow: auto; border: 1px solid var(--vscode-panel-border); }
	table { border-collapse: collapse; width: max-content; min-width: 100%; }
	th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 3px 6px; text-align: left; vertical-align: middle; white-space: nowrap; }
	th { position: sticky; top: 0; background: var(--vscode-sideBar-background); z-index: 1; }
	input.cell, select.cell { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); font-family: var(--vscode-editor-font-family); padding: 2px 4px; }
	input.name { width: 220px; } input.writeTo { width: 160px; } input.narrow { width: 90px; } select.level { width: 80px; }
	button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 2px 8px; cursor: pointer; }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.icon { background: transparent; color: var(--vscode-icon-foreground, inherit); padding: 2px 4px; }
	#toast { position: fixed; bottom: 10px; right: 10px; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); color: var(--vscode-editor-foreground); padding: 6px 10px; display: none; max-width: 50vw; }
	.muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
	.intro { color: var(--vscode-descriptionForeground); font-size: 12px; max-width: 900px; margin: 0 0 10px; }
	code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); padding: 0 3px; }
	th[title] { cursor: help; border-bottom: 1px dotted var(--vscode-descriptionForeground); }
`;

const CLIENT_SCRIPT = `
const vscode = acquireVsCodeApi();
let rules = [];

const rowsEl = document.getElementById('rows');
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

function levelOptions(selected) {
	return window.__LEVELS.map((l) => '<option value="' + l + '"' + (l === (selected || '') ? ' selected' : '') + '>' + (l || '—') + '</option>').join('');
}

function matchesFilter(name) {
	const q = filterEl.value.trim().toLowerCase();
	return !q || name.toLowerCase().includes(q);
}

function currentRuleFromRow(tr) {
	const get = (cls) => tr.querySelector('.' + cls).value;
	const rule = { name: get('f-name') };
	for (const key of ['level', 'levels', 'minlevel', 'maxlevel', 'writeTo', 'ruleName', 'finalMinLevel']) {
		const v = get('f-' + key);
		if (v) rule[key] = v;
	}
	if (tr.querySelector('.f-final').checked) rule.final = true;
	if (!tr.querySelector('.f-enabled').checked) rule.enabled = false;
	return rule;
}

function render() {
	let html = '';
	let shown = 0;
	rules.forEach((rule, index) => {
		if (!matchesFilter(rule.name)) return;
		shown++;
		html += '<tr data-index="' + index + '">';
		html += '<td class="actions">' +
			'<button class="icon" data-act="up" title="Выше">▲</button>' +
			'<button class="icon" data-act="down" title="Ниже">▼</button></td>';
		html += '<td><input class="cell name f-name" value="' + escapeHtml(rule.name) + '" /></td>';
		html += '<td><select class="cell level f-level">' + levelOptions(rule.level) + '</select></td>';
		html += '<td><input class="cell narrow f-levels" value="' + escapeHtml(rule.levels || '') + '" placeholder="Info,Warn" /></td>';
		html += '<td><select class="cell level f-minlevel">' + levelOptions(rule.minlevel) + '</select></td>';
		html += '<td><select class="cell level f-maxlevel">' + levelOptions(rule.maxlevel) + '</select></td>';
		html += '<td><input class="cell writeTo f-writeTo" value="' + escapeHtml(rule.writeTo || '') + '" /></td>';
		html += '<td style="text-align:center"><input type="checkbox" class="f-final" ' + (rule.final ? 'checked' : '') + ' /></td>';
		html += '<td style="text-align:center"><input type="checkbox" class="f-enabled" ' + (rule.enabled === false ? '' : 'checked') + ' /></td>';
		html += '<td><input class="cell narrow f-ruleName" value="' + escapeHtml(rule.ruleName || '') + '" /></td>';
		html += '<td><select class="cell level f-finalMinLevel">' + levelOptions(rule.finalMinLevel) + '</select></td>';
		html += '<td class="actions"><button class="icon" data-act="delete" title="Удалить">\u{1F5D1}</button></td>';
		html += '</tr>';
	});
	rowsEl.innerHTML = html;
	countEl.textContent = shown + ' / ' + rules.length;

	rowsEl.querySelectorAll('tr').forEach((tr) => {
		const index = Number(tr.dataset.index);
		const commit = () => vscode.postMessage({ type: 'update', index, rule: currentRuleFromRow(tr) });
		tr.querySelectorAll('input.cell').forEach((el) => el.addEventListener('blur', commit));
		tr.querySelectorAll('select.cell, input[type=checkbox]').forEach((el) => el.addEventListener('change', commit));
		tr.querySelector('button[data-act="up"]').addEventListener('click', () => vscode.postMessage({ type: 'move', index, direction: 'up' }));
		tr.querySelector('button[data-act="down"]').addEventListener('click', () => vscode.postMessage({ type: 'move', index, direction: 'down' }));
		tr.querySelector('button[data-act="delete"]').addEventListener('click', () => {
			if (confirm('Удалить правило "' + rules[index].name + '"?')) vscode.postMessage({ type: 'delete', index });
		});
	});
}

filterEl.addEventListener('input', render);
document.getElementById('addBtn').addEventListener('click', () => vscode.postMessage({ type: 'add' }));

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (msg.type === 'init') {
		rules = msg.rules;
		render();
	} else if (msg.type === 'error') {
		showToast(msg.message);
	}
});
`;
