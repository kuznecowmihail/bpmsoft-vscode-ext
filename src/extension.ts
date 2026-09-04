import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { SymbolIndex } from "./index/SymbolIndex";
import { ModuleIndexer } from "./index/ModuleIndexer";
import {
	resolveAppLayouts,
	supportedAppLayouts
} from "./index/workspaceLayout";
import { ensureDotnetSolution, maybeOfferCsharpExtension } from "./dotnet/ensureDotnetIntellisense";
import { CompletionProvider } from "./providers/CompletionProvider";
import { DefinitionProvider } from "./providers/DefinitionProvider";
import { HoverProvider } from "./providers/HoverProvider";
import { CsharpHoverProvider } from "./providers/CsharpHoverProvider";
import { resetLocalizationCaches } from "./index/localizationLookup";
import { MissingMemberDiagnostics } from "./providers/MissingMemberDiagnostics";
import { StyleDiagnostics } from "./providers/StyleDiagnostics";
import { StyleCodeActionProvider } from "./providers/StyleCodeActionProvider";
import { JsFormattingProvider } from "./providers/JsFormattingProvider";
import { CsharpFormattingProvider } from "./providers/CsharpFormattingProvider";
import { SqlFormattingProvider } from "./providers/SqlFormattingProvider";
import { NamingDiagnostics, isNamingDiagnosticsTarget } from "./providers/NamingDiagnostics";
import { NamingCodeActionProvider } from "./providers/NamingCodeActionProvider";
import { NamingIssuesTreeProvider } from "./providers/NamingIssuesTreeProvider";
import { NamingFinding, NamingIssuesIndex } from "./index/NamingIssuesIndex";
import { extractNamingSubject } from "./parse/namingCommon";
import { findOwningSchemaDescriptor } from "./index/schemaResourceLookup";
import { PackagesTreeProvider } from "./providers/PackagesTreeProvider";
import { NamingDecorationProvider } from "./providers/NamingDecorationProvider";
import { ViewModelOutlineProvider } from "./providers/ViewModelOutlineProvider";
import { GitFlowStatusBar } from "./providers/GitFlowStatusBar";
import { PackageOwnershipStatusBar } from "./providers/PackageOwnershipStatusBar";
import {
	EDIT_PACKAGE_SETTING_COMMAND,
	PackageSettingsTreeProvider,
	editPackageSetting
} from "./providers/PackageSettingsTreeProvider";
import { PlainOutlineProvider, PlainOutlineSortMode } from "./providers/PlainOutlineProvider";
import {
	SchemaHistoryTreeProvider,
	HistoryNode,
	OPEN_HISTORY_DIFF_COMMAND,
	OPEN_HISTORY_COMMIT_COMMAND,
	OPEN_HISTORY_COMMIT_FROM_TOOLTIP_COMMAND,
	OPEN_LOCAL_HISTORY_DIFF_COMMAND,
	COPY_HASH_COMMAND,
	EMPTY_CONTENT_SCHEME,
	EmptyContentProvider,
	openHistoryDiff,
	openHistoryCommit,
	openLocalHistoryDiff,
	copyHash
} from "./providers/SchemaHistoryTreeProvider";
import { LocalHistoryStore } from "./index/localHistory";
import { OpenSchemasTreeProvider } from "./providers/OpenSchemasTreeProvider";
import {
	FormatterSettingsTreeProvider,
	SET_DEFAULT_FORMATTER_COMMAND,
	setDefaultFormatter
} from "./providers/FormatterSettingsTreeProvider";
import {
	CREATE_MEMBER_COMMAND,
	CreateMemberArgs,
	CreateMemberCodeActionProvider,
	executeCreateMember
} from "./providers/CreateMemberCodeActionProvider";

let index: SymbolIndex;
let indexer: ModuleIndexer;
let diagnostics: MissingMemberDiagnostics;
let styleDiagnostics: StyleDiagnostics;
let namingDiagnostics: NamingDiagnostics;
let namingIndex: NamingIssuesIndex;
let outlineTree: ViewModelOutlineProvider;
let plainOutlineTree: PlainOutlineProvider;
let followViewModelOutlineCursor = false;
let followPlainOutlineCursor = false;
let plainOutlineFilterOnType = false;

