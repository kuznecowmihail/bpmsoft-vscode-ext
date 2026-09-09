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
import { CsharpCompletionProvider } from "./providers/CsharpCompletionProvider";
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
import { findOwningSchemaDescriptor, findSchemaDirForAnyPath } from "./index/schemaResourceLookup";
import { LocalizationWizardPanel } from "./providers/LocalizationWizardPanel";
import { PackagesTreeProvider } from "./providers/PackagesTreeProvider";
import { NamingDecorationProvider } from "./providers/NamingDecorationProvider";
import { ViewModelOutlineProvider } from "./providers/ViewModelOutlineProvider";
import { GitFlowStatusBar } from "./providers/GitFlowStatusBar";
import { PackageOwnershipStatusBar } from "./providers/PackageOwnershipStatusBar";
import { IndexingStatusBar } from "./providers/IndexingStatusBar";
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
import { AppConfigTreeProvider, EDIT_CONFIG_ENTRY_COMMAND } from "./providers/AppConfigTreeProvider";
import {
	CONFIGURE_WORKSPACE_CONSOLE_COMMAND,
	DevModeTreeProvider,
	TOGGLE_DEBUGGING_COMMAND,
	TOGGLE_FILE_DESIGN_MODE_COMMAND
} from "./providers/DevModeTreeProvider";
import { ConfigFileWizardPanel } from "./providers/ConfigFileWizardPanel";
import { NlogTargetsWizardPanel } from "./providers/NlogTargetsWizardPanel";
import { NlogRulesWizardPanel } from "./providers/NlogRulesWizardPanel";
import { getDebuggingEnabled, getFileDesignModeEnabled, resolveWebHostConfigPath, setDebugging, setFileDesignMode } from "./index/devModeSettings";
import { autoConfigureWorkspaceConsole, getWorkspaceConsoleStatus } from "./index/workspaceConsoleSetup";
import { AppConfigEntry } from "./index/appConfigDiscovery";

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
		const indexingStatusBar = new IndexingStatusBar();
		indexer = new ModuleIndexer(index, cacheDir, context.extension.packageJSON.version, indexingStatusBar);
		diagnostics = new MissingMemberDiagnostics(index);
		styleDiagnostics = new StyleDiagnostics(index);
		namingDiagnostics = new NamingDiagnostics(index);
		namingIndex = new NamingIssuesIndex(index, cacheDir, context.extension.packageJSON.version, indexingStatusBar);
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
		updateActiveSchemaContext(vscode.window.activeTextEditor);
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
		const csharpCompletionProvider = new CsharpCompletionProvider(index);

		const gitFlowCandidateRoots = layouts
			.map((l) => l.pkgRoot || l.configurationRoot || l.appRoot || l.workspaceRoot)
			.filter((p): p is string => Boolean(p));
		const gitFlowStatusBar = new GitFlowStatusBar(gitFlowCandidateRoots);
		const packageOwnershipStatusBar = new PackageOwnershipStatusBar();
		const packageSettingsTree = new PackageSettingsTreeProvider();
		const appRoots = Array.from(
			new Set(layouts.map((l) => l.appRoot).filter((p): p is string => Boolean(p)))
		);
		const envConfigTree = new AppConfigTreeProvider(appRoots);
		const devModeTree = new DevModeTreeProvider(appRoots);

		// One-shot-per-session heads-up (not persisted across restarts) — the
		// same status/action also lives permanently in the Dev Mode tree
		// (DevModeTreeProvider's "workspaceConsole" node), this just makes it
		// unlikely to go unnoticed since it's easy to never scroll to that view.
		void (async () => {
			for (const appRoot of appRoots) {
				const status = getWorkspaceConsoleStatus(appRoot);
				if (!status.applicable || status.configured) {
					continue;
				}
				const actionLabel = "Настроить автоматически";
				const choice = await vscode.window.showWarningMessage(
					`Workspace Console не настроена (${path.basename(appRoot)}) — строки подключения отличаются от главного ConnectionStrings.config`,
					actionLabel
				);
				if (choice === actionLabel) {
					await vscode.commands.executeCommand(CONFIGURE_WORKSPACE_CONSOLE_COMMAND, appRoot);
				}
			}
		})();

		context.subscriptions.push(
			indexingStatusBar,
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
			vscode.commands.registerCommand("bpmsoft.formatting.showHelp", () => {
				void vscode.window.showInformationMessage(
					"Formatting — форматтер BPMSoft по умолчанию",
					{
						modal: true,
						detail:
							"Здесь можно сделать расширение BPMSoft форматтером по умолчанию " +
							"для JavaScript, C# и SQL — оно форматирует по конвенциям " +
							"команды (Allman/K&R, var/let/const и т.д.), а не по общим " +
							"настройкам VS Code.\n\n" +
							"У каждого языка своя строка: зелёная галочка означает, что " +
							"BPMSoft уже форматтер по умолчанию для него; иначе показано, " +
							"что задано сейчас. Клик по строке делает BPMSoft форматтером " +
							"по умолчанию (настройка сохраняется на уровне рабочей области)."
					}
				);
			}),
			vscode.languages.registerCompletionItemProvider(
				jsSelector,
				completionProvider,
				".",
				"$",
				"\"",
				"'",
				"(",
				"[",
				":"
			),
			vscode.languages.registerCompletionItemProvider(
				csharpSelector,
				csharpCompletionProvider,
				".",
				"\"",
				"'",
				"(",
				"[",
				":"
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
				new CsharpHoverProvider(index)
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
				touchSchemaModifiedOnUtcForSavedFile(fsPath);
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
			vscode.commands.registerCommand("bpmsoft.packageSettings.showHelp", () => {
				void vscode.window.showInformationMessage(
					"Package Settings — локальные аналоги системных настроек BPMSoft",
					{
						modal: true,
						detail:
							"Расширение не подключается к БД, поэтому три системные " +
							"настройки, которые нужны перед началом работы над пакетом, " +
							"задаются здесь вручную и хранятся в настройках рабочей области:\n\n" +
							"• Текущий пакет — аналог «CurrentPackageId», используется только " +
							"как справочная информация.\n" +
							"• Префикс пакетов/схем — аналог «SchemaNamePrefix» (через " +
							"запятую, если пакетов несколько).\n" +
							"• Издатель — аналог «Maintainer».\n\n" +
							"Префикс и Издатель также используются проверкой владения " +
							"пакетом (строка состояния и предупреждения о нейминге) — если " +
							"они не заполнены или заполнены неверно, эти проверки будут " +
							"молчать или ошибаться. Клик по строке открывает поле ввода."
					}
				);
			}),
			vscode.window.registerTreeDataProvider("bpmsoftEnvConfig", envConfigTree),
			vscode.commands.registerCommand(EDIT_CONFIG_ENTRY_COMMAND, (entry: AppConfigEntry) => {
				if (entry.kind === "nlogTargets") {
					NlogTargetsWizardPanel.show(entry);
				} else if (entry.kind === "nlogRules") {
					NlogRulesWizardPanel.show(entry);
				} else {
					ConfigFileWizardPanel.show(entry);
				}
			}),
			vscode.commands.registerCommand("bpmsoft.envConfig.refresh", () => {
				envConfigTree.refresh();
			}),
			vscode.commands.registerCommand("bpmsoft.envConfig.showHelp", () => {
				void vscode.window.showInformationMessage(
					"Config Files — мастера для ConnectionStrings/appSettings/appsettings.json/nlog.config",
					{
						modal: true,
						detail:
							"Список найденных в корне приложения (не в Pkg) файлов " +
							"деплоя — ConnectionStrings.config, appsettings.json, любой " +
							"*.dll.config (в т.ч. в WorkspaceConsole) со своим блоком " +
							"<connectionStrings>/<appSettings>, и nlog.config (+ " +
							"включаемый nlog.targets.config, + отдельный " +
							"WorkspaceConsole\\*.nlog.config) — отдельно Variables, " +
							"Extensions, Targets, Rules. Клик по строке открывает " +
							"таблицу вместо ручного поиска нужной записи в большом " +
							"XML/JSON.\n\n" +
							"Значения строк подключения и ключи вида *Password*/*Secret* " +
							"по умолчанию скрыты — показ по иконке-глазку. Таргеты NLog " +
							"редактируются как XML целиком (у NLog 115+ типов таргетов " +
							"с разными наборами атрибутов) — тип подставляется из " +
							"справочника NLog с описанием, а не угадыванием. Правки " +
							"пишутся точечно (только изменённая запись), остальной файл " +
							"не переформатируется."
					}
				);
			}),
			vscode.window.registerTreeDataProvider("bpmsoftDevMode", devModeTree),
			vscode.commands.registerCommand(TOGGLE_FILE_DESIGN_MODE_COMMAND, async (appRoot: string) => {
				const filePath = resolveWebHostConfigPath(appRoot);
				if (!filePath) {
					return;
				}
				const currentlyEnabled = getFileDesignModeEnabled(filePath) ?? false;
				const actionLabel = currentlyEnabled ? "Выключить" : "Включить";
				const choice = await vscode.window.showWarningMessage(
					currentlyEnabled
						? "Выключить режим разработки в файловой системе? UseStaticFileContent будет включён обратно."
						: "Включить режим разработки в файловой системе? UseStaticFileContent при этом будет выключен (несовместим с этим режимом).",
					actionLabel
				);
				if (choice !== actionLabel) {
					return;
				}
				const result = setFileDesignMode(filePath, !currentlyEnabled);
				if (!result.ok) {
					void vscode.window.showErrorMessage(result.error ?? "Не удалось изменить настройку");
					return;
				}
				devModeTree.refresh();
				void vscode.window.showInformationMessage(
					currentlyEnabled ? "Режим разработки в файловой системе выключен" : "Режим разработки в файловой системе включён"
				);
			}),
			vscode.commands.registerCommand(TOGGLE_DEBUGGING_COMMAND, async (appRoot: string) => {
				const filePath = resolveWebHostConfigPath(appRoot);
				if (!filePath) {
					return;
				}
				const currentlyEnabled = getDebuggingEnabled(filePath);
				const actionLabel = currentlyEnabled ? "Выключить" : "Включить";
				const choice = await vscode.window.showWarningMessage(
					currentlyEnabled ? "Выключить отладку в VS Code (LoadAssemblyFromByteArray=true)?" : "Включить отладку в VS Code (LoadAssemblyFromByteArray=false)?",
					actionLabel
				);
				if (choice !== actionLabel) {
					return;
				}
				const result = setDebugging(filePath, !currentlyEnabled);
				if (!result.ok) {
					void vscode.window.showErrorMessage(result.error ?? "Не удалось изменить настройку");
					return;
				}
				devModeTree.refresh();
				void vscode.window.showInformationMessage(currentlyEnabled ? "Отладка в VS Code выключена" : "Отладка в VS Code включена");
			}),
			vscode.commands.registerCommand(CONFIGURE_WORKSPACE_CONSOLE_COMMAND, async (appRoot: string) => {
				const status = getWorkspaceConsoleStatus(appRoot);
				if (!status.applicable || status.mismatches.length === 0) {
					void vscode.window.showInformationMessage("Workspace Console настроена");
					return;
				}
				const detail = status.mismatches
					.map((m) => `${m.name} (${m.fileLabel}):\n  было: ${m.consoleValue}\n  станет: ${m.mainValue}`)
					.join("\n\n");
				const actionLabel = "Настроить автоматически";
				const choice = await vscode.window.showWarningMessage(
					"Настроить Workspace Console автоматически по данным из ConnectionStrings.config?",
					{ modal: true, detail },
					actionLabel
				);
				if (choice !== actionLabel) {
					return;
				}
				const result = autoConfigureWorkspaceConsole(appRoot);
				if (!result.ok) {
					void vscode.window.showErrorMessage(result.error ?? "Не удалось настроить Workspace Console");
					return;
				}
				devModeTree.refresh();
				void vscode.window.showInformationMessage("Workspace Console настроена");
			}),
			vscode.commands.registerCommand("bpmsoft.devMode.refresh", () => {
				devModeTree.refresh();
			}),
			vscode.commands.registerCommand("bpmsoft.devMode.showHelp", () => {
				void vscode.window.showInformationMessage(
					"Dev Mode — переключатели режима разработки и статус Workspace Console",
					{
						modal: true,
						detail:
							"Режим разработки в файловой системе — <fileDesignMode enabled=.../> " +
							"в BPMSoft.WebHost.dll.config/Web.config; включение одновременно " +
							"выключает UseStaticFileContent (несовместим с этим режимом), " +
							"выключение включает обратно.\n\n" +
							"Отладка в VS Code — appSetting LoadAssemblyFromByteArray (по " +
							"мотивам _enableDebugging.bat/_disableDebugging.bat): false — " +
							"отладка работает, true — сборки грузятся из памяти и отладчик " +
							"не может сопоставить их с исходниками.\n\n" +
							"Workspace Console — сверяет <connectionStrings> каждого " +
							"WorkspaceConsole\\*.dll.config с главным ConnectionStrings.config " +
							"по именам записей, которые есть в обоих файлах (WorkspaceConsole " +
							"никогда не читает ConnectionStrings.config напрямую, поэтому они " +
							"легко расходятся). «Настроить автоматически» копирует значения " +
							"из главного файла.\n\n" +
							"Каждая строка кликабельна и переключает/чинит своё состояние " +
							"(со спросом подтверждения)."
					}
				);
			}),
			...appRoots.flatMap((appRoot) =>
				[
					"ConnectionStrings.config",
					"appsettings.json",
					"*.dll.config",
					"Web.config",
					"WorkspaceConsole/*.dll.config",
					"nlog.config",
					"nlog.targets.config",
					"WorkspaceConsole/*.nlog.config"
				].map(
					(rel) => {
						const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(appRoot, rel));
						const refreshBoth = () => {
							envConfigTree.refresh();
							devModeTree.refresh();
						};
						watcher.onDidChange(refreshBoth);
						watcher.onDidCreate(refreshBoth);
						watcher.onDidDelete(refreshBoth);
						return watcher;
					}
				)
			),
			vscode.commands.registerCommand(
				"bpmsoft.editLocalizedStrings",
				(node?: { name?: string; path?: string; key?: string }) => {
					const schema = resolveWizardSchema(node);
					if (!schema) {
						void vscode.window.showWarningMessage(
							"Откройте файл схемы (.cs/.js) или выберите схему в дереве пакетов"
						);
						return;
					}
					LocalizationWizardPanel.show("strings", schema.schemaDir, schema.schemaName, node?.key);
				}
			),
			vscode.commands.registerCommand(
				"bpmsoft.editLocalizedImages",
				(node?: { name?: string; path?: string; key?: string }) => {
					const schema = resolveWizardSchema(node);
					if (!schema) {
						void vscode.window.showWarningMessage(
							"Откройте файл схемы (.cs/.js) или выберите схему в дереве пакетов"
						);
						return;
					}
					if (!fs.existsSync(path.join(schema.schemaDir, `${schema.schemaName}.js`))) {
						void vscode.window.showWarningMessage("Локализуемые изображения доступны только для JS-схем");
						return;
					}
					LocalizationWizardPanel.show("images", schema.schemaDir, schema.schemaName, node?.key);
				}
			),
			vscode.window.onDidChangeActiveTextEditor(updateActiveSchemaContext),
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
		outlineTree.refresh();
		void plainOutlineTree.refresh();
		schemaHistoryTree.refresh();
		void gitFlowStatusBar.refresh();
		packageOwnershipStatusBar.refresh();

		void preferIndexedCompletions();
		// `rebuildWithProgress` runs `namingIndex.refresh()` itself, after
		// `indexer.rebuild()` — sequenced on purpose (some naming checks,
		// e.g. `findingsForClientSchemaText`'s MODULE-schema check, query
		// `index.hierarchy`, which is only populated once the rebuild
		// completes). A separate `void namingIndex.refresh()` used to also
		// fire right here, racing this one — same cache, same status bar,
		// just two full workspace scans running concurrently for no benefit.
		void rebuildWithProgress();
		void ensureDotnetSolution(layouts);
		const active = vscode.window.activeTextEditor?.document;
		if (active?.languageId === "csharp") {
			void maybeOfferCsharpExtension(context);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		void vscode.window.showErrorMessage(
			`BPMSoft Toolkit не запустилось: ${message}`
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
		return;
	}
	if (/\/schemas\/[^/]+\/properties\.json$/i.test(normalized)) {
		// Same folder too — SchemaType lives here. No naming check reads it
		// directly, and ModifiedOnUtc-touching now lives solely in the
		// `onDidSaveTextDocument` handler (see `touchSchemaModifiedOnUtc`'s
		// own doc) — so a disk-level change to this file has nothing left to
		// react to here.
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
		}
		index.invalidateEntity(uri.fsPath);
		return;
	}
	if (/\/descriptor\.json$/i.test(normalized)) {
		return;
	}
	if (/\.cs$/i.test(normalized)) {
		// A schema's own C# source doesn't feed the JS module index
		// (indexer.indexFile only understands AMD JS) — nothing else to do
		// here; ModifiedOnUtc is bumped by the `onDidSaveTextDocument`
		// handler instead.
		return;
	}
	if (deleted) {
		indexer.removeFile(uri.fsPath);
		return;
	}
	void indexer.indexFile(uri.fsPath);
}

