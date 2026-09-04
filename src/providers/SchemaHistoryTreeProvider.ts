import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "child_process";
import {
	resolvePackageItem,
	collectSchemaFiles,
	collectPackageItemFiles,
	PackageItemRef
} from "../index/schemaResourceLookup";
import { LocalHistoryStore, LocalHistoryEntry } from "../index/localHistory";

export interface HistoryEntry {
	hash: string;
	/** `--date=relative`, e.g. "2 months ago" — matches stock Timeline's row
	 * description. */
	date: string;
	/** `%aI`, strict ISO — independent of `--date=`, used only to render the
	 * "(June 8, 2026 at 6:14 PM)" absolute-time parenthetical in the hover. */
	isoDate: string;
	author: string;
	/** `%ae` — turns the author name into a `mailto:` link in the hover,
	 * same as stock Timeline. */
	authorEmail: string;
	/** First line of the full message — the row's own label needs a single
	 * line, unlike the hover tooltip which shows the whole thing. */
	subject: string;
	/** Full commit message (%B, subject + body) — only the hover tooltip
	 * uses this. */
	message: string;
	/** Kept as raw numbers (not a pre-joined string) so the hover can color
	 * insertions/deletions independently, matching stock's green/red. */
	filesChanged: number;
	insertions: number;
	deletions: number;
	files: string[];
}

export type HistoryNode =
	| { kind: "commit"; entry: HistoryEntry }
	| { kind: "local"; entry: LocalHistoryEntry }
	| { kind: "empty"; message: string };

export interface SourceFilter {
	git: boolean;
	local: boolean;
}

// ASCII Record Separator (0x1E) — an unambiguous delimiter between commits
// in the git log output (unlike e.g. "\n---\n", it can never collide with a
// commit message's own content). Written as \x1e, not a raw control
// character, since a literal 0x1E byte renders invisibly in most tools/diffs
// and has been mistaken for an empty string before.
/** Distinguishes the two entry sources at a glance — matches the
 * git/local toggle in the view's own filter submenu. */
const GIT_COMMIT_COLOR = new vscode.ThemeColor("charts.blue");
const LOCAL_HISTORY_COLOR = new vscode.ThemeColor("charts.orange");

const RECORD_SEP = "\x1e";
// Unit Separator (0x1F) between header fields, and Group Separator (0x1D)
// marking where the header ends and the --numstat file block begins — plain
// "|"/newline delimiters can't be used once the message field (%B) is
// allowed to contain arbitrary newlines and, in principle, "|".
const FIELD_SEP = "\x1f";
const HEADER_END = "\x1d";
const MAX_DIFF_TABS = 30;

export const OPEN_HISTORY_DIFF_COMMAND = "bpmsoft.schemaHistory.openDiff";
export const OPEN_HISTORY_COMMIT_COMMAND = "bpmsoft.schemaHistory.openCommit";
export const OPEN_LOCAL_HISTORY_DIFF_COMMAND = "bpmsoft.schemaHistory.openLocalHistoryDiff";
/** Same underlying action as `OPEN_HISTORY_COMMIT_COMMAND` (the inline
 * button), but registered separately and bound directly to `openHistoryCommit`
 * — the inline button's command is invoked by VS Code with a `HistoryNode`
 * tree element, while the tooltip's command link instead passes `[gitRoot,
 * entry]` itself (see `buildTooltip`), so they need different handlers even
 * though both ultimately do the same thing. */
export const OPEN_HISTORY_COMMIT_FROM_TOOLTIP_COMMAND = "bpmsoft.schemaHistory.openCommitFromTooltip";
export const COPY_HASH_COMMAND = "bpmsoft.schemaHistory.copyHash";

/** A file that was *added* by the commit being diffed has no "before"
 * version — `<hash>^:relFile` fails to resolve (either there's no parent
 * commit at all, or the file just didn't exist there yet), which without
 * this shows up as VS Code's "file was not found" editor error instead of
 * the all-green "file added" diff stock Timeline shows. This scheme's
 * content provider always resolves to an empty document, so pointing the
 * diff's left side at it reproduces that same all-green result. */
