import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
	addLocalizedImage,
	addLocalizedStringKey,
	deleteLocalizedImage,
	deleteLocalizedStringKey,
	listLocalizedImages,
	listLocalizedStrings,
	normalizeImageExtension,
	renameLocalizedImage,
	renameLocalizedStringKey,
	setLocalizedImageValue,
	setLocalizedStringValue
} from "../index/localizationEditor";
import { PREFERRED_CULTURE_ORDER, listSchemaCultures } from "../index/localizationLookup";
import { DIALOG_CLIENT_SCRIPT, DIALOG_HTML, DIALOG_STYLE } from "./webviewDialogs";

export type LocalizationWizardMode = "strings" | "images";

function cultureRank(culture: string): number {
	const idx = PREFERRED_CULTURE_ORDER.indexOf(culture);
	return idx < 0 ? PREFERRED_CULTURE_ORDER.length : idx;
}

function sortedCultures(schemaDir: string, schemaName: string): string[] {
	return listSchemaCultures(schemaDir, schemaName)
		.map((c) => c.culture)
		.sort((a, b) => cultureRank(a) - cultureRank(b) || (a < b ? -1 : a > b ? 1 : 0));
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
 * Two "wizards" (`mode: "strings" | "images"`) sharing one webview shell — a
 * filterable table of keys × cultures, an add-row control, per-row
 * rename/delete. Strings edit inline (save-on-blur `<textarea>` per cell);
 * images show a thumbnail per culture with a "Заменить…" button that opens a
 * native file picker on the extension side (a webview has no filesystem
 * access of its own) via `vscode.window.showOpenDialog`.
 *
 * All actual reading/writing goes through `localizationEditor.ts` — this
 * class only renders state and dispatches postMessage traffic to it. See
 * that module's doc for why `metadata.json` is never written here.
 */
export class LocalizationWizardPanel {
	private static readonly panels = new Map<string, LocalizationWizardPanel>();

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	/** `focusKey` — a specific string/image key to scroll to and filter down
	 * to on open, set when invoked from a hover's own "Редактировать" link
	 * (`platformLookup.ts`'s `editLocalizedStringLink`/`editLocalizedImageLink`)
	 * rather than a generic entry point (command palette / toolbar button /
	 * tree context menu), where there's no one specific key in mind. */
	static show(mode: LocalizationWizardMode, schemaDir: string, schemaName: string, focusKey?: string): void {
		const panelKey = `${mode}:${schemaDir}`;
		const existing = LocalizationWizardPanel.panels.get(panelKey);
		if (existing) {
			existing.panel.reveal(vscode.ViewColumn.Active);
			existing.refresh();
			if (focusKey) {
				existing.focusOn(focusKey);
			}
			return;
		}
		new LocalizationWizardPanel(mode, schemaDir, schemaName, panelKey, focusKey);
	}

	private constructor(
		private readonly mode: LocalizationWizardMode,
		private readonly schemaDir: string,
		private readonly schemaName: string,
		private readonly panelKey: string,
		focusKey?: string
	) {
		this.panel = vscode.window.createWebviewPanel(
			"bpmsoftLocalizationWizard",
			mode === "strings" ? `Строки: ${schemaName}` : `Изображения: ${schemaName}`,
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		LocalizationWizardPanel.panels.set(panelKey, this);
		this.panel.onDidDispose(
			() => {
				LocalizationWizardPanel.panels.delete(this.panelKey);
				this.disposables.forEach((d) => d.dispose());
			},
			null,
			this.disposables
		);
		this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), null, this.disposables);
		this.panel.webview.html = this.buildHtml();
		this.refresh();
		if (focusKey) {
			this.focusOn(focusKey);
		}
	}

	/** Posts a "jump to this key" instruction the client script applies
	 * against whatever rows it already has loaded (no data resend needed) —
	 * filters the table down to it and scrolls/highlights the row. Message
	 * ordering guarantees this is processed after the `stringsInit`/
	 * `imagesInit` this constructor just sent via `refresh()`. */
	private focusOn(focusKey: string): void {
		void this.panel.webview.postMessage({ type: "focus", key: focusKey });
	}

	private refresh(): void {
		if (this.mode === "strings") {
			this.panel.webview.postMessage({
				type: "stringsInit",
				cultures: sortedCultures(this.schemaDir, this.schemaName),
				rows: listLocalizedStrings(this.schemaDir, this.schemaName)
			});
		} else {
			this.panel.webview.postMessage({
				type: "imagesInit",
				cultures: sortedCultures(this.schemaDir, this.schemaName),
				rows: listLocalizedImages(this.schemaDir, this.schemaName)
			});
		}
	}

	private async handleMessage(msg: Record<string, unknown>): Promise<void> {
		try {
			switch (msg.type) {
				case "setString":
					this.reportEdit(
						setLocalizedStringValue(
							this.schemaDir,
							this.schemaName,
							String(msg.key),
							String(msg.culture),
							String(msg.value)
						)
					);
					break;
				case "addString": {
					const result = addLocalizedStringKey(
						this.schemaDir,
						this.schemaName,
						String(msg.key),
						(msg.values as Record<string, string>) ?? {}
					);
					this.reportEdit(result, true);
					break;
				}
				case "renameString": {
					const result = renameLocalizedStringKey(
						this.schemaDir,
						this.schemaName,
						String(msg.oldKey),
						String(msg.newKey)
					);
					this.reportEdit(result, true);
					break;
				}
				case "deleteString":
					deleteLocalizedStringKey(this.schemaDir, this.schemaName, String(msg.key));
					this.refresh();
					break;
				case "replaceImage":
					await this.pickAndWriteImage(String(msg.guid), String(msg.culture));
					break;
				case "addImage":
					await this.pickAndAddImage(String(msg.key));
					break;
				case "renameImage": {
					const result = renameLocalizedImage(this.schemaDir, this.schemaName, String(msg.guid), String(msg.newName));
					this.reportEdit(result, true);
					break;
				}
				case "deleteImage":
					deleteLocalizedImage(this.schemaDir, this.schemaName, String(msg.guid));
					this.refresh();
					break;
			}
		} catch (e) {
			void this.panel.webview.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
		}
	}

	/** `refreshOnSuccess`: most edits only touch one already-rendered cell and
	 * don't need a full re-render (the webview updates its own model
	 * optimistically); add/rename change the row set itself, so those do. */
	private reportEdit(result: { ok: boolean; error?: string }, refreshOnSuccess = false): void {
		if (!result.ok) {
			void this.panel.webview.postMessage({ type: "error", message: result.error ?? "Не удалось сохранить" });
			return;
		}
		if (refreshOnSuccess) {
			this.refresh();
		}
	}

	private async pickAndWriteImage(guid: string, culture: string): Promise<void> {
		const file = await this.pickImageFile();
		if (!file) {
			return;
		}
		const result = setLocalizedImageValue(this.schemaDir, this.schemaName, guid, culture, file.buffer, file.extension);
		this.reportEdit(result, true);
	}

	private async pickAndAddImage(key: string): Promise<void> {
		const file = await this.pickImageFile();
		if (!file) {
			return;
		}
		const result = addLocalizedImage(this.schemaDir, this.schemaName, key, file.buffer, file.extension);
		this.reportEdit(result, true);
	}

	private async pickImageFile(): Promise<{ buffer: Buffer; extension: string } | undefined> {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			openLabel: "Выбрать изображение",
			filters: { Изображения: ["svg", "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"] }
		});
		const uri = picked?.[0];
		if (!uri) {
			return undefined;
		}
		const extension = normalizeImageExtension(uri.fsPath);
		if (!extension) {
			void this.panel.webview.postMessage({ type: "error", message: "Неподдерживаемый формат изображения" });
			return undefined;
		}
		return { buffer: fs.readFileSync(uri.fsPath), extension };
	}

	private buildHtml(): string {
		const csp = nonce();
		const title = this.mode === "strings" ? "Локализуемые строки" : "Локализуемые изображения";
		return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${csp}';" />
<title>${title}</title>
<style>
${STYLE}
${DIALOG_STYLE}
</style>
</head>
<body>
<div id="toolbar">
  <input id="filter" type="text" placeholder="Поиск по ключу..." />
  <span id="count"></span>
</div>
<div id="gridWrap"><table id="grid"><thead><tr id="headRow"></tr></thead><tbody id="rows"></tbody></table></div>
<div id="addBox"></div>
<div id="toast"></div>
${DIALOG_HTML}
<script nonce="${csp}">
window.__mode = ${JSON.stringify(this.mode)};
window.__schemaName = ${JSON.stringify(this.schemaName)};
${DIALOG_CLIENT_SCRIPT}
${CLIENT_SCRIPT}
</script>
</body>
</html>`;
	}
}

const STYLE = `
	body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); padding: 8px 12px; }
	#toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
	#filter { flex: 0 0 320px; padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
	#count { color: var(--vscode-descriptionForeground); font-size: 12px; }
	#gridWrap { max-height: 65vh; overflow: auto; border: 1px solid var(--vscode-panel-border); }
	table { border-collapse: collapse; width: 100%; }
	th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 8px; text-align: left; vertical-align: top; }
	th { position: sticky; top: 0; background: var(--vscode-sideBar-background); z-index: 1; }
	td.key { font-family: var(--vscode-editor-font-family); white-space: nowrap; }
	textarea.val { width: 100%; min-width: 180px; box-sizing: border-box; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); font-family: inherit; }
	textarea.val.dirty { border-color: var(--vscode-inputValidation-warningBorder, orange); }
	button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 2px 8px; cursor: pointer; }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	button.icon { background: transparent; color: var(--vscode-icon-foreground, inherit); padding: 2px 4px; }
	.imgCell { text-align: center; min-width: 90px; }
	.imgCell img { max-width: 32px; max-height: 32px; display: block; margin: 0 auto 4px; background: repeating-conic-gradient(#8884 0% 25%, transparent 0% 50%) 50% / 10px 10px; }
	.actions { white-space: nowrap; }
	#rows tr { transition: background 1.8s ease-out; }
	#rows tr.justFocused { background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,220,0,0.3)); transition: none; }
	#addBox { margin-top: 10px; padding: 8px; border: 1px dashed var(--vscode-panel-border); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
	#addBox input[type=text] { padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
	#toast { position: fixed; bottom: 10px; right: 10px; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); color: var(--vscode-editor-foreground); padding: 6px 10px; display: none; max-width: 50vw; }
	.muted { color: var(--vscode-descriptionForeground); }
`;

/** Plain browser JS (runs unmodified inside the webview, no build step) —
 * kept dependency-free per this codebase's webview CSP (no CDN scripts). */
const CLIENT_SCRIPT = `
const vscode = acquireVsCodeApi();
const mode = window.__mode;
let cultures = [];
let rows = [];

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
	let html = '<th>Ключ</th>';
	for (const c of cultures) html += '<th>' + escapeHtml(c) + '</th>';
	html += '<th></th>';
	headRow.innerHTML = html;
}

function matchesFilter(text) {
	const q = filterEl.value.trim().toLowerCase();
	return !q || text.toLowerCase().includes(q);
}

function renderStringsRows() {
	let html = '';
	let shown = 0;
	for (const row of rows) {
		if (!matchesFilter(row.key)) continue;
		shown++;
		html += '<tr data-key="' + escapeHtml(row.key) + '"><td class="key">' + escapeHtml(row.key) + '</td>';
		for (const c of cultures) {
			const value = row.values[c] || '';
			html += '<td><textarea class="val" rows="1" data-key="' + escapeHtml(row.key) + '" data-culture="' + escapeHtml(c) + '">' + escapeHtml(value) + '</textarea></td>';
		}
		html += '<td class="actions"><button class="icon" data-act="rename" title="Переименовать">✎</button> <button class="icon" data-act="delete" title="Удалить">🗑</button></td></tr>';
	}
	rowsEl.innerHTML = html;
	countEl.textContent = shown + ' / ' + rows.length;

	rowsEl.querySelectorAll('textarea.val').forEach((el) => {
		const initial = el.value;
		el.addEventListener('blur', () => {
			if (el.value === initial) return;
			vscode.postMessage({ type: 'setString', key: el.dataset.key, culture: el.dataset.culture, value: el.value });
		});
	});
	rowsEl.querySelectorAll('button[data-act="rename"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const tr = btn.closest('tr');
			const oldKey = tr.dataset.key;
			const newKey = await showPrompt('Новый ключ для "' + oldKey + '":', oldKey);
			if (newKey && newKey !== oldKey) vscode.postMessage({ type: 'renameString', oldKey, newKey });
		});
	});
	rowsEl.querySelectorAll('button[data-act="delete"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const tr = btn.closest('tr');
			const key = tr.dataset.key;
			if (await showConfirm('Удалить ключ "' + key + '" из всех культур?')) vscode.postMessage({ type: 'deleteString', key });
		});
	});
}

