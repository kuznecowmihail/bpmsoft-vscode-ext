/**
 * Live progress sink for the two bulk workspace scans (`ModuleIndexer.rebuild`
 * and `NamingIssuesIndex.refresh`) — implemented by `IndexingStatusBar`
 * (`providers/`). Declared here, not in `providers/`, so `index/` doesn't
 * depend upward on `providers/`; `IndexingStatusBar` depends on this instead,
 * matching the existing direction (providers depend on index, never the
 * reverse).
 */
export interface IndexingProgressReporter {
	startModules(total: number): void;
	reportModuleProgress(done: number, total: number, currentFile?: string): void;
	finishModules(count: number, durationMs: number): void;

	startNaming(total: number): void;
	reportNamingProgress(done: number, total: number): void;
	finishNaming(findingCount: number, durationMs: number): void;
}