export const EMPTY_CONTENT_SCHEME = "bpmsoft-empty";

export class EmptyContentProvider implements vscode.TextDocumentContentProvider {
	provideTextDocumentContent(): string {
		return "";
	}
}

/**
 * "Timeline", but for every file that makes up the active package item — not
 * just Schemas (a package's content isn't only schemas, see
 * `resolvePackageItem`) and not just the single active file, which is all the
 * standard Timeline view shows (and which we can't relocate into our
 * container anyway, see plan).
 */
export class SchemaHistoryTreeProvider implements vscode.TreeDataProvider<HistoryNode> {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;
	private gitEntries: HistoryEntry[] = [];
	private localEntries: LocalHistoryEntry[] = [];
	private sourceFilter: SourceFilter = { git: true, local: true };
	private emptyMessage = "Откройте файл схемы пакета";
	private generation = 0;
	private gitRoot: string | undefined;
	private activeFilePath: string | undefined;
	private itemLabel: string | undefined;
	/** Set by `pin()` — while defined, `refresh()` keeps showing history for
	 * *this* file regardless of which editor is actually active, same as
	 * stock Timeline's pin button. */
	private pinnedFilePath: string | undefined;

	constructor(private readonly localHistory: LocalHistoryStore) {}

	get isPinned(): boolean {
		return this.pinnedFilePath !== undefined;
	}

	pin(): void {
		if (this.pinnedFilePath || !this.activeFilePath) {
			return;
		}
		this.pinnedFilePath = this.activeFilePath;
	}

	unpin(): void {
		if (!this.pinnedFilePath) {
			return;
		}
		this.pinnedFilePath = undefined;
		this.refresh();
	}

	/** The inline "open full commit" button (`view/item/context`) is invoked
	 * by VS Code with the clicked `HistoryNode` as its only argument — unlike
	 * the row's own `item.command`, which we control and can pass `gitRoot`
	 * to explicitly — so the command handler needs this out-of-band. */
	get currentGitRoot(): string | undefined {
		return this.gitRoot;
	}

	/** The package item this Timeline is currently tracking (e.g.
	 * "AccountPageV2.js") — stock Timeline shows this next to the view
	 * title; `extension.ts` mirrors it onto the `TreeView.description` on
	 * every refresh. */
	get currentItemLabel(): string | undefined {
		return this.itemLabel;
	}

	get currentSourceFilter(): SourceFilter {
		return { ...this.sourceFilter };
	}

	/** Which sources (Git History / Local History) are merged into the list
	 * — the filter (funnel) button's only job, same as stock Timeline.
	 * Doesn't need a reload: both sources are already loaded, this just
	 * re-renders the merge with the new filter applied. */
	setSourceFilter(filter: SourceFilter): void {
		this.sourceFilter = filter;
		this.changeEmitter.fire();
	}

	toggleGitSource(): void {
		this.setSourceFilter({ ...this.sourceFilter, git: !this.sourceFilter.git });
	}

	toggleLocalSource(): void {
		this.setSourceFilter({ ...this.sourceFilter, local: !this.sourceFilter.local });
	}

	refresh(): void {
		const myGeneration = ++this.generation;
		const settle = (targetPath: string | undefined) => {
			void this.load(targetPath).then(() => {
				if (myGeneration === this.generation) {
					this.changeEmitter.fire();
				}
			});
		};
		if (this.pinnedFilePath) {
			// Pinned: ignore whatever the active editor is — still worth
			// re-running (e.g. the Refresh button, or a new commit landing)
			// to pick up fresh history for the pinned file itself.
			settle(this.pinnedFilePath);
			return;
		}
		if (!vscode.window.activeTextEditor) {
			// `activeTextEditor` routinely goes briefly undefined mid-transition
			// between two editors (e.g. right when a diff view opens or closes)
			// — loading immediately would paint the "no file open" empty state
			// for a moment and then repaint once the real editor change fires,
			// a visible blink. Give the real change a short window to supersede
			// this one (via the generation check below) before committing to it.
			setTimeout(() => {
				if (myGeneration !== this.generation) {
					return;
				}
				settle(vscode.window.activeTextEditor?.document.uri.fsPath);
			}, 150);
			return;
		}
		settle(vscode.window.activeTextEditor.document.uri.fsPath);
	}