function setPlainOutlineSortMode(mode: PlainOutlineSortMode): void {
	plainOutlineTree.setSortMode(mode);
	void vscode.commands.executeCommand("setContext", "bpmsoftPlainOutlineSortPosition", mode === "position");
	void vscode.commands.executeCommand("setContext", "bpmsoftPlainOutlineSortName", mode === "name");
	void vscode.commands.executeCommand("setContext", "bpmsoftPlainOutlineSortCategory", mode === "category");
}
let schemaHistoryTree: SchemaHistoryTreeProvider;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	try {
		const folders = vscode.workspace.workspaceFolders;
		const layouts = supportedAppLayouts(
			resolveAppLayouts(folders?.map((f) => f.uri.fsPath) || [])
		);
		if (!layouts.length) {
			return;
		}

		index = new SymbolIndex();
		const cacheDir = ensurePlatformIndexCacheDir(context);
		indexer = new ModuleIndexer(index, cacheDir, context.extension.packageJSON.version);
		diagnostics = new MissingMemberDiagnostics(index);
		styleDiagnostics = new StyleDiagnostics(index);
		namingDiagnostics = new NamingDiagnostics(index);
		namingIndex = new NamingIssuesIndex(index);
		const namingTree = new NamingIssuesTreeProvider(namingIndex);
		const packagesTree = new PackagesTreeProvider(index, namingIndex);
		const packagesTreeView = vscode.window.createTreeView("bpmsoftPackages", {
			treeDataProvider: packagesTree
		});
		// Passive, like Explorer's own auto-reveal: only updates the
		// selection while Packages is already the visible view — `reveal()`
		// has no "select without switching container" option, so calling it
		// while some other Activity Bar tab (Search, …) is active forces a
		// jump into BPMSoft Explorer, which is the opposite of what's
		// wanted. Re-run once the view *becomes* visible again so it still
		// catches up to whatever's open by then, same as Explorer does.
		const revealActiveFileInPackages = () => {
			const doc = vscode.window.activeTextEditor?.document;
			if (!doc || !packagesTreeView.visible) {
				return;
			}
			const target = packagesTree.nodeForFilePath(doc.uri.fsPath);
			if (!target) {
				return;
			}
			void packagesTreeView
				.reveal(target, { select: true, focus: false, expand: true })
				.then(undefined, () => {
					// View not visible / item not found yet — not worth surfacing.
				});
		};
		outlineTree = new ViewModelOutlineProvider(index);
		const outlineTreeView = vscode.window.createTreeView("bpmsoftViewModelOutline", {
			treeDataProvider: outlineTree,
			showCollapseAll: true
		});
		plainOutlineTree = new PlainOutlineProvider();
		const plainOutlineTreeView = vscode.window.createTreeView("bpmsoftPlainOutline", {
			treeDataProvider: plainOutlineTree,
			showCollapseAll: true
		});
		const localHistoryStore = new LocalHistoryStore(context);
		schemaHistoryTree = new SchemaHistoryTreeProvider(localHistoryStore);
		const schemaHistoryTreeView = vscode.window.createTreeView("bpmsoftSchemaHistory", {
			treeDataProvider: schemaHistoryTree
		});
		schemaHistoryTree.onDidChangeTreeData(() => {
			schemaHistoryTreeView.description = schemaHistoryTree.currentItemLabel;
		});
		// Mirrors the provider's own default filter state ({git:true,
		// local:true}) onto the filter submenu's checkmarks — those read
		// purely off these context keys, so without this they'd start
		// unchecked despite both sources actually being on.
		void vscode.commands.executeCommand("setContext", "bpmsoftSchemaHistoryGitEnabled", true);
		void vscode.commands.executeCommand("setContext", "bpmsoftSchemaHistoryLocalEnabled", true);
		// Mirrors PlainOutlineProvider's own default sort mode ("position")
		// onto the Sort By submenu's checkmarks, same reasoning as above.
		void vscode.commands.executeCommand("setContext", "bpmsoftPlainOutlineSortPosition", true);
		const openSchemasTree = new OpenSchemasTreeProvider();
		const formatterTree = new FormatterSettingsTreeProvider(context.extension.id);

		const jsSelector: vscode.DocumentSelector = {
			language: "javascript",
			scheme: "file"
		};
		const csharpSelector: vscode.DocumentSelector = [
			{ language: "csharp" },
			{ pattern: "**/*.cs", scheme: "file" }
		];
		// Everything NamingDiagnostics puts squiggles on that isn't JS/C# —
		// the JSON descriptor.json files for client/SQL/Data schemas.
		const namingJsonSelector: vscode.DocumentSelector = [
			{ pattern: "**/Schemas/**/descriptor.json", scheme: "file" },
			{ pattern: "**/SqlScripts/**/descriptor.json", scheme: "file" },
			{ pattern: "**/Data/**/descriptor.json", scheme: "file" }
		];

		const completionProvider = new CompletionProvider(index);

		const gitFlowCandidateRoots = layouts
			.map((l) => l.pkgRoot || l.configurationRoot || l.appRoot || l.workspaceRoot)
			.filter((p): p is string => Boolean(p));
		const gitFlowStatusBar = new GitFlowStatusBar(gitFlowCandidateRoots);
		const packageOwnershipStatusBar = new PackageOwnershipStatusBar();
		const packageSettingsTree = new PackageSettingsTreeProvider();

		context.subscriptions.push(
			diagnostics,
			styleDiagnostics,
			namingDiagnostics,
			vscode.window.registerTreeDataProvider("bpmsoftNamingIssues", namingTree),
			packagesTreeView,
			vscode.window.registerFileDecorationProvider(new NamingDecorationProvider(namingIndex)),
			outlineTreeView,
			outlineTreeView.onDidExpandElement((e) => outlineTree.setExpanded(e.element, true)),
			outlineTreeView.onDidCollapseElement((e) => outlineTree.setExpanded(e.element, false)),
			plainOutlineTreeView,
			plainOutlineTreeView.onDidExpandElement((e) => plainOutlineTree.setExpanded(e.element, true)),
			plainOutlineTreeView.onDidCollapseElement((e) => plainOutlineTree.setExpanded(e.element, false)),
			vscode.commands.registerCommand("bpmsoft.viewModelOutline.toggleFollowCursor", () => {
				followViewModelOutlineCursor = !followViewModelOutlineCursor;
				void vscode.commands.executeCommand(
					"setContext",
					"bpmsoftViewModelOutlineFollowCursor",
					followViewModelOutlineCursor
				);
			}),
			vscode.commands.registerCommand("bpmsoft.plainOutline.toggleFollowCursor", () => {
				followPlainOutlineCursor = !followPlainOutlineCursor;
				void vscode.commands.executeCommand(
					"setContext",
					"bpmsoftPlainOutlineFollowCursor",
					followPlainOutlineCursor
				);
			}),
			vscode.commands.registerCommand("bpmsoft.plainOutline.toggleFilterOnType", () => {
				plainOutlineFilterOnType = !plainOutlineFilterOnType;
				void vscode.commands.executeCommand(
					"setContext",
					"bpmsoftPlainOutlineFilterOnType",
					plainOutlineFilterOnType
				);
			}),
			vscode.commands.registerCommand("bpmsoft.plainOutline.sortByPosition", () => setPlainOutlineSortMode("position")),
			vscode.commands.registerCommand("bpmsoft.plainOutline.sortByName", () => setPlainOutlineSortMode("name")),
			vscode.commands.registerCommand("bpmsoft.plainOutline.sortByCategory", () => setPlainOutlineSortMode("category")),
			vscode.window.onDidChangeTextEditorSelection((e) => {
				if (e.textEditor !== vscode.window.activeTextEditor) {
					return;
				}
				const line = e.selections[0]?.active.line;
				if (followViewModelOutlineCursor && line !== undefined) {
					const node = outlineTree.findNodeAtOrBeforeLine(line);
					if (node) {
						void outlineTreeView.reveal(node, { select: true, focus: false, expand: false }).then(undefined, () => {
							// Not visible / not the active view — not worth surfacing.
						});
					}
				}
				if (followPlainOutlineCursor && e.selections[0]) {
					const node = plainOutlineTree.findNodeAtPosition(e.selections[0].active);
					if (node) {
						void plainOutlineTreeView
							.reveal(node, { select: true, focus: false, expand: false })
							.then(undefined, () => {
								// Not visible / not the active view — not worth surfacing.
							});
					}
				}
			}),
			schemaHistoryTreeView,
			vscode.workspace.registerTextDocumentContentProvider(
				EMPTY_CONTENT_SCHEME,
				new EmptyContentProvider()
			),
			vscode.commands.registerCommand(OPEN_HISTORY_DIFF_COMMAND, openHistoryDiff),
			vscode.commands.registerCommand(OPEN_LOCAL_HISTORY_DIFF_COMMAND, openLocalHistoryDiff),
			vscode.commands.registerCommand(OPEN_HISTORY_COMMIT_FROM_TOOLTIP_COMMAND, openHistoryCommit),
			vscode.commands.registerCommand(COPY_HASH_COMMAND, copyHash),
			vscode.commands.registerCommand(OPEN_HISTORY_COMMIT_COMMAND, async (node?: HistoryNode) => {
				const gitRoot = schemaHistoryTree.currentGitRoot;
				if (!gitRoot || !node || node.kind !== "commit") {
					return;
				}
				await openHistoryCommit(gitRoot, node.entry);
			}),
			vscode.commands.registerCommand("bpmsoft.schemaHistory.refresh", () => {
				schemaHistoryTree.refresh();
			}),
			vscode.commands.registerCommand("bpmsoft.schemaHistory.findLocalHistory", async () => {
				await vscode.commands.executeCommand("workbench.action.localHistory.restoreViaPicker");
			}),
			vscode.commands.registerCommand("bpmsoft.schemaHistory.pin", () => {
				schemaHistoryTree.pin();
				void vscode.commands.executeCommand("setContext", "bpmsoftSchemaHistoryPinned", true);
			}),
			vscode.commands.registerCommand("bpmsoft.schemaHistory.unpin", () => {
				schemaHistoryTree.unpin();
				void vscode.commands.executeCommand("setContext", "bpmsoftSchemaHistoryPinned", false);
			}),
			vscode.commands.registerCommand("bpmsoft.schemaHistory.toggleGitHistory", () => {
				schemaHistoryTree.toggleGitSource();
				void vscode.commands.executeCommand(
					"setContext",
					"bpmsoftSchemaHistoryGitEnabled",
					schemaHistoryTree.currentSourceFilter.git
				);
			}),
			vscode.commands.registerCommand("bpmsoft.schemaHistory.toggleLocalHistory", () => {
				schemaHistoryTree.toggleLocalSource();
				void vscode.commands.executeCommand(
					"setContext",
					"bpmsoftSchemaHistoryLocalEnabled",
					schemaHistoryTree.currentSourceFilter.local
				);
			}),
			vscode.window.registerTreeDataProvider("bpmsoftOpenSchemas", openSchemasTree),
			vscode.window.tabGroups.onDidChangeTabs(() => openSchemasTree.refresh()),
			vscode.window.registerTreeDataProvider("bpmsoftFormatting", formatterTree),
			vscode.commands.registerCommand(
				SET_DEFAULT_FORMATTER_COMMAND,
				async (languageId?: string) => {
					await setDefaultFormatter(context.extension.id, languageId);
					formatterTree.refresh();
					void vscode.window.showInformationMessage(
						languageId
							? `BPMSoft — форматтер по умолчанию для ${languageId}`
							: "BPMSoft — форматтер по умолчанию для JS/C#/SQL"
					);
				}
			),
			vscode.languages.registerCompletionItemProvider(
				jsSelector,
				completionProvider,
				".",
				"$",
				"\"",
				"'",
				"("
			),
			vscode.languages.registerDefinitionProvider(
				jsSelector,
				new DefinitionProvider(index)
			),
			vscode.languages.registerHoverProvider(
				jsSelector,
				new HoverProvider(index)
			),
			vscode.languages.registerHoverProvider(
				csharpSelector,
				new CsharpHoverProvider()
			),
			vscode.languages.registerCodeActionsProvider(
				jsSelector,
				new CreateMemberCodeActionProvider(),
				{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
			),
			vscode.languages.registerCodeActionsProvider(
				jsSelector,
				new StyleCodeActionProvider(),
				{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
			),
			vscode.languages.registerCodeActionsProvider(
				csharpSelector,
				new StyleCodeActionProvider(),
				{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
			),
			vscode.languages.registerCodeActionsProvider(
				[...csharpSelector, ...namingJsonSelector],
				new NamingCodeActionProvider(),
				{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
			),
			vscode.languages.registerDocumentFormattingEditProvider(
				jsSelector,
				new JsFormattingProvider()
			),
			vscode.languages.registerDocumentFormattingEditProvider(
				csharpSelector,
				new CsharpFormattingProvider()
			),
			vscode.languages.registerDocumentFormattingEditProvider(
				{ language: "sql", scheme: "file" },
				new SqlFormattingProvider()
			),
			vscode.commands.registerCommand("bpmsoft.rebuildIndex", async () => {
				await rebuildWithProgress(true);
			}),
			vscode.commands.registerCommand(
				"bpmsoft.naming.markFalsePositive",
				async (arg: string | { finding?: NamingFinding } | undefined) => {
					const name =
						typeof arg === "string"
							? arg
							: arg?.finding
								? extractNamingSubject(arg.finding.message)
								: undefined;
					if (!name) {
						void vscode.window.showWarningMessage(
							"Не удалось определить имя для этой находки."
						);
						return;
					}
					const config = vscode.workspace.getConfiguration("bpmsoft");
					const current = config.get<string[]>("naming.ignoredNames", []);
					if (current.includes(name)) {
						return;
					}
					await config.update(
						"naming.ignoredNames",
						[...current, name],
						vscode.ConfigurationTarget.Workspace
					);
					void vscode.window.showInformationMessage(
						`«${name}» помечено как ложное срабатывание — проверки нейминга больше не будут показывать находки для этого имени.`
					);
				}
			),
			vscode.commands.registerCommand(
				CREATE_MEMBER_COMMAND,
				(args: CreateMemberArgs) => executeCreateMember(args, diagnostics)
			),
			vscode.workspace.onDidChangeTextDocument((e) => {
				diagnostics.schedule(e.document);
				styleDiagnostics.schedule(e.document);
				namingDiagnostics.schedule(e.document);
			}),
			vscode.workspace.onDidOpenTextDocument((document) => {
				diagnostics.refresh(document);
				styleDiagnostics.refresh(document);
				namingDiagnostics.refresh(document);
				if (document.languageId === "csharp") {
					void maybeOfferCsharpExtension(context);
				}
			}),
			vscode.workspace.onDidSaveTextDocument((document) => {
				const fsPath = document.uri.fsPath;
				if (isNamingDiagnosticsTarget(fsPath)) {
					void namingIndex.refreshFile(fsPath);
					return;
				}
				const normalized = fsPath.replace(/\\/g, "/");
				if (/\/metadata\.json$/i.test(normalized) || /\/schemas\/[^/]+\/[^/]+\.less$/i.test(normalized)) {
					void namingIndex.refreshFile(path.join(path.dirname(fsPath), "descriptor.json"));
				} else if (/\/resource\.[^/]+\.xml$/i.test(normalized)) {
					const ownerDescriptor = findOwningSchemaDescriptor(fsPath);
					if (ownerDescriptor) {
						void namingIndex.refreshFile(ownerDescriptor);
					}
				}
			}),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				outlineTree.refresh();
				void plainOutlineTree.refresh();
				schemaHistoryTree.refresh();
				void gitFlowStatusBar.refresh();
				packageOwnershipStatusBar.refresh();
				if (editor) {
					styleDiagnostics.refresh(editor.document);
					if (editor.document.languageId === "csharp") {
						void maybeOfferCsharpExtension(context);
					}
				}
				revealActiveFileInPackages();
			}),
			packagesTreeView.onDidChangeVisibility((e) => {
				if (e.visible) {
					revealActiveFileInPackages();
				}
			}),
			gitFlowStatusBar,
			// Branch switches usually happen via the integrated terminal or an
			// external git client, not through anything this extension
			// observes directly — re-checking whenever the window regains
			// focus catches those without needing a raw `.git/HEAD` watcher.
			vscode.window.onDidChangeWindowState((state) => {
				if (state.focused) {
					void gitFlowStatusBar.refresh();
				}
			}),
			packageOwnershipStatusBar,
			vscode.window.registerTreeDataProvider("bpmsoftPackageSettings", packageSettingsTree),
			vscode.commands.registerCommand(EDIT_PACKAGE_SETTING_COMMAND, async (field) => {
				const changed = await editPackageSetting(field);
				if (changed) {
					packageSettingsTree.refresh();
					packageOwnershipStatusBar.refresh();
				}
			}),
			vscode.workspace.onDidCloseTextDocument((document) => {
				diagnostics.clear(document.uri);
				styleDiagnostics.clear(document.uri);
				namingDiagnostics.clear(document.uri);
				if (
					document.uri.scheme === "file" &&
					document.languageId === "javascript"
				) {
					void indexer.indexFile(document.uri.fsPath);
				}
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("bpmsoft.styleDiagnostics")) {
					styleDiagnostics.refreshOpenDocuments();
				}
				if (
					e.affectsConfiguration("bpmsoft.namingDiagnostics") ||
					e.affectsConfiguration("bpmsoft.namingPrefixes") ||
					e.affectsConfiguration("bpmsoft.naming.ignoredNames") ||
					e.affectsConfiguration("bpmsoft.clientSchemaNaming.checkModuleSuffix")
				) {
					namingDiagnostics.refreshOpenDocuments();
					void namingIndex.refresh();
				}
				if (e.affectsConfiguration("editor.defaultFormatter")) {
					formatterTree.refresh();
				}
				if (
					e.affectsConfiguration("bpmsoft.gitFlowDiagnostics") ||
					e.affectsConfiguration("bpmsoft.gitFlow")
				) {
					void gitFlowStatusBar.refresh();
				}
				if (
					e.affectsConfiguration("bpmsoft.packageOwnershipDiagnostics") ||
					e.affectsConfiguration("bpmsoft.currentPackage") ||
					e.affectsConfiguration("bpmsoft.namingPrefixes") ||
					e.affectsConfiguration("bpmsoft.expectedMaintainers")
				) {
					packageOwnershipStatusBar.refresh();
					packageSettingsTree.refresh();
				}
			})
		);

		registerWatchers(context, folders, layouts, packagesTree);
		styleDiagnostics.refreshOpenDocuments();
		namingDiagnostics.refreshOpenDocuments();
		void namingIndex.refresh();
		outlineTree.refresh();
		void plainOutlineTree.refresh();
		schemaHistoryTree.refresh();
		void gitFlowStatusBar.refresh();
		packageOwnershipStatusBar.refresh();

		void preferIndexedCompletions();
		void rebuildWithProgress();
		void ensureDotnetSolution(layouts);
		const active = vscode.window.activeTextEditor?.document;
		if (active?.languageId === "csharp") {
			void maybeOfferCsharpExtension(context);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		void vscode.window.showErrorMessage(
			`BPMSoft IntelliSense не запустилось: ${message}`
		);
		throw err;
	}
}

/** Any file living directly in a `Pkg/{Package}/Schemas/{Name}/` folder —
 * `touchSchemaModifiedOnUtc` only makes sense for these (a real, owned
 * schema's own descriptor.json lives right there); everything else
 * (`Resources/ui/BPMSoft`, top-level `Autogenerated/Src`, a boxed package's
 * own `Autogenerated/Src`, …) has no such descriptor to touch. */
function isPkgSchemaFile(normalizedPath: string): boolean {
	return /\/Pkg\/[^/]+\/Schemas\/[^/]+\//i.test(normalizedPath);
}

function onWatchedFile(uri: vscode.Uri, deleted: boolean): void {
	const normalized = uri.fsPath.replace(/\\/g, "/");
	if (isNamingDiagnosticsTarget(uri.fsPath)) {
		void namingIndex.refreshFile(uri.fsPath);
	}
	if (/\/metadata\.json$/i.test(normalized)) {
		// A sibling of the schema's own descriptor.json, in the same
		// Schemas/{Name}/ folder — several checks read it directly (entity
		// columns, a Process diagram's elements, a UserTask's own
		// parameters), so it needs to re-trigger that schema's naming check
		// too, not just invalidate the SymbolIndex's cached entity/columns.
		const descriptorPath = path.join(path.dirname(uri.fsPath), "descriptor.json");
		void namingIndex.refreshFile(descriptorPath);
		touchSchemaModifiedOnUtc(descriptorPath);
		index.invalidateEntity(uri.fsPath);
		return;
	}
	if (/\/schemas\/[^/]+\/[^/]+\.less$/i.test(normalized)) {
		// Same folder as descriptor.json — the Module-type CSS-schema check
		// (near-empty .js + real .less) needs to re-run whenever the .less
		// content itself changes, even though .less isn't a naming target on
		// its own.
		const descriptorPath = path.join(path.dirname(uri.fsPath), "descriptor.json");
		void namingIndex.refreshFile(descriptorPath);
		touchSchemaModifiedOnUtc(descriptorPath);
		return;
	}
	if (/\/schemas\/[^/]+\/properties\.json$/i.test(normalized)) {
		// Same folder too — SchemaType lives here. No naming check reads it
		// directly and it's not real AMD JS, so nothing else to do besides
		// keeping ModifiedOnUtc current.
		touchSchemaModifiedOnUtc(path.join(path.dirname(uri.fsPath), "descriptor.json"));
		return;
	}
	if (/\/resource\.[^/]+\.xml$/i.test(normalized)) {
		// Same idea, one level removed: a resource file lives in a sibling
		// Resources/{Name}.{Suffix}/ folder, not next to descriptor.json, so
		// resolving the owning schema needs an actual lookup rather than a
		// plain path.dirname.
		const ownerDescriptor = findOwningSchemaDescriptor(uri.fsPath);
		if (ownerDescriptor) {
			void namingIndex.refreshFile(ownerDescriptor);
			touchSchemaModifiedOnUtc(ownerDescriptor);
		}
		index.invalidateEntity(uri.fsPath);
		return;
	}
	if (/\/descriptor\.json$/i.test(normalized)) {
		// Deliberately never touched here — touching this file's own
		// ModifiedOnUtc in response to a change *to this same file* would be
		// an immediate self-triggering loop (the write is itself a change
		// this same watcher reacts to).
		return;
	}
	if (/\.cs$/i.test(normalized)) {
		// A schema's own C# source doesn't feed the JS module index
		// (indexer.indexFile only understands AMD JS), but it's still a real
		// edit to the schema.
		if (isPkgSchemaFile(normalized)) {
			touchSchemaModifiedOnUtc(path.join(path.dirname(uri.fsPath), "descriptor.json"));
		}
		return;
	}
	if (isPkgSchemaFile(normalized)) {
		touchSchemaModifiedOnUtc(path.join(path.dirname(uri.fsPath), "descriptor.json"));
	}
	if (deleted) {
		indexer.removeFile(uri.fsPath);
		return;
	}
	void indexer.indexFile(uri.fsPath);
}

/** Rewrites just the `ModifiedOnUtc` value in a schema's own descriptor.json
 * to "now", in the same `.NET` wire format (`"\/Date(<ms>)\/"`) — called
 * whenever any file belonging to the schema changes (see `onWatchedFile`),
 * so the field stays a trustworthy signal of "this schema actually changed"
 * for `ModuleIndexer`'s owned-schema cache (`ownedSchemaCache.ts`) even in
 * a workflow that edits files directly and never goes through the BPMSoft
 * Designer/server, which is the only thing that would otherwise keep this
 * field current. A plain text replace, not JSON.parse+stringify — the
 * latter would reformat the whole file (whitespace, key order) on every
 * single save, turning every real edit into a noisy two-file diff instead
 * of the one-line date bump this is meant to be. No-op (doesn't write
 * anything) if the field isn't present in the expected shape, or the file
 * can't be read/written — this is a best-effort freshness signal, never
 * allowed to fail the save it's reacting to. */
function touchSchemaModifiedOnUtc(descriptorPath: string): void {
	try {
		const text = fs.readFileSync(descriptorPath, "utf8");
		const updated = text.replace(
			/("ModifiedOnUtc"\s*:\s*")\\\/Date\(\d+\)\\\/(")/,
			`$1\\/Date(${Date.now()})\\/$2`
		);
		if (updated !== text) {
			fs.writeFileSync(descriptorPath, updated, "utf8");
		}
	} catch {
		// best-effort — see doc comment
	}
}

/** Every watcher below is rooted at a specific resolved layout subfolder
 * (`layout.pkgRoot`/`resourcesRoot`/`autogeneratedRoot`/`confContent` — all
 * absolute paths, and `RelativePattern` accepts a plain path string as its
 * base just as well as a `WorkspaceFolder`), never at the raw opened
 * workspace folder. This matters because every pattern here starts with
 * `**`: VS Code can't narrow a leading-`**` pattern to a subtree on its
 * own, so a `RelativePattern(rawWorkspaceFolder, "**\/Pkg/**\/Schemas/**\/*.js")`
 * forces it to set up a *recursive native watch over the entire opened
 * folder* and filter matches in-process. For `BPMSoft.Configuration/Pkg`
 * alone that's a few thousand files (fine) — but `lavka`'s workspace root
 * is a full deployed install (86k+ files at the top level alone, DLLs/
 * runtimes/db dumps included). The previous version created 12 of these
 * unscoped recursive watches over that whole tree, which is almost
 * certainly what crashed/hung the extension host when lavka was opened at
 * its root. Scoping each watcher's base to the specific layout subfolder it
 * actually cares about keeps every native watch bounded to what it's
 * supposed to cover. */
function registerWatchers(
	context: vscode.ExtensionContext,
	folders: readonly vscode.WorkspaceFolder[] | undefined,
	layouts: ReturnType<typeof resolveAppLayouts>,
	packagesTree: PackagesTreeProvider
): void {
	if (!folders?.length) {
		return;
	}
	const watch = (
		base: string,
		glob: string,
		onCreate: (uri: vscode.Uri) => void,
		onChange: (uri: vscode.Uri) => void,
		onDelete: (uri: vscode.Uri) => void
	) => {
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(base, glob)
		);
		watcher.onDidCreate(onCreate);
		watcher.onDidChange(onChange);
		watcher.onDidDelete(onDelete);
		context.subscriptions.push(watcher);
	};
	const onSchemaFile = (uri: vscode.Uri) => onWatchedFile(uri, false);
	const onSchemaFileDeleted = (uri: vscode.Uri) => onWatchedFile(uri, true);

	for (const layout of layouts) {
		if (layout.pkgRoot) {
			const pkgGlobs = [
				"**/Schemas/**/*.js",
				"**/Schemas/**/metadata.json",
				"**/Schemas/**/properties.json",
				"**/Resources/**/resource.*.xml",
				"**/Schemas/**/descriptor.json",
				"**/Schemas/**/*.cs",
				"**/Schemas/**/*.less",
				"**/SqlScripts/**/descriptor.json",
				"**/Data/**/descriptor.json"
			];
			for (const glob of pkgGlobs) {
				watch(layout.pkgRoot, glob, onSchemaFile, onSchemaFile, onSchemaFileDeleted);
			}
			// Broad, structure-only watcher for the Packages tree — mirrors
			// standard Explorer's "mostly keeps up, occasionally needs a
			// re-open" auto-refresh rather than trying to track every file
			// precisely. Content-only changes don't need this (nothing about
			// the tree's shape changed), so only create/delete are wired.
			const packagesWatcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(layout.pkgRoot, "**")
			);
			packagesWatcher.onDidCreate(() => packagesTree.refresh());
			packagesWatcher.onDidDelete(() => packagesTree.refresh());
			context.subscriptions.push(packagesWatcher);
		}
		if (layout.autogeneratedRoot) {
			watch(
				path.join(layout.autogeneratedRoot, "Src"),
				"*.js",
				onSchemaFile,
				onSchemaFile,
				onSchemaFileDeleted
			);
		}
		if (layout.resourcesRoot) {
			watch(
				path.join(layout.resourcesRoot, "ui", "BPMSoft"),
				"**/*.js",
				onSchemaFile,
				onSchemaFile,
				onSchemaFileDeleted
			);
		}
		if (layout.confContent) {
			const confWatcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(layout.confContent, "*.js")
			);
			const onConfJs = (uri: vscode.Uri) => {
				index.invalidateEntity(uri.fsPath);
				if (/Module[^/]*\.js$/i.test(uri.fsPath.replace(/\\/g, "/"))) {
					void indexer.indexFile(uri.fsPath);
				}
			};
			confWatcher.onDidCreate(onConfJs);
			confWatcher.onDidChange(onConfJs);
			confWatcher.onDidDelete((uri) => {
				index.invalidateEntity(uri.fsPath);
				indexer.removeFile(uri.fsPath);
			});
			context.subscriptions.push(confWatcher);
		}
	}
}