/** Resolves the schema a localization-wizard command should act on: the
 * `PackagesTreeProvider` schema node it was invoked from (`view/item/context`
 * — carries `name`/`path` directly, no filesystem lookup needed), a hover's
 * own command link (carries `name`/`path`/`key` — see `platformLookup.ts`'s
 * `editLocalizedStringLink`/`editLocalizedImageLink`), or, when invoked with
 * no argument (command palette / editor toolbar / editor context menu), the
 * active editor's own file via `findSchemaDirForAnyPath` — covers both a
 * schema's own `.js`/`.cs`/`metadata.json`/`descriptor.json` *and* one of its
 * `Resources/{Name}.{Suffix}/resource.{culture}.xml` files opened directly
 * (real complaint: those live under a sibling `Resources/` folder, not
 * `Schemas/`, so the plain `findSchemaDir` this used originally left the
 * toolbar button/context-menu entry missing for exactly the files a dev
 * would most expect them on while translating). `undefined` when neither is
 * available. */
function resolveWizardSchema(
	node?: { name?: string; path?: string }
): { schemaDir: string; schemaName: string } | undefined {
	if (node?.name && node?.path) {
		return { schemaDir: node.path, schemaName: node.name };
	}
	const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
	return activePath ? findSchemaDirForAnyPath(activePath) : undefined;
}