	getChildren(node?: HistoryNode): HistoryNode[] {
		if (node) {
			return [];
		}
		const merged = this.mergedEntries();
		if (merged.length) {
			return merged;
		}
		const hiddenByFilter =
			(this.gitEntries.length > 0 && !this.sourceFilter.git) ||
			(this.localEntries.length > 0 && !this.sourceFilter.local);
		if (hiddenByFilter) {
			return [{ kind: "empty", message: "Все записи скрыты текущим фильтром источников (кнопка-воронка)" }];
		}
		return [{ kind: "empty", message: this.emptyMessage }];
	}

	/** Git commits and Local History snapshots merged into one
	 * chronologically-sorted list, same as stock Timeline does across its
	 * own registered sources. */
	private mergedEntries(): HistoryNode[] {
		const withTime: { node: HistoryNode; time: number }[] = [];
		if (this.sourceFilter.git) {
			for (const entry of this.gitEntries) {
				const time = Date.parse(entry.isoDate);
				withTime.push({ node: { kind: "commit", entry }, time: Number.isNaN(time) ? 0 : time });
			}
		}
		if (this.sourceFilter.local) {
			for (const entry of this.localEntries) {
				withTime.push({ node: { kind: "local", entry }, time: entry.timestamp });
			}
		}
		withTime.sort((a, b) => b.time - a.time);
		return withTime.map((w) => w.node);
	}

	getTreeItem(node: HistoryNode): vscode.TreeItem {
		if (node.kind === "empty") {
			const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
			item.iconPath = new vscode.ThemeIcon("info");
			return item;
		}
		if (node.kind === "local") {
			return this.localHistoryTreeItem(node.entry);
		}
		const { entry } = node;
		const item = new vscode.TreeItem(entry.subject || "(без сообщения)", vscode.TreeItemCollapsibleState.None);
		item.description = `${entry.author}, ${entry.date}`;
		item.tooltip = buildTooltip(entry, this.gitRoot);
		item.iconPath = new vscode.ThemeIcon("git-commit", GIT_COMMIT_COLOR);
		item.contextValue = "bpmsoftHistoryCommit";
		if (this.gitRoot && this.activeFilePath) {
			item.command = {
				command: OPEN_HISTORY_DIFF_COMMAND,
				title: "Показать изменения",
				arguments: [this.gitRoot, entry, this.activeFilePath]
			};
		}
		return item;
	}

	private localHistoryTreeItem(entry: LocalHistoryEntry): vscode.TreeItem {
		const item = new vscode.TreeItem(localHistoryLabel(entry), vscode.TreeItemCollapsibleState.None);
		item.description = formatShortRelativeTime(entry.timestamp);
		item.iconPath = new vscode.ThemeIcon("circle-outline", LOCAL_HISTORY_COLOR);
		item.contextValue = "bpmsoftLocalHistoryEntry";
		item.tooltip = buildLocalHistoryTooltip(entry);
		if (this.activeFilePath) {
			item.command = {
				command: OPEN_LOCAL_HISTORY_DIFF_COMMAND,
				title: "Показать изменения",
				arguments: [entry, this.activeFilePath]
			};
		}
		return item;
	}

	private async load(targetPath: string | undefined): Promise<void> {
		this.gitEntries = [];
		this.localEntries = [];
		this.gitRoot = undefined;
		this.activeFilePath = undefined;
		this.itemLabel = undefined;
		if (!targetPath) {
			this.emptyMessage = "Откройте файл схемы пакета";
			return;
		}
		this.activeFilePath = targetPath;
		this.itemLabel = path.basename(targetPath);
		// Local History is per-file and entirely independent of git, so it's
		// fetched concurrently with (not blocked by, or blocking) the git
		// resolution below.
		const [, localEntries] = await Promise.all([
			this.loadGitEntries(targetPath),
			this.localHistory.getEntriesForFile(targetPath).catch(() => [] as LocalHistoryEntry[])
		]);
		this.localEntries = localEntries;
	}