/**
 * Workspace overrides beat user defaults that keep word/history suggestions on top.
 */
async function preferIndexedCompletions(): Promise<void> {
	const enabled = vscode.workspace
		.getConfiguration("bpmsoft")
		.get<boolean>("preferIndexedCompletions", true);
	if (!enabled || !vscode.workspace.workspaceFolders?.length) {
		return;
	}

	try {
		const jsEditor = vscode.workspace.getConfiguration("editor", {
			languageId: "javascript"
		});
		await jsEditor.update(
			"wordBasedSuggestions",
			"off",
			vscode.ConfigurationTarget.Workspace
		);
		await jsEditor.update(
			"suggestSelection",
			"first",
			vscode.ConfigurationTarget.Workspace
		);
		await jsEditor.update(
			"quickSuggestions",
			{ other: true, comments: false, strings: true },
			vscode.ConfigurationTarget.Workspace
		);

		await vscode.workspace
			.getConfiguration("javascript")
			.update("suggest.names", false, vscode.ConfigurationTarget.Workspace);
	} catch {
		// Workspace may be read-only; configurationDefaults still apply as fallback.
	}
}

/** `context.storageUri` (workspace-specific persistent storage — separate
 * per opened folder, so multiple BPMSoft installs never share a cache) is
 * where the `Resources/ui/BPMSoft`/`conf/content` platform index cache
 * lives (see `ModuleIndexer`/`platformIndexCache.ts`). `undefined` when no
 * workspace is open — `ModuleIndexer` treats a missing `cacheDir` as
 * "caching off", falling back to always parsing fresh (today's behavior). */