function renderStringsAddBox() {
	let html = '<strong>Добавить строку:</strong> <input type="text" id="newKey" placeholder="НовыйКлюч" />';
	for (const c of cultures) {
		html += '<input type="text" class="newVal" data-culture="' + escapeHtml(c) + '" placeholder="' + escapeHtml(c) + '" />';
	}
	html += '<button id="addBtn">Добавить</button>';
	addBox.innerHTML = html;
	document.getElementById('addBtn').addEventListener('click', () => {
		const key = document.getElementById('newKey').value.trim();
		if (!key) return;
		const values = {};
		addBox.querySelectorAll('.newVal').forEach((el) => { if (el.value) values[el.dataset.culture] = el.value; });
		vscode.postMessage({ type: 'addString', key, values });
	});
}

function renderImagesRows() {
	let html = '';
	let shown = 0;
	for (const row of rows) {
		if (!matchesFilter(row.name)) continue;
		shown++;
		html += '<tr data-guid="' + escapeHtml(row.guid) + '"><td class="key">' + escapeHtml(row.name) + '</td>';
		for (const c of cultures) {
			const v = row.values[c];
			html += '<td class="imgCell">';
			html += v ? '<img src="data:' + v.mimeType + ';base64,' + v.base64 + '" />' : '<div class="muted">—</div>';
			html += '<button data-act="replace" data-culture="' + escapeHtml(c) + '">Заменить…</button></td>';
		}
		html += '<td class="actions">';
		if (row.canRename) html += '<button class="icon" data-act="rename" title="Переименовать">✎</button> ';
		html += '<button class="icon" data-act="delete" title="Удалить">🗑</button></td></tr>';
	}
	rowsEl.innerHTML = html;
	countEl.textContent = shown + ' / ' + rows.length;

	rowsEl.querySelectorAll('button[data-act="replace"]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const guid = btn.closest('tr').dataset.guid;
			vscode.postMessage({ type: 'replaceImage', guid, culture: btn.dataset.culture });
		});
	});
	rowsEl.querySelectorAll('button[data-act="rename"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const tr = btn.closest('tr');
			const row = rows.find((r) => r.guid === tr.dataset.guid);
			const newName = await showPrompt('Новое имя для "' + row.name + '":', row.name);
			if (newName && newName !== row.name) vscode.postMessage({ type: 'renameImage', guid: row.guid, newName });
		});
	});
	rowsEl.querySelectorAll('button[data-act="delete"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const tr = btn.closest('tr');
			const row = rows.find((r) => r.guid === tr.dataset.guid);
			if (await showConfirm('Удалить изображение "' + row.name + '" из всех культур?')) vscode.postMessage({ type: 'deleteImage', guid: row.guid });
		});
	});
}