	private async loadGitEntries(activeFilePath: string): Promise<void> {
		const ref = resolvePackageItem(activeFilePath);
		if (!ref) {
			this.emptyMessage = "Текущий файл не относится к схеме пакета (.../Pkg/{Package}/{Тип}/{Имя}/...)";
			return;
		}
		const files = itemFiles(ref);
		if (!files.length) {
			this.emptyMessage = "Не найдены файлы схемы";
			return;
		}
		const gitRoot = await findGitRoot(ref.itemDir);
		if (!gitRoot) {
			this.emptyMessage = "Файлы схемы не под git";
			return;
		}
		try {
			this.gitEntries = await gitLogForFiles(gitRoot, files);
		} catch {
			this.emptyMessage = "git log завершился с ошибкой";
			return;
		}
		this.gitRoot = gitRoot;
		if (!this.gitEntries.length) {
			this.emptyMessage = "Нет истории для файлов этой схемы";
		}
	}
}

function itemFiles(ref: PackageItemRef): string[] {
	return ref.itemType === "Schemas"
		? collectSchemaFiles(ref.itemDir, ref.itemName)
		: collectPackageItemFiles(ref.itemDir);
}

function findGitRoot(cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", ["rev-parse", "--show-toplevel"], { cwd }, (error, stdout) => {
			resolve(error ? undefined : stdout.trim() || undefined);
		});
	});
}

function gitLogForFiles(cwd: string, files: string[]): Promise<HistoryEntry[]> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			[
				"log",
				"--numstat",
				`--pretty=format:${RECORD_SEP}%H${FIELD_SEP}%ad${FIELD_SEP}%aI${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%B${HEADER_END}`,
				"--date=relative",
				"--",
				...files
			],
			{ cwd, maxBuffer: 10 * 1024 * 1024 },
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(parseGitLog(stdout));
			}
		);
	});
}

function parseGitLog(output: string): HistoryEntry[] {
	return output
		.split(RECORD_SEP)
		.filter((record) => record.trim().length > 0)
		.map((record) => {
			const headerEndIdx = record.indexOf(HEADER_END);
			const header = headerEndIdx === -1 ? record : record.slice(0, headerEndIdx);
			const fileBlock = headerEndIdx === -1 ? "" : record.slice(headerEndIdx + HEADER_END.length);
			const [hash = "", date = "", isoDate = "", author = "", authorEmail = "", ...messageParts] =
				header.split(FIELD_SEP);
			const message = messageParts.join(FIELD_SEP).trim();
			const firstLineEnd = message.indexOf("\n");
			const subject = (firstLineEnd === -1 ? message : message.slice(0, firstLineEnd)).trim();
			const { files, filesChanged, insertions, deletions } = parseNumstat(fileBlock);
			return {
				hash,
				date,
				isoDate,
				author,
				authorEmail,
				subject,
				message,
				filesChanged,
				insertions,
				deletions,
				files
			};
		});
}

/** `--numstat` gives, per changed file, "<insertions>\t<deletions>\t<path>"
 * (binary files use "-" for both counts) — parsed here instead of asking git
 * for `--shortstat` separately, since diff-format flags like `--name-only`/
 * `--stat`/`--shortstat`/`--numstat` don't reliably combine (the last one
 * wins), so getting both the file list *and* a stats summary out of one
 * invocation means computing the summary ourselves from `--numstat` alone. */
function parseNumstat(block: string): {
	files: string[];
	filesChanged: number;
	insertions: number;
	deletions: number;
} {
	const files: string[] = [];
	let insertions = 0;
	let deletions = 0;
	for (const rawLine of block.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		const match = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
		if (!match) {
			continue;
		}
		const [, ins, del, filePath] = match;
		if (ins !== "-") {
			insertions += Number(ins);
		}
		if (del !== "-") {
			deletions += Number(del);
		}
		files.push(filePath);
	}
	return { files, filesChanged: files.length, insertions, deletions };
}

function gitShowFiles(cwd: string, hash: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["show", "--name-only", "--pretty=format:", hash],
			{ cwd, maxBuffer: 10 * 1024 * 1024 },
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(
					stdout
						.split(/\r?\n/)
						.map((l) => l.trim())
						.filter(Boolean)
				);
			}
		);
	});
}

/** Whether `relFile` exists at `ref` — false both when the file itself
 * wasn't there yet and when `ref` isn't a valid commit at all (e.g. `hash^`
 * for a file's very first commit), which is exactly the "this commit added
 * the file" case we need to tell apart from a normal modification. */
function fileExistsAtRef(cwd: string, ref: string, relFile: string): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("git", ["cat-file", "-e", `${ref}:${relFile}`], { cwd }, (error) => {
			resolve(!error);
		});
	});
}

function emptyUriFor(relFile: string): vscode.Uri {
	return vscode.Uri.parse(`${EMPTY_CONTENT_SCHEME}:${encodeURIComponent(relFile)}`);
}

/** The (universal, same in every git repo) SHA-1 of an empty tree — stock
 * Timeline labels the "before" side of an added-file diff with this object's
 * short hash rather than leaving it blank, so the diff tab title reads
 * "file.js (4b825dc6) ↔ file.js (<hash>)" even for a brand-new file. */
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Git's own abbreviation length is dynamic (grows past the 7-char default
 * once a repo has enough objects to make 7 ambiguous) — resolving it via
 * `rev-parse --short` instead of a fixed `.slice(0, 7)` is what makes our
 * diff tab titles match stock Timeline's hash length exactly. Falls back to
 * a plain 7-char slice of `fallbackFull` if resolution fails for any reason. */
function resolveShortHash(cwd: string, rev: string, fallbackFull: string): Promise<string> {
	return new Promise((resolve) => {
		execFile("git", ["rev-parse", "--short", rev], { cwd }, (error, stdout) => {
			const short = !error && stdout.trim();
			resolve(short || fallbackFull.slice(0, 7));
		});
	});
}

/** Matches the `git:` scheme + `{path, ref}`-JSON-in-query contract the
 * built-in Git extension's content provider expects (`extensions/git/src/
 * uri.ts`, `toGitUri`/`fromGitUri`) — reproduced here rather than imported
 * since that helper isn't part of the extension's public API surface, only
 * its `git:` URI wire format is a de-facto stable contract other extensions
 * (GitLens included) rely on the same way. */
function toGitUri(fileUri: vscode.Uri, ref: string): vscode.Uri {
	return fileUri.with({
		scheme: "git",
		path: fileUri.path,
		query: JSON.stringify({ path: fileUri.fsPath, ref })
	});
}

// Only characters that can actually break rendering (bold/italic/code/link
// syntax) — deliberately NOT escaping ".", "-", "(", ")", "#", "+": commit
// messages routinely use "1. …"/"2. …" numbered lists or "- …" bullets, and
// escaping those periods/dashes would strip the ordered/unordered list
// formatting CommonMark would otherwise give us for free (matching stock
// Timeline's own rendering of the same message).
const MD_ESCAPE_RE = /([\\`*_[\]])/g;
const URL_RE = /(https?:\/\/[^\s)]+)/g;

/** HTML-entity-escapes `&`/`</>` first (order matters — must run before the
 * markdown backslash-escaping below, and before inserting entities of our
 * own) so a commit message containing literal `<`/`>` can't be misread as a
 * tag now that the tooltip has `supportHtml` on (needed for colored
 * insertions/deletions). */
function escapeMarkdown(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(MD_ESCAPE_RE, "\\$1");
}

/** Escapes markdown-significant characters everywhere *except* inside bare
 * URLs, which get turned into real `[url](url)` links instead — a stock
 * Timeline hover renders e.g. a ticket URL on its own line as a clickable
 * link, and relying on the renderer's own auto-linkify for a `MarkdownString`
 * tooltip isn't guaranteed the same way it is for hover-provider content. */
function linkifyMessage(text: string): string {
	let result = "";
	let lastIndex = 0;
	let match: RegExpExecArray | null;
	URL_RE.lastIndex = 0;
	while ((match = URL_RE.exec(text))) {
		result += escapeMarkdown(text.slice(lastIndex, match.index));
		const url = match[1];
		result += `[${url}](${url})`;
		lastIndex = match.index + url.length;
	}
	result += escapeMarkdown(text.slice(lastIndex));
	return result;
}

function formatAbsoluteDate(isoDate: string): string | undefined {
	if (!isoDate) {
		return undefined;
	}
	const parsed = new Date(isoDate);
	if (Number.isNaN(parsed.getTime())) {
		return undefined;
	}
	return parsed.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
}

/** Mirrors stock Timeline's rich commit hover: avatar + `mailto:` author link,
 * clock icon + relative/absolute time, the full (linkified) commit message,
 * a green/red insertions/deletions summary, and — at the bottom — the commit
 * icon+hash as an "open commit" link plus a separate copy-hash button.
 * `supportHtml` is needed for the colored stat spans; `isTrusted` is scoped
 * to exactly the two commands this tooltip's links can invoke. */
function buildTooltip(entry: HistoryEntry, gitRoot: string | undefined): vscode.MarkdownString {
	const md = new vscode.MarkdownString(undefined, true);
	md.supportHtml = true;
	md.isTrusted = { enabledCommands: [OPEN_HISTORY_COMMIT_FROM_TOOLTIP_COMMAND, COPY_HASH_COMMAND] };

	const authorText = entry.authorEmail
		? `[${escapeMarkdown(entry.author)}](mailto:${entry.authorEmail})`
		: escapeMarkdown(entry.author);
	const absolute = formatAbsoluteDate(entry.isoDate);
	md.appendMarkdown(
		`$(account) ${authorText}, $(history) ${escapeMarkdown(entry.date)}${
			absolute ? ` (${escapeMarkdown(absolute)})` : ""
		}\n\n`
	);

	if (entry.message) {
		md.appendMarkdown(`${linkifyMessage(entry.message)}\n\n`);
	}

	if (entry.filesChanged) {
		const parts = [`${entry.filesChanged} ${entry.filesChanged === 1 ? "file changed" : "files changed"}`];
		if (entry.insertions) {
			parts.push(
				`<span style="color:var(--vscode-gitDecoration-addedResourceForeground);">${entry.insertions} insertion${entry.insertions === 1 ? "" : "s"}(+)</span>`
			);
		}
		if (entry.deletions) {
			parts.push(
				`<span style="color:var(--vscode-gitDecoration-deletedResourceForeground);">${entry.deletions} deletion${entry.deletions === 1 ? "" : "s"}(-)</span>`
			);
		}
		md.appendMarkdown(`---\n\n${parts.join(", ")}\n\n`);
	}

	const shortHash = entry.hash.slice(0, 7);
	if (gitRoot) {
		const openArgs = encodeURIComponent(JSON.stringify([gitRoot, entry]));
		const copyArgs = encodeURIComponent(JSON.stringify([entry.hash]));
		md.appendMarkdown(
			`[$(git-commit) \`${shortHash}\`](command:${OPEN_HISTORY_COMMIT_FROM_TOOLTIP_COMMAND}?${openArgs} "Открыть коммит") ` +
				`[$(copy)](command:${COPY_HASH_COMMAND}?${copyArgs} "Скопировать хеш")`
		);
	} else {
		md.appendMarkdown(`$(git-commit) \`${shortHash}\``);
	}
	return md;
}

const RELATIVE_TIME_DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
	{ amount: 60, unit: "seconds" },
	{ amount: 60, unit: "minutes" },
	{ amount: 24, unit: "hours" },
	{ amount: 7, unit: "days" },
	{ amount: 4.34524, unit: "weeks" },
	{ amount: 12, unit: "months" },
	{ amount: Number.POSITIVE_INFINITY, unit: "years" }
];

/** "N minutes/hours/days ago" — matches git's own `--date=relative` style
 * (used for commit rows) so Local History rows read consistently with them,
 * rather than mixing in a differently-worded/localized format. */