function ensurePlatformIndexCacheDir(context: vscode.ExtensionContext): string | undefined {
	const storageUri = context.storageUri;
	if (!storageUri) {
		return undefined;
	}
	try {
		fs.mkdirSync(storageUri.fsPath, { recursive: true });
		return storageUri.fsPath;
	} catch {
		return undefined;
	}
}

/** `forceFresh` bypasses the `Resources/ui/BPMSoft`/`conf/content` platform
 * cache entirely (see `ModuleIndexer.rebuild`'s own doc) — used by the
 * manual "Rebuild Index" command/button, so a deliberate re-index always
 * re-parses everything regardless of what the cache's fingerprint says. */
async function rebuildWithProgress(forceFresh = false): Promise<void> {
	if (forceFresh) {
		resetLocalizationCaches();
	}
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Window,
			title: "BPMSoft: indexing Pkg + Autogenerated + UI"
		},
		async (progress) => {
			const count = await indexer.rebuild(progress, forceFresh);
			const folders =
				vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];
			const layouts = supportedAppLayouts(resolveAppLayouts(folders));
			const kind = layouts.map((l) => l.kind).join("/") || "unknown";
			vscode.window.setStatusBarMessage(
				`BPMSoft: indexed ${count} modules (${kind})`,
				5000
			);
			diagnostics.refreshOpenDocuments();
			styleDiagnostics.refreshOpenDocuments();
			namingDiagnostics.refreshOpenDocuments();
			void namingIndex.refresh();
			outlineTree.refresh();
			void plainOutlineTree.refresh();
			schemaHistoryTree.refresh();
		}
	);
}

export function deactivate(): void {
	index?.clearAll();
}