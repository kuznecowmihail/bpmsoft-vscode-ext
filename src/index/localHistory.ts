import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { parseJsonNoBom } from "../textUtils";

export interface LocalHistoryEntry {
	id: string;
	timestamp: number;
	source?: string;
	/** Absolute path to the stored snapshot's plain-text content — a real
	 * file on disk, so it can be used directly as one side of `vscode.diff`
	 * without any custom content provider. */
	contentPath: string;
}

interface HistoryManifest {
	resource?: string;
	entries?: { id: string; timestamp: number; source?: string }[];
}

const MIN_RESCAN_INTERVAL_MS = 30_000;

/**
 * Reads VS Code's own "Local History" snapshots (auto-saved on every file
 * save, unrelated to git) directly from its on-disk storage — there is no
 * public extension API for this (see the open feature request on
 * microsoft/vscode), so this is inherently built on an undocumented,
 * unversioned-by-us internal format.
 *
 * Fail-safe by design: any STRUCTURAL problem (can't locate the History
 * folder, can't read it at all) permanently disables this store for the
 * rest of the session after exactly one warning — no retries, no repeated
 * scanning. A problem with one individual file's manifest, by contrast,
 * just means that one file quietly has no local history shown; it does not
 * disable the feature for everything else.
 */
export class LocalHistoryStore {
	private disabled = false;
	private notifiedOnce = false;
	private historyRoot: string | undefined;
	private resourceToFolder = new Map<string, string>();
	private lastScanAt = 0;
	private scanPromise: Promise<void> | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {}

	get isDisabled(): boolean {
		return this.disabled;
	}

	async getEntriesForFile(filePath: string): Promise<LocalHistoryEntry[]> {
		if (this.disabled) {
			return [];
		}
		const root = this.ensureHistoryRoot();
		if (!root) {
			return [];
		}
		const targetResource = vscode.Uri.file(filePath).toString();
		const folder = await this.findFolderForResource(root, targetResource);
		if (!folder) {
			return [];
		}
		// Always re-read fresh (not cached) — the folder→resource mapping is
		// stable once known, but its entries.json keeps growing as the user
		// keeps saving that file.
		try {
			const manifest = await readManifest(path.join(folder, "entries.json"));
			return (manifest?.entries || []).map((e) => ({
				id: e.id,
				timestamp: e.timestamp,
				source: e.source,
				contentPath: path.join(folder, e.id)
			}));
		} catch {
			// This one file's manifest is unreadable/corrupt — not a
			// structural problem, just no local history for it.
			return [];
		}
	}

	/** `context.globalStorageUri` (`.../User/globalStorage/<our-id>`) is the
	 * one OS/profile/portable-install-independent path we're actually given
	 * — `History` sits right next to `globalStorage` under the same `User/`
	 * folder, so deriving it this way avoids hardcoding `%APPDATA%`/
	 * `~/.config`/... ourselves. */
	private ensureHistoryRoot(): string | undefined {
		if (this.historyRoot !== undefined) {
			return this.historyRoot;
		}
		try {
			const globalStorage = this.context.globalStorageUri.fsPath;
			const userRoot = path.dirname(path.dirname(globalStorage));
			const root = path.join(userRoot, "History");
			this.historyRoot = root;
			return root;
		} catch {
			this.trip("не удалось определить путь к папке Local History");
			return undefined;
		}
	}

	private async findFolderForResource(root: string, targetResource: string): Promise<string | undefined> {
		const cached = this.resourceToFolder.get(targetResource);
		if (cached) {
			return cached;
		}
		const now = Date.now();
		if (now - this.lastScanAt < MIN_RESCAN_INTERVAL_MS && this.lastScanAt !== 0) {
			// Scanned recently and still came up empty for this file — most
			// likely it genuinely has no local history yet. Don't re-scan
			// 1000+ folders on every miss; wait out the cooldown instead.
			return undefined;
		}
		if (!this.scanPromise) {
			this.scanPromise = this.rebuildCache(root).finally(() => {
				this.scanPromise = undefined;
			});
		}
		await this.scanPromise;
		return this.resourceToFolder.get(targetResource);
	}

	private async rebuildCache(root: string): Promise<void> {
		let dirents: fs.Dirent[];
		try {
			dirents = await fs.promises.readdir(root, { withFileTypes: true });
		} catch {
			this.trip("папка Local History недоступна");
			return;
		}
		const map = new Map<string, string>();
		for (const entry of dirents) {
			if (!entry.isDirectory()) {
				continue;
			}
			const folder = path.join(root, entry.name);
			try {
				const manifest = await readManifest(path.join(folder, "entries.json"));
				if (manifest?.resource) {
					map.set(manifest.resource, folder);
				}
			} catch {
				// One bad folder — skip it, keep scanning the rest.
				continue;
			}
		}
		this.resourceToFolder = map;
		this.lastScanAt = Date.now();
	}

	private trip(reason: string): void {
		if (this.disabled) {
			return;
		}
		this.disabled = true;
		if (!this.notifiedOnce) {
			this.notifiedOnce = true;
			void vscode.window.showWarningMessage(
				`BPMSoft: интеграция с Local History отключена (${reason}). Git History продолжит работать как обычно.`
			);
		}
	}
}

async function readManifest(manifestPath: string): Promise<HistoryManifest | undefined> {
	const text = await fs.promises.readFile(manifestPath, "utf8");
	const parsed = parseJsonNoBom<HistoryManifest>(text);
	return parsed && typeof parsed === "object" ? parsed : undefined;
}