function formatRelativeTime(timestampMs: number): string {
	const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always" });
	let duration = (timestampMs - Date.now()) / 1000;
	for (const division of RELATIVE_TIME_DIVISIONS) {
		if (Math.abs(duration) < division.amount) {
			return rtf.format(Math.round(duration), division.unit);
		}
		duration /= division.amount;
	}
	return rtf.format(Math.round(duration), "years");
}

const SHORT_TIME_DIVISIONS: { amount: number; suffix: string }[] = [
	{ amount: 60, suffix: "sec" },
	{ amount: 60, suffix: "min" },
	{ amount: 24, suffix: "hr" },
	{ amount: 30, suffix: "day" },
	{ amount: 12, suffix: "mo" },
	{ amount: Number.POSITIVE_INFINITY, suffix: "yr" }
];

/** "15 mins"/"2 hr" — the terser style stock Timeline uses for Local History
 * rows' description (distinct from `formatRelativeTime`'s "N minutes ago",
 * which stays in use for commit rows and diff tab titles). */
function formatShortRelativeTime(timestampMs: number): string {
	let value = Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
	if (value < 5) {
		return "just now";
	}
	let suffix = "sec";
	for (const division of SHORT_TIME_DIVISIONS) {
		if (value < division.amount) {
			suffix = division.suffix;
			break;
		}
		value = Math.round(value / division.amount);
		suffix = division.suffix;
	}
	return `${value} ${suffix}${value === 1 ? "" : "s"}`;
}

/** Best-effort — VS Code's own source→label mapping for Local History entries
 * isn't public. Plain saves (the overwhelming majority, and the only case
 * stock is confirmed to show "File Saved" for) have no `source` at all;
 * anything else falls back to showing the raw source id rather than
 * guessing at a translation. */
function localHistoryLabel(entry: LocalHistoryEntry): string {
	return entry.source || "File Saved";
}

/** Mirrors stock Timeline's own (minimal) Local History hover: just the
 * absolute timestamp and the entry's label — no extra framing. */
function buildLocalHistoryTooltip(entry: LocalHistoryEntry): vscode.MarkdownString {
	const md = new vscode.MarkdownString(undefined, true);
	const absolute = new Date(entry.timestamp).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
	md.appendMarkdown(`$(history) ${escapeMarkdown(absolute)}\n\n${escapeMarkdown(localHistoryLabel(entry))}`);
	return md;
}

async function openFilesDiff(gitRoot: string, hash: string, relFiles: string[]): Promise<void> {
	if (!relFiles.length) {
		void vscode.window.showInformationMessage("В этом коммите нет изменённых файлов для отображения");
		return;
	}
	if (!vscode.extensions.getExtension("vscode.git")) {
		void vscode.window.showWarningMessage("Встроенное расширение Git недоступно — не удалось открыть diff");
		return;
	}
	const parent = `${hash}^`;
	const files = relFiles.length > MAX_DIFF_TABS ? relFiles.slice(0, MAX_DIFF_TABS) : relFiles;
	if (relFiles.length > MAX_DIFF_TABS) {
		void vscode.window.showInformationMessage(
			`Коммит затрагивает ${relFiles.length} файлов, будут открыты первые ${MAX_DIFF_TABS}`
		);
	}
	// Resolved once per commit (not per file) — same for every file in the
	// loop below, and each is its own git process spawn.
	const [rightShortHash, parentShortHash, emptyTreeShortHash] = await Promise.all([
		resolveShortHash(gitRoot, hash, hash),
		resolveShortHash(gitRoot, parent, hash),
		resolveShortHash(gitRoot, EMPTY_TREE_HASH, EMPTY_TREE_HASH)
	]);
	for (const relFile of files) {
		const uri = vscode.Uri.file(path.join(gitRoot, relFile));
		const existedBefore = await fileExistsAtRef(gitRoot, parent, relFile);
		const left = existedBefore ? toGitUri(uri, parent) : emptyUriFor(relFile);
		const right = toGitUri(uri, hash);
		const leftShortHash = existedBefore ? parentShortHash : emptyTreeShortHash;
		const basename = path.basename(relFile);
		const title = `${basename} (${leftShortHash}) ↔ ${basename} (${rightShortHash})`;
		// `preserveFocus` keeps keyboard focus on the Timeline tree instead of
		// moving it into the newly-opened diff editor — without it, the
		// clicked row's selection highlight immediately falls back from
		// "focused" blue to "unfocused" grey the instant the diff opens,
		// unlike stock Timeline, which stays blue while you're looking at it.
		await vscode.commands.executeCommand("vscode.diff", left, right, title, { preserveFocus: true });
	}
}