/** Drives the `bpmsoftActiveSchema`/`bpmsoftActiveSchemaIsJs` `when`-clause
 * context keys the editor toolbar/context-menu buttons for the localization
 * wizards are gated on (`package.json`'s `editor/title`/`editor/context`) —
 * plain `resourceLangId == javascript` would light the button up for *any*
 * JS file in the workspace, not just a real package schema, which is
 * exactly the "unintuitive to find" complaint these buttons exist to fix in
 * the first place; scoping to a real schema (via `findSchemaDirForAnyPath`,
 * see `resolveWizardSchema`'s own doc for why that also covers resource XML
 * files) keeps them from becoming just as easy to miss amid irrelevant
 * noise. */
function updateActiveSchemaContext(editor: vscode.TextEditor | undefined): void {
	const schema = editor ? findSchemaDirForAnyPath(editor.document.uri.fsPath) : undefined;
	void vscode.commands.executeCommand("setContext", "bpmsoftActiveSchema", !!schema);
	void vscode.commands.executeCommand(
		"setContext",
		"bpmsoftActiveSchemaIsJs",
		!!schema && fs.existsSync(path.join(schema.schemaDir, `${schema.schemaName}.js`))
	);
}

/** Rewrites just the `ModifiedOnUtc` value in a schema's own descriptor.json
 * to "now", in the same `.NET` wire format (`"\/Date(<ms>)\/"`) — called only
 * from the `onDidSaveTextDocument` handler below (via
 * `touchSchemaModifiedOnUtcForSavedFile`), never from the disk-level
 * `FileSystemWatcher`-driven `onWatchedFile`, so the field stays a
 * trustworthy signal of "the user actually edited this schema" for
 * `ModuleIndexer`'s owned-schema cache (`ownedSchemaCache.ts`) even in a
 * workflow that edits files directly and never goes through the BPMSoft
 * Designer/server, which is the only thing that would otherwise keep this
 * field current. Deliberately NOT wired to the raw disk watcher: that fires
 * for any change to the file regardless of who made it, so a `git checkout`/
 * `pull`/`stash pop`, or an external tool (e.g. `WorkspaceConsole` pushing a
 * build down from a container, §1 of the BPMSoft master guide) touching
 * dozens of schemas at once would each rewrite the schema's descriptor.json
 * even though the user never edited anything — leaving a routine git
 * operation looking dirty, and risking those bogus timestamp bumps getting
 * committed. A real editor save is the one signal that's actually "the user
 * changed this". A plain text replace, not JSON.parse+stringify — the
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

/** Resolves which schema's descriptor.json (if any) a just-*saved* file
 * should bump `ModifiedOnUtc` for, and does it — mirrors `onWatchedFile`'s
 * old dispatch order (metadata.json / .less / properties.json / resource
 * xml / descriptor.json itself, excluded / any other file directly in a
 * `Schemas/{Name}/` folder), but is only ever called from
 * `onDidSaveTextDocument`, see `touchSchemaModifiedOnUtc`'s own doc for why
 * that distinction matters. */