function renderImagesAddBox() {
	addBox.innerHTML = '<strong>Добавить изображение:</strong> <input type="text" id="newKey" placeholder="НовыйКлюч" /> <button id="addBtn">Выбрать файл и добавить…</button>';
	document.getElementById('addBtn').addEventListener('click', () => {
		const key = document.getElementById('newKey').value.trim();
		if (!key) return;
		vscode.postMessage({ type: 'addImage', key });
	});
}

function render() {
	renderHead();
	if (mode === 'strings') { renderStringsRows(); renderStringsAddBox(); }
	else { renderImagesRows(); renderImagesAddBox(); }
}

filterEl.addEventListener('input', () => { if (mode === 'strings') renderStringsRows(); else renderImagesRows(); });

function focusOnKey(key) {
	filterEl.value = key;
	render();
	const selector = mode === 'strings'
		? 'tr[data-key="' + CSS.escape(key) + '"]'
		: (() => {
			const row = rows.find((r) => r.name === key);
			return row ? 'tr[data-guid="' + CSS.escape(row.guid) + '"]' : null;
		})();
	const tr = selector && rowsEl.querySelector(selector);
	if (!tr) return;
	tr.scrollIntoView({ block: 'center' });
	tr.classList.add('justFocused');
	setTimeout(() => tr.classList.remove('justFocused'), 2000);
}

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (msg.type === 'stringsInit' || msg.type === 'imagesInit') {
		cultures = msg.cultures;
		rows = msg.rows;
		render();
	} else if (msg.type === 'focus') {
		focusOnKey(msg.key);
	} else if (msg.type === 'error') {
		showToast(msg.message);
	}
});
`;