/** The tooltip's copy-hash button. */
export async function copyHash(hash: string): Promise<void> {
	await vscode.env.clipboard.writeText(hash);
}

/** Row click — mirrors stock Timeline: diff of *just the file this Timeline
 * is for* at this commit vs its parent, not every tracked file the commit
 * happened to touch (that's what the "open full commit" button is for). A
 * commit can still legitimately be in this list without having changed
 * `activeFilePath` itself (the list is unified across the whole package
 * item, see the class doc) — the diff then simply comes back empty, which
 * correctly says "this particular file didn't change here". */
export async function openHistoryDiff(
	gitRoot: string,
	entry: HistoryEntry,
	activeFilePath: string
): Promise<void> {
	const relFile = path.relative(gitRoot, activeFilePath).replace(/\\/g, "/");
	await openFilesDiff(gitRoot, entry.hash, [relFile]);
}

/** Local History snapshot vs the current live file — unlike git commits,
 * there's no "parent" concept here worth diffing against; comparing to the
 * current file is what lets you actually decide whether to restore it. The
 * snapshot is already a real file on disk (`entry.contentPath`), so this
 * needs no `git:`/empty-content-scheme URI trickery at all. */
export async function openLocalHistoryDiff(entry: LocalHistoryEntry, activeFilePath: string): Promise<void> {
	const left = vscode.Uri.file(entry.contentPath);
	const right = vscode.Uri.file(activeFilePath);
	const basename = path.basename(activeFilePath);
	const title = `${basename} (${formatRelativeTime(entry.timestamp)}) ↔ ${basename} (рабочая версия)`;
	await vscode.commands.executeCommand("vscode.diff", left, right, title, { preserveFocus: true });
}

/** Best-effort: opens every changed file in ONE scrollable multi-diff editor
 * (`vscode.changes`), matching stock Timeline's "open commit" button —
 * instead of the old one-`vscode.diff`-tab-per-file loop. `vscode.changes`
 * isn't part of the documented public API surface (no official signature
 * reference exists as of this writing), so this is a best-informed guess at
 * its argument shape; returns `false` on any failure so the caller can fall
 * back to the always-correct per-file loop rather than silently doing
 * nothing. VS Code appends its own "(N files)" to the title. */
async function openMultiFileDiff(
	gitRoot: string,
	hash: string,
	relFiles: string[],
	title: string
): Promise<boolean> {
	if (!relFiles.length) {
		return false;
	}
	try {
		const parent = `${hash}^`;
		const resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = [];
		for (const relFile of relFiles) {
			const uri = vscode.Uri.file(path.join(gitRoot, relFile));
			const existedBefore = await fileExistsAtRef(gitRoot, parent, relFile);
			const left = existedBefore ? toGitUri(uri, parent) : undefined;
			const right = toGitUri(uri, hash);
			resources.push([uri, left, right]);
		}
		await vscode.commands.executeCommand("vscode.changes", title, resources);
		return true;
	} catch {
		return false;
	}
}

export async function openHistoryCommit(gitRoot: string, entry: HistoryEntry): Promise<void> {
	try {
		const allFiles = await gitShowFiles(gitRoot, entry.hash);
		const shortHash = await resolveShortHash(gitRoot, entry.hash, entry.hash);
		const title = entry.subject ? `${shortHash} - ${entry.subject}` : shortHash;
		const opened = await openMultiFileDiff(gitRoot, entry.hash, allFiles, title);
		if (!opened) {
			await openFilesDiff(gitRoot, entry.hash, allFiles);
		}
	} catch {
		void vscode.window.showWarningMessage("Не удалось получить список файлов коммита");
	}
}