function touchSchemaModifiedOnUtcForSavedFile(fsPath: string): void {
	const normalized = fsPath.replace(/\\/g, "/");
	if (/\/descriptor\.json$/i.test(normalized)) {
		// Same self-triggering-loop concern as `onWatchedFile` — saving this
		// file should never rewrite its own ModifiedOnUtc a second time.
		return;
	}
	if (/\/metadata\.json$/i.test(normalized) || /\/schemas\/[^/]+\/[^/]+\.less$/i.test(normalized)) {
		touchSchemaModifiedOnUtc(path.join(path.dirname(fsPath), "descriptor.json"));
		return;
	}
	if (/\/schemas\/[^/]+\/properties\.json$/i.test(normalized)) {
		touchSchemaModifiedOnUtc(path.join(path.dirname(fsPath), "descriptor.json"));
		return;
	}
	if (/\/resource\.[^/]+\.xml$/i.test(normalized)) {
		const ownerDescriptor = findOwningSchemaDescriptor(fsPath);
		if (ownerDescriptor) {
			touchSchemaModifiedOnUtc(ownerDescriptor);
		}
		return;
	}
	if (isPkgSchemaFile(normalized)) {
		touchSchemaModifiedOnUtc(path.join(path.dirname(fsPath), "descriptor.json"));
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
			void namingIndex.refresh(forceFresh);
			outlineTree.refresh();
			void plainOutlineTree.refresh();
			schemaHistoryTree.refresh();
		}
	);
}

export function deactivate(): void {
	index?.clearAll();
}