/**
 * `window.alert`/`confirm`/`prompt` do not work inside a VS Code webview — the
 * webview's content runs in an iframe without `allow-modals`, so these calls
 * silently no-op (a bare `confirm(...)` returns `false`/`null` immediately,
 * no dialog ever appears) instead of throwing, which is why every wizard
 * panel's Rename/Delete buttons that relied on them looked simply "broken".
 * This is a tiny DOM-based replacement, shared as plain strings (interpolated
 * into each panel's own `<style>`/body/`<script>`) since these webviews have
 * no bundler and each panel's HTML is a self-contained template literal.
 *
 * Usage in a panel: splice `DIALOG_STYLE` into its `STYLE` string, `DIALOG_HTML`
 * once into its body, and `DIALOG_CLIENT_SCRIPT` before the panel's own
 * `CLIENT_SCRIPT` — then replace `confirm(msg)` with `await showConfirm(msg)`
 * and `prompt(msg, def)` with `await showPrompt(msg, def)` (both return a
 * Promise, so the enclosing click handler needs to be `async`).
 */

export const DIALOG_STYLE = `
	#bpmDialogOverlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
	#bpmDialogOverlay[hidden] { display: none !important; }
	#bpmDialogBox { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); padding: 16px; min-width: 320px; max-width: 80vw; display: flex; flex-direction: column; gap: 10px; }
	#bpmDialogMessage { white-space: pre-wrap; }
	#bpmDialogInput { padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
	#bpmDialogInput[hidden] { display: none !important; }
	#bpmDialogActions { display: flex; justify-content: flex-end; gap: 8px; }
`;

export const DIALOG_HTML = `
<div id="bpmDialogOverlay" hidden>
  <div id="bpmDialogBox">
    <div id="bpmDialogMessage"></div>
    <input id="bpmDialogInput" type="text" />
    <div id="bpmDialogActions">
      <button id="bpmDialogCancel" class="secondary" type="button">Отмена</button>
      <button id="bpmDialogOk" type="button">ОК</button>
    </div>
  </div>
</div>
`;

export const DIALOG_CLIENT_SCRIPT = `
const bpmDialogOverlay = document.getElementById('bpmDialogOverlay');
const bpmDialogMessage = document.getElementById('bpmDialogMessage');
const bpmDialogInput = document.getElementById('bpmDialogInput');
const bpmDialogCancel = document.getElementById('bpmDialogCancel');
const bpmDialogOk = document.getElementById('bpmDialogOk');
let bpmDialogResolve = null;

function bpmCloseDialog(result) {
	bpmDialogOverlay.hidden = true;
	const resolve = bpmDialogResolve;
	bpmDialogResolve = null;
	if (resolve) resolve(result);
}
bpmDialogCancel.addEventListener('click', () => bpmCloseDialog(null));
bpmDialogOk.addEventListener('click', () => bpmCloseDialog(bpmDialogInput.hidden ? true : bpmDialogInput.value));
bpmDialogOverlay.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') { e.preventDefault(); bpmCloseDialog(null); }
	else if (e.key === 'Enter') { e.preventDefault(); bpmCloseDialog(bpmDialogInput.hidden ? true : bpmDialogInput.value); }
});

/** Replacement for window.confirm(message) — resolves true/false. */
function showConfirm(message) {
	return new Promise((resolve) => {
		bpmDialogResolve = resolve;
		bpmDialogMessage.textContent = message;
		bpmDialogInput.hidden = true;
		bpmDialogOverlay.hidden = false;
		bpmDialogOk.focus();
	}).then((v) => v === true);
}

/** Replacement for window.prompt(message, defaultValue) — resolves the
 * entered string, or null if cancelled/closed with Escape. */
function showPrompt(message, defaultValue) {
	return new Promise((resolve) => {
		bpmDialogResolve = resolve;
		bpmDialogMessage.textContent = message;
		bpmDialogInput.hidden = false;
		bpmDialogInput.value = defaultValue || '';
		bpmDialogOverlay.hidden = false;
		bpmDialogInput.focus();
		bpmDialogInput.select();
	});
}
`;
