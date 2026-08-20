import * as fs from "fs";
import { IndexedMember, IndexedModule, IndexedSchemaMessage, PlatformStubMember, memberDedupeKey, schemaMessageSupports } from "./types";
import {
	NO_ENTITY_COLUMN_SCHEMA_TYPES,
	SchemaHierarchyResolver
} from "./schemaHierarchy";
import { parseAmdModule, parseEntityColumns } from "../parse/amdParser";
import {
	entityColumnDocumentation,
	loadEntityColumnCaptions,
	parsePkgEntityColumns
} from "../parse/entityMetadata";
import { buildSandboxStubs } from "../stubs/sandboxGlobals";
import {
	inheritdocTarget,
	isPageSchema,
	mixinIndexKeys,
	normalizeFilePath,
	packageLabel,
	preferPkgHit,
	schemaOriginKey
} from "./modulePaths";

const MAX_INHERIT_DEPTH = 25;
const BASE_MODAL_BOX_PAGE = "BaseModalBoxPage";
const MODAL_BOX_SCHEMA_MODULE = "ModalBoxSchemaModule";

/**
 * In-memory symbol index for AMD modules and platform stubs.
 */
export class SymbolIndex {
	private modulesByName = new Map<string, IndexedModule[]>();
	private modulesByPath = new Map<string, IndexedModule>();
	private alternateToModules = new Map<string, IndexedModule[]>();
	private platformRoot: PlatformStubMember[] = [];
	private extRoot: PlatformStubMember[] = [];
	private sandboxMembers: IndexedMember[] = [];
	private sandboxOrigin?: { filePath: string; position: { line: number; character: number } };
	private coreMessages: IndexedSchemaMessage[] = [];
	private workspaceRoots: string[] = [];
	private entityCache = new Map<string, IndexedModule | null>();
	private mixinKeyToHostPaths = new Map<string, Set<string>>();
	readonly hierarchy = new SchemaHierarchyResolver();

	setPlatformStubs(members: PlatformStubMember[]): void {
		this.platformRoot = members;
	}

	setExtStubs(members: PlatformStubMember[]): void {
		this.extRoot = members;
	}

	setSandboxStubs(
		members: IndexedMember[],
		origin?: { filePath: string; position: { line: number; character: number } }
	): void {
		this.sandboxMembers = members;
		this.sandboxOrigin = origin;
	}

	setCoreMessages(messages: IndexedSchemaMessage[]): void {
		this.coreMessages = messages;
	}

	setWorkspaceRoots(roots: string[]): void {
		this.workspaceRoots = roots;
		this.hierarchy.setWorkspaceRoots(roots);
		this.entityCache.clear();
	}

	clearModules(): void {
		this.modulesByName.clear();
		this.modulesByPath.clear();
		this.alternateToModules.clear();
		this.entityCache.clear();
		this.mixinKeyToHostPaths.clear();
	}

	/** Drop every in-memory index (modules, stubs, hierarchy). */
	clearAll(): void {
		this.clearModules();
		this.platformRoot = [];
		this.extRoot = [];
		this.sandboxMembers = [];
		this.sandboxOrigin = undefined;
		this.coreMessages = [];
		this.workspaceRoots = [];
		this.hierarchy.clear();
	}

	invalidateEntity(filePath: string): void {
		const norm = normalizeFilePath(filePath);
		const meta = norm.match(/\/Schemas\/([^/]+)\/metadata\.json$/i);
		if (meta) {
			this.entityCache.delete(meta[1]);
			return;
		}
		const entityRes = norm.match(/\/Resources\/([^/]+)\.Entity\//i);
		if (entityRes) {
			this.entityCache.delete(entityRes[1]);
			return;
		}
		const base = norm.split("/").pop() || "";
		const name = base.replace(/\.js$/i, "");
		if (name && name.toLowerCase() !== "metadata") {
			this.entityCache.delete(name);
		}
	}

	upsertModule(mod: IndexedModule): void {
		this.removeByPath(mod.filePath);
		this.modulesByPath.set(mod.filePath, mod);
		this.pushNamed(this.modulesByName, mod.name, mod);
		if (mod.className && mod.className !== mod.name) {
			this.pushNamed(this.modulesByName, mod.className, mod);
		}
		if (mod.alternateClassName) {
			this.pushNamed(this.alternateToModules, mod.alternateClassName, mod);
			const short = mod.alternateClassName.replace(/^BPMSoft\./, "");
			this.pushNamed(this.alternateToModules, short, mod);
			this.pushNamed(this.alternateToModules, mod.name, mod);
		}
		if (mod.className) {
			this.pushNamed(this.alternateToModules, mod.className, mod);
		}
		this.indexMixinHost(mod);
	}

	removeByPath(filePath: string): void {
		const prev = this.modulesByPath.get(filePath);
		if (!prev) {
			return;
		}
		this.unindexMixinHost(prev);
		this.modulesByPath.delete(filePath);
		this.pullNamed(this.modulesByName, prev.name, filePath);
		if (prev.className && prev.className !== prev.name) {
			this.pullNamed(this.modulesByName, prev.className, filePath);
		}
		if (prev.alternateClassName) {
			this.pullNamed(this.alternateToModules, prev.alternateClassName, filePath);
			this.pullNamed(
				this.alternateToModules,
				prev.alternateClassName.replace(/^BPMSoft\./, ""),
				filePath
			);
			this.pullNamed(this.alternateToModules, prev.name, filePath);
		}
		if (prev.className) {
			this.pullNamed(this.alternateToModules, prev.className, filePath);
		}
	}

	getAllByName(name: string): IndexedModule[] {
		if (!name) {
			return [];
		}
		const seen = new Map<string, IndexedModule>();
		const add = (list?: IndexedModule[]) => {
			if (!list) {
				return;
			}
			for (const m of list) {
				seen.set(m.filePath, m);
			}
		};
		add(this.modulesByName.get(name));
		add(this.alternateToModules.get(name));
		add(this.alternateToModules.get(name.replace(/^BPMSoft\./, "")));
		return Array.from(seen.values());
	}

	ensureModule(filePath: string): IndexedModule | undefined {
		const existing = this.modulesByPath.get(filePath);
		if (existing) {
			return existing;
		}
		try {
			const source = fs.readFileSync(filePath, "utf8");
			const mod = parseAmdModule(source, filePath);
			if (!mod) {
				return undefined;
			}
			this.upsertModule(mod);
			return mod;
		} catch {
			return undefined;
		}
	}

	resolveMembers(prefix: string, enablePlatformStubs: boolean): IndexedMember[] {
		const parts = prefix.split(".").filter(Boolean);
		if (parts.length === 0) {
			return [];
		}

		const full = parts.join(".");
		if (!(parts[0] === "BPMSoft" && parts.length === 1)) {
			const named = this.getAllByName(full);
			if (named.length) {
				return this.mergeMembers(named);
			}
		}

		if (parts[0] === "BPMSoft") {
			if (!enablePlatformStubs) {
				if (parts.length === 1) {
					return this.collectBpmsoftShortcuts();
				}
				const alt = `BPMSoft.${parts[1]}`;
				const mods = this.getAllByName(alt);
				if (mods.length && parts.length === 2) {
					return this.mergeMembers(mods);
				}
				return [];
			}
			return this.resolvePlatformPath(parts.slice(1));
		}

		if (parts[0] === "Ext") {
			return this.resolveExtPath(parts.slice(1));
		}

		const mods = this.getAllByName(parts[0]);
		if (!mods.length) {
			return [];
		}
		if (parts.length === 1) {
			return this.mergeMembers(mods);
		}
		return [];
	}

	private collectBpmsoftShortcuts(): IndexedMember[] {
		const out: IndexedMember[] = [];
		const seen = new Set<string>();
		for (const mod of this.modulesByPath.values()) {
			const alt = mod.alternateClassName;
			if (!alt?.startsWith("BPMSoft.")) {
				continue;
			}
			const short = alt.slice("BPMSoft.".length);
			if (!short || short.includes(".") || seen.has(short)) {
				continue;
			}
			seen.add(short);
			out.push({
				name: short,
				kind: "namespace",
				detail:
					mod.kind === "mixin"
						? "mixin"
						: mod.kind === "class"
							? "class"
							: "type",
				documentation: mod.filePath
			});
		}
		return out;
	}

	private resolveExtPath(rest: string[]): IndexedMember[] {
		if (!this.extRoot.length) {
			return [];
		}
		if (rest.length === 0) {
			return this.extRoot.map((s) => this.stubToMember(s));
		}
		const node = this.walkStubPath(this.extRoot, rest);
		if (node?.children?.length) {
			return node.children.map((c) => this.stubToMember(c));
		}
		return [];
	}

	private resolvePlatformPath(rest: string[]): IndexedMember[] {
		if (rest.length === 0) {
			const stubs = this.platformRoot.map((s) => this.stubToMember(s));
			const shortcuts = this.collectBpmsoftShortcuts();
			return this.mergeMemberLists(stubs, shortcuts);
		}
		const node = this.walkStubPath(this.platformRoot, rest);
		if (node?.children?.length) {
			return node.children.map((c) => this.stubToMember(c));
		}
		const mods = this.modulesNamed(
			`BPMSoft.${rest.join(".")}`,
			node ? rest[rest.length - 1] : rest.join(".")
		);
		return mods.length ? this.mergeMembers(mods) : [];
	}

	private walkStubPath(
		root: PlatformStubMember[],
		rest: string[]
	): PlatformStubMember | undefined {
		let current: PlatformStubMember[] | undefined = root;
		let node: PlatformStubMember | undefined;
		for (const part of rest) {
			node = current?.find((c) => c.name === part);
			if (!node) {
				return undefined;
			}
			current = node.children;
		}
		return node;
	}

	private modulesNamed(...names: string[]): IndexedModule[] {
		const seen = new Map<string, IndexedModule>();
		for (const name of names) {
			for (const mod of this.getAllByName(name)) {
				seen.set(mod.filePath, mod);
			}
		}
		return Array.from(seen.values());
	}

	private mergeMemberLists(...lists: IndexedMember[][]): IndexedMember[] {
		const map = new Map<string, IndexedMember>();
		for (const list of lists) {
			for (const m of list) {
				if (!map.has(m.name)) {
					map.set(m.name, m);
				}
			}
		}
		return Array.from(map.values());
	}

	private stubToMember(s: PlatformStubMember): IndexedMember {
		return {
			name: s.name,
			kind: s.kind,
			detail: s.detail,
			documentation: s.documentation,
			filePath: s.filePath,
			position: s.position
		};
	}

	private collectInheritanceChain(mod: IndexedModule): IndexedModule[] {
		const out: IndexedModule[] = [];
		const visitedNames = new Set<string>();
		let current: IndexedModule | undefined = mod;
		for (let depth = 0; depth < MAX_INHERIT_DEPTH && current; depth++) {
			const parentName: string | undefined = current.override || current.extend;
			if (!parentName || visitedNames.has(parentName)) {
				break;
			}
			visitedNames.add(parentName);
			const currentPath = current.filePath;
			const candidates: IndexedModule[] = this.getAllByName(parentName).filter(
				(m: IndexedModule) => m.filePath !== currentPath
			);
			if (!candidates.length) {
				break;
			}
			const parent: IndexedModule =
				candidates.find((m: IndexedModule) => !m.override) ||
				candidates.find((m: IndexedModule) =>
					/\/Resources\/ui\//i.test(m.filePath)
				) ||
				candidates.find((m: IndexedModule) =>
					/\/Autogenerated\//i.test(m.filePath)
				) ||
				candidates[0];
			out.push(parent);
			current = parent;
		}
		return out;
	}

	/**
	 * Schema pages: conf/content hierarchy (stack + structureParent + extra Pkg).
	 * Ext modules: own file + override/extend chain.
	 */
	resolveThisMembers(filePath: string): IndexedMember[] {
		const mod = this.ensureModule(filePath);
		if (!mod) {
			return [];
		}

		const chainMods = this.collectOwnerChain(mod);

		const result = this.mergeMembers(chainMods, true);
		const seen = new Set(result.map((m) => memberDedupeKey(m)));
		this.appendMixinMembers(chainMods, result, seen);
		this.appendMixinAccessors(chainMods, result, seen);
		if (this.schemaBindsEntityColumns(chainMods)) {
			this.appendEntityColumns(chainMods, result, seen);
		}
		this.appendEntitySchemaObject(chainMods, result, seen);
		for (const member of this.modalBoxViewModelMembers(chainMods)) {
			this.pushUnseen(result, seen, member);
		}
		this.appendRuntimeThisMembers(result, seen);
		return result;
	}

	/**
	 * Names declared on parents / mixins / entity / core — local overrides of these
	 * are not "unused" even if this file never references them.
	 */
	resolveInheritedSchemaNames(filePath: string): {
		methods: Set<string>;
		attributes: Set<string>;
		messages: Set<string>;
	} {
		const methods = new Set<string>();
		const attributes = new Set<string>();
		const messages = new Set<string>();
		const mod = this.ensureModule(filePath);
		if (!mod) {
			return { methods, attributes, messages };
		}
		const current = normalizeFilePath(filePath);
		const addOwner = (owner: IndexedModule) => {
			if (normalizeFilePath(owner.filePath) === current) {
				return;
			}
			for (const member of owner.members) {
				if (member.kind === "method") {
					methods.add(member.name);
				}
				if (member.kind === "attribute") {
					attributes.add(member.name);
				}
			}
			for (const name of Object.keys(owner.messages || {})) {
				messages.add(name);
			}
		};
		const chainMods = this.collectOwnerChain(mod);
		for (const owner of chainMods) {
			addOwner(owner);
		}
		this.forEachMixinModule(chainMods, addOwner);
		if (this.schemaBindsEntityColumns(chainMods)) {
			const entity = this.getEntityModuleForChain(chainMods);
			if (entity) {
				for (const member of entity.members) {
					attributes.add(member.name);
				}
			}
		}
		for (const msg of this.coreMessages) {
			messages.add(msg.name);
		}
		return { methods, attributes, messages };
	}

	/**
	 * Members under `this.{path}`, e.g. `mixins`, `mixins.LocalName`, `sandbox`.
	 */
	resolveThisPathMembers(filePath: string, pathAfterThis: string): IndexedMember[] {
		let current = this.resolveThisMembers(filePath);
		const parts = pathAfterThis.split(".").filter(Boolean);
		for (const part of parts) {
			const node = current.find((m) => m.name === part);
			if (!node?.children?.length) {
				return [];
			}
			current = node.children;
		}
		return current;
	}

	/**
	 * messages from the current schema/module, parents, and mixins (child-first).
	 */
	resolveSchemaMessages(filePath: string): Record<string, IndexedSchemaMessage> {
		const mod = this.ensureModule(filePath);
		if (!mod) {
			return {};
		}
		const result: Record<string, IndexedSchemaMessage> = {};
		const add = (owner: IndexedModule) => {
			for (const [name, msg] of Object.entries(owner.messages || {})) {
				if (!(name in result)) {
					result[name] = msg;
				}
			}
		};
		const chainMods = this.collectOwnerChain(mod);
		for (const owner of chainMods) {
			add(owner);
		}
		this.forEachMixinModule(chainMods, add);
		this.forEachMixinHostSchemaOwner(mod, add);
		this.appendCoreMessages(result);
		return result;
	}

	resolveSandboxMessages(
		filePath: string,
		action: "publish" | "subscribe"
	): IndexedSchemaMessage[] {
		return Object.values(this.resolveSchemaMessages(filePath))
			.filter((msg) => schemaMessageSupports(msg, action))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	findSchemaMessageLocations(
		filePath: string,
		messageName: string
	): Array<{
		filePath: string;
		position: { line: number; character: number };
		direction: IndexedSchemaMessage["direction"];
		documentation?: string;
	}> {
		const mod = this.ensureModule(filePath);
		if (!mod || !messageName) {
			return [];
		}
		const hits: Array<{
			filePath: string;
			position: { line: number; character: number };
			direction: IndexedSchemaMessage["direction"];
			documentation?: string;
		}> = [];
		const seen = new Set<string>();
		const consider = (owner: IndexedModule) => {
			if (seen.has(owner.filePath)) {
				return;
			}
			seen.add(owner.filePath);
			const msg = owner.messages?.[messageName];
			if (!msg?.position) {
				return;
			}
			hits.push({
				filePath: owner.filePath,
				position: msg.position,
				direction: msg.direction,
				documentation: msg.documentation
			});
		};
		const chainMods = this.collectOwnerChain(mod);
		for (const owner of chainMods) {
			consider(owner);
		}
		this.forEachMixinModule(chainMods, consider);
		this.forEachMixinHostSchemaOwner(mod, consider);
		this.appendCoreMessageLocations(hits, seen, messageName);
		return hits;
	}

	private appendCoreMessages(result: Record<string, IndexedSchemaMessage>): void {
		for (const core of this.coreMessages) {
			const existing = result[core.name];
			if (!existing) {
				result[core.name] = core;
				continue;
			}
			if (existing.filePath && existing.filePath !== core.filePath) {
				continue;
			}
			if (existing.direction !== core.direction) {
				existing.direction = "bidirectional";
			}
			existing.documentation = existing.documentation || core.documentation;
			existing.position = existing.position || core.position;
			existing.filePath = existing.filePath || core.filePath;
		}
	}

	private appendCoreMessageLocations(
		hits: Array<{
			filePath: string;
			position: { line: number; character: number };
			direction: IndexedSchemaMessage["direction"];
			documentation?: string;
		}>,
		seen: Set<string>,
		messageName: string
	): void {
		for (const core of this.coreMessages) {
			if (core.name !== messageName || !core.filePath || !core.position) {
				continue;
			}
			if (seen.has(core.filePath)) {
				continue;
			}
			seen.add(core.filePath);
			hits.push({
				filePath: core.filePath,
				position: core.position,
				direction: core.direction,
				documentation: core.documentation
			});
		}
	}

	findThisPathMember(
		filePath: string,
		pathAfterThis: string,
		name: string
	): IndexedMember | undefined {
		return this.resolveThisPathMembers(filePath, pathAfterThis).find(
			(m) => m.name === name
		);
	}

	/**
	 * Parent/mixin methods that can be overridden in the current schema or class.
	 * Current file members are excluded (already defined).
	 */
	resolveOverridableMethods(
		filePath: string
	): Array<{ name: string; params: string[]; owner: string; documentation?: string }> {
		const mod = this.ensureModule(filePath);
		if (!mod) {
			return [];
		}

		const chainMods = this.collectOwnerChain(mod);

		const seen = new Set<string>();
		for (const member of mod.members) {
			if (member.kind === "method") {
				seen.add(member.name);
			}
		}

		const out: Array<{
			name: string;
			params: string[];
			owner: string;
			documentation?: string;
		}> = [];

		const addFrom = (ownerMod: IndexedModule) => {
			if (ownerMod.filePath === mod.filePath) {
				return;
			}
			const owner = inheritdocTarget(ownerMod);
			for (const member of ownerMod.members) {
				if (member.kind !== "method" || seen.has(member.name)) {
					continue;
				}
				seen.add(member.name);
				out.push({
					name: member.name,
					params: member.params || [],
					owner,
					documentation: member.documentation
				});
			}
		};

		for (const ownerMod of chainMods) {
			addFrom(ownerMod);
		}
		this.forEachMixinModule(chainMods, addFrom);
		return out;
	}

	findThisMemberLocations(
		filePath: string,
		memberName: string,
		kind?: IndexedMember["kind"]
	): Array<{ module: IndexedModule; member: IndexedMember }> {
		const mod = this.ensureModule(filePath);
		if (!mod) {
			return [];
		}
		const hits: Array<{ module: IndexedModule; member: IndexedMember }> = [];
		const seenPaths = new Set<string>();
		const dollar = memberName.startsWith("$") && memberName.length > 1;
		const lookupName = dollar ? memberName.slice(1) : memberName;
		const requiredKind = kind || (dollar ? "attribute" : undefined);

		const consider = (m: IndexedModule) => {
			const pathKey = normalizeFilePath(m.filePath);
			if (seenPaths.has(pathKey)) {
				return;
			}
			seenPaths.add(pathKey);
			const member = this.firstPositionedMember(m, lookupName, requiredKind);
			if (member) {
				hits.push({ module: m, member });
			}
		};

		const chainMods = this.collectOwnerChain(mod);

		for (const m of chainMods) {
			consider(m);
		}
		this.forEachMixinModule(chainMods, consider);
		if (this.schemaBindsEntityColumns(chainMods)) {
			const entityMod = this.getEntityModuleForChain(chainMods);
			if (entityMod) {
				consider(entityMod);
			}
		}
		const modalBox = this.getModalBoxSchemaModule(chainMods);
		if (modalBox) {
			for (const member of this.membersFromViewModelBindings(modalBox)) {
				if (member.name !== lookupName) {
					continue;
				}
				if (requiredKind && member.kind !== requiredKind) {
					continue;
				}
				if (!member.position) {
					continue;
				}
				hits.push({ module: modalBox, member });
			}
		}
		return this.collapseEquivalentHits(hits);
	}

	/**
	 * Next method in the override/extend/schema chain (this.callParent).
	 * Schema replacements: skip more-specific layers (children) and the
	 * current Pkg/Autogen origin; continue toward parents.
	 */
	findNearestParentMethod(
		filePath: string,
		methodName: string
	): { module: IndexedModule; member: IndexedMember } | undefined {
		const mod = this.ensureModule(filePath);
		if (!mod) {
			return undefined;
		}
		const current = normalizeFilePath(filePath);
		const currentOrigin = schemaOriginKey(filePath);
		const owners = isPageSchema(mod)
			? this.collectSchemaParentsAfter(mod)
			: this.collectInheritanceChain(mod);
		const hits: Array<{ module: IndexedModule; member: IndexedMember }> = [];
		const seenPaths = new Set<string>();
		for (const owner of owners) {
			const pathKey = normalizeFilePath(owner.filePath);
			if (
				pathKey === current ||
				schemaOriginKey(owner.filePath) === currentOrigin ||
				seenPaths.has(pathKey)
			) {
				continue;
			}
			seenPaths.add(pathKey);
			const member = this.firstPositionedMember(owner, methodName, "method");
			if (member) {
				hits.push({ module: owner, member });
			}
		}
		return this.collapseEquivalentHits(hits)[0];
	}

	private firstPositionedMember(
		mod: IndexedModule,
		name: string,
		kind?: IndexedMember["kind"]
	): IndexedMember | undefined {
		for (const member of mod.members) {
			if (member.name !== name) {
				continue;
			}
			if (kind && member.kind !== kind) {
				continue;
			}
			if (!member.position) {
				continue;
			}
			return member;
		}
		return undefined;
	}

	private collapseEquivalentHits(
		hits: Array<{ module: IndexedModule; member: IndexedMember }>
	): Array<{ module: IndexedModule; member: IndexedMember }> {
		const byOrigin = new Map<
			string,
			{ module: IndexedModule; member: IndexedMember }
		>();
		for (const hit of hits) {
			const key = schemaOriginKey(hit.module.filePath);
			const prev = byOrigin.get(key);
			if (!prev || preferPkgHit(hit, prev)) {
				byOrigin.set(key, hit);
			}
		}
		return Array.from(byOrigin.values());
	}

	private collectOwnerChain(mod: IndexedModule): IndexedModule[] {
		if (isPageSchema(mod)) {
			return this.collectSchemaHierarchyModules(mod);
		}
		const { ordered, push } = this.newModuleList();
		push(mod);
		for (const parent of this.collectInheritanceChain(mod)) {
			push(parent);
		}
		this.appendMixinHostSchemaVmLayers(mod, push);
		return ordered;
	}

	private appendMixinHostSchemaVmLayers(
		mod: IndexedModule,
		push: (m: IndexedModule | undefined) => void
	): void {
		const hosts = this.findMixinHostModules(mod).filter((h) => isPageSchema(h));
		if (!hosts.length) {
			return;
		}
		this.appendExtClassChain(this.schemaViewModelClassName(), push);
		const seenExtend = new Set<string>();
		for (const host of hosts) {
			const ext = this.hierarchy.resolvePlatformExtendClass(host.name);
			if (!ext || seenExtend.has(ext)) {
				continue;
			}
			seenExtend.add(ext);
			this.appendExtClassChain(ext, push);
		}
	}

	private newModuleList(): {
		ordered: IndexedModule[];
		push: (m: IndexedModule | undefined) => void;
	} {
		const ordered: IndexedModule[] = [];
		const seen = new Set<string>();
		const push = (m: IndexedModule | undefined) => {
			if (!m || seen.has(m.filePath)) {
				return;
			}
			seen.add(m.filePath);
			ordered.push(m);
		};
		return { ordered, push };
	}

	private collectSchemaHierarchyModules(mod: IndexedModule): IndexedModule[] {
		const { ordered, push } = this.newModuleList();
		// Current file first (most specific while editing)
		push(mod);
		this.appendSchemaOwnerLayers(mod, push);
		return ordered;
	}

	/** Layers strictly below `mod` in child → parent order (this.callParent). */
	private collectSchemaParentsAfter(mod: IndexedModule): IndexedModule[] {
		const { ordered, push } = this.newModuleList();
		this.appendSchemaOwnerLayers(mod, push);
		const current = normalizeFilePath(mod.filePath);
		const idx = ordered.findIndex(
			(item) => normalizeFilePath(item.filePath) === current
		);
		if (idx >= 0) {
			return ordered.slice(idx + 1);
		}
		return ordered;
	}

	private appendSchemaOwnerLayers(
		mod: IndexedModule,
		push: (m: IndexedModule | undefined) => void
	): void {
		if (this.hierarchy.hasRoots()) {
			const layers = this.hierarchy.resolveSchemaLayers(mod.name, mod.filePath);
			for (const layer of layers) {
				push(this.ensureModule(layer.filePath));
			}
		} else {
			for (const sibling of this.getAllByName(mod.name)) {
				push(sibling);
			}
		}
		this.appendExtClassChain(this.schemaViewModelClassName(), push);
		this.appendExtClassChain(
			this.hierarchy.resolvePlatformExtendClass(mod.name),
			push
		);
	}

	/**
	 * Ext class that SchemaBuilder uses as the root of generated schema view models.
	 * Vanilla Creatio: BPMSoft.BaseSchemaViewModel (not listed in structureParent).
	 */
	private schemaViewModelClassName(): string {
		const generator =
			this.pickNamedModule("BPMSoft.ViewModelGenerator") ||
			this.pickNamedModule("ViewModelGeneratorV2");
		const member = generator?.members.find(
			(m) => m.name === "baseViewModelClassName"
		);
		const raw = `${member?.detail || ""} ${member?.documentation || ""}`;
		const match = raw.match(/BPMSoft(?:\.\w+)+/);
		return match?.[0] || "BPMSoft.BaseSchemaViewModel";
	}

	private appendExtClassChain(
		className: string | undefined,
		push: (m?: IndexedModule) => void
	): void {
		if (!className) {
			return;
		}
		const root = this.pickNamedModule(className);
		if (!root) {
			return;
		}
		push(root);
		for (const parent of this.collectInheritanceChain(root)) {
			push(parent);
		}
	}

	private pickNamedModule(name: string): IndexedModule | undefined {
		const candidates = this.getAllByName(name);
		if (!candidates.length) {
			return undefined;
		}
		return (
			candidates.find(
				(m) => !m.override && /\/Resources\/ui\//i.test(m.filePath)
			) ||
			candidates.find((m) => !m.override) ||
			candidates.find((m) => /\/Resources\/ui\//i.test(m.filePath)) ||
			candidates[0]
		);
	}

	private declaredMixins(
		owners: IndexedModule[]
	): Array<{ localName: string; className: string }> {
		const out: Array<{ localName: string; className: string }> = [];
		const seen = new Set<string>();
		for (const schemaMod of owners) {
			for (const [localName, className] of Object.entries(schemaMod.mixins)) {
				if (seen.has(localName)) {
					continue;
				}
				seen.add(localName);
				out.push({ localName, className });
			}
		}
		return out;
	}

	private mixinModulesForClass(className: string): IndexedModule[] {
		const short = className.replace(/^BPMSoft\./, "");
		const mixinMods = this.modulesNamed(className, short);
		const unique = new Map<string, IndexedModule>();
		for (const m of mixinMods) {
			unique.set(m.filePath, m);
		}
		return Array.from(unique.values());
	}

	private forEachMixinHostKey(
		mod: IndexedModule,
		visit: (key: string) => void
	): void {
		for (const className of Object.values(mod.mixins || {})) {
			if (!className) {
				continue;
			}
			for (const key of mixinIndexKeys(className)) {
				visit(key);
			}
		}
	}

	private indexMixinHost(mod: IndexedModule): void {
		this.forEachMixinHostKey(mod, (key) => {
			let set = this.mixinKeyToHostPaths.get(key);
			if (!set) {
				set = new Set();
				this.mixinKeyToHostPaths.set(key, set);
			}
			set.add(mod.filePath);
		});
	}

	private unindexMixinHost(mod: IndexedModule): void {
		this.forEachMixinHostKey(mod, (key) => {
			const set = this.mixinKeyToHostPaths.get(key);
			if (!set) {
				return;
			}
			set.delete(mod.filePath);
			if (!set.size) {
				this.mixinKeyToHostPaths.delete(key);
			}
		});
	}

	private moduleAsMixinKeys(mod: IndexedModule): string[] {
		const keys = new Set<string>();
		for (const raw of [mod.name, mod.className, mod.alternateClassName]) {
			if (!raw) {
				continue;
			}
			for (const k of mixinIndexKeys(raw)) {
				keys.add(k);
			}
		}
		return Array.from(keys);
	}

	private forEachMixinHostSchemaOwner(
		mod: IndexedModule,
		visit: (owner: IndexedModule) => void
	): void {
		const seen = new Set<string>();
		const consider = (owner: IndexedModule) => {
			if (seen.has(owner.filePath)) {
				return;
			}
			seen.add(owner.filePath);
			visit(owner);
		};
		for (const host of this.findMixinHostModules(mod).filter((h) =>
			isPageSchema(h)
		)) {
			const chainMods = this.collectOwnerChain(host);
			for (const owner of chainMods) {
				consider(owner);
			}
			this.forEachMixinModule(chainMods, consider);
		}
	}

	private findMixinHostModules(mod: IndexedModule): IndexedModule[] {
		const paths = new Set<string>();
		for (const key of this.moduleAsMixinKeys(mod)) {
			const set = this.mixinKeyToHostPaths.get(key);
			if (!set) {
				continue;
			}
			for (const p of set) {
				if (p !== mod.filePath) {
					paths.add(p);
				}
			}
		}
		const out: IndexedModule[] = [];
		for (const p of paths) {
			const host = this.modulesByPath.get(p);
			if (host) {
				out.push(host);
			}
		}
		return out;
	}

	private entityNameFromChain(owners: IndexedModule[]): string | undefined {
		return owners
			.map((m) => m.entitySchemaName)
			.find((name): name is string => Boolean(name));
	}

	private collectMixinCardHosts(mod: IndexedModule): IndexedModule[] {
		return this.findMixinHostModules(mod).filter((host) =>
			this.pageChainBindsEntityColumns(this.collectOwnerChain(host))
		);
	}

	private collectCardHostEntityNames(mod: IndexedModule): string[] {
		const seen = new Set<string>();
		const names: string[] = [];
		for (const host of this.collectMixinCardHosts(mod)) {
			const name = this.entityNameFromChain(this.collectOwnerChain(host));
			if (name && !seen.has(name)) {
				seen.add(name);
				names.push(name);
			}
		}
		return names;
	}

	private intersectEntityModules(names: string[]): IndexedModule | undefined {
		const mods = names
			.map((n) => this.getEntityModule(n))
			.filter((m): m is IndexedModule => Boolean(m));
		if (!mods.length) {
			return undefined;
		}
		if (mods.length === 1) {
			return mods[0];
		}
		const sets = mods.map((m) => new Set(m.members.map((x) => x.name)));
		const members = mods[0].members.filter((mem) =>
			sets.every((s) => s.has(mem.name))
		);
		if (!members.length) {
			return undefined;
		}
		return {
			name: names.join("+"),
			filePath: mods[0].filePath,
			kind: "unknown",
			dependencies: [],
			paramNames: [],
			members: members.map((m) => ({ ...m })),
			mixins: {},
			messages: {},
			entitySchemaName: names[0]
		};
	}

	private getEntityModuleFromMixinHosts(
		mod: IndexedModule
	): IndexedModule | undefined {
		const names = this.collectCardHostEntityNames(mod);
		if (!names.length) {
			return undefined;
		}
		if (names.length === 1) {
			return this.getEntityModule(names[0]);
		}
		return this.intersectEntityModules(names);
	}

	private forEachMixinModule(
		owners: IndexedModule[],
		visit: (mod: IndexedModule) => void
	): void {
		const seen = new Set<string>();
		for (const { className } of this.declaredMixins(owners)) {
			for (const mixinMod of this.mixinModulesForClass(className)) {
				if (seen.has(mixinMod.filePath)) {
					continue;
				}
				seen.add(mixinMod.filePath);
				visit(mixinMod);
			}
		}
	}

	private mixinMembersFromModules(mods: IndexedModule[]): IndexedMember[] {
		const result: IndexedMember[] = [];
		const seen = new Set<string>();
		for (const mixinMod of mods) {
			for (const member of mixinMod.members) {
				this.pushUnseen(result, seen, {
					...member,
					filePath: member.filePath || mixinMod.filePath,
					detail:
						member.detail ||
						`mixin ${mixinMod.name} (${packageLabel(mixinMod.filePath)})`
				});
			}
		}
		return result;
	}

	private mixinMembersForClass(className: string): IndexedMember[] {
		return this.mixinMembersFromModules(this.mixinModulesForClass(className));
	}

	private mixinAccessorMember(
		localName: string,
		className: string
	): IndexedMember {
		const mods = this.mixinModulesForClass(className);
		const origin = mods[0];
		return {
			name: localName,
			kind: "namespace",
			detail: `mixin ${className}`,
			documentation: `Миксин ${className}`,
			children: this.mixinMembersFromModules(mods),
			filePath: origin?.filePath,
			position:
				origin?.members[0]?.position ||
				(origin ? { line: 0, character: 0 } : undefined)
		};
	}

	private appendMixinMembers(
		owners: IndexedModule[],
		result: IndexedMember[],
		seen: Set<string>
	): void {
		const mixinAlts = new Set(
			this.declaredMixins(owners).map((item) => item.className)
		);
		for (const alt of mixinAlts) {
			for (const member of this.mixinMembersForClass(alt)) {
				this.pushUnseen(result, seen, member);
			}
		}
	}

	/**
	 * `this.LocalMixin` and `this.mixins.LocalMixin` with mixin methods as children.
	 */
	private appendMixinAccessors(
		owners: IndexedModule[],
		result: IndexedMember[],
		seen: Set<string>
	): void {
		const declared = this.declaredMixins(owners);
		if (!declared.length) {
			return;
		}
		const mixinItems = declared.map((item) =>
			this.mixinAccessorMember(item.localName, item.className)
		);
		for (const item of mixinItems) {
			if (seen.has(item.name)) {
				continue;
			}
			seen.add(item.name);
			result.push(item);
		}
		const mixinsMember: IndexedMember = {
			name: "mixins",
			kind: "property",
			detail: "schema mixins",
			documentation:
				"Миксины схемы и иерархии: this.mixins.Name и this.Name",
			children: mixinItems
		};
		const existing = result.findIndex((m) => m.name === "mixins");
		if (existing >= 0) {
			result[existing] = mixinsMember;
		} else {
			result.push(mixinsMember);
		}
		seen.add("mixins");
	}

	private modalBoxViewModelMembers(owners: IndexedModule[]): IndexedMember[] {
		const module = this.getModalBoxSchemaModule(owners);
		return module ? this.membersFromViewModelBindings(module) : [];
	}

	private membersFromViewModelBindings(module: IndexedModule): IndexedMember[] {
		const out: IndexedMember[] = [];
		for (const name of module.viewModelBindings || []) {
			const member = module.members.find(
				(item) => item.name === name && item.kind === "method"
			);
			if (!member) {
				continue;
			}
			out.push({
				...member,
				filePath: member.filePath || module.filePath,
				detail:
					member.detail ||
					`ModalBoxSchemaModule (${packageLabel(module.filePath)})`
			});
		}
		return out;
	}

	private getModalBoxSchemaModule(
		owners: IndexedModule[]
	): IndexedModule | undefined {
		if (!owners.some((item) => item.name === BASE_MODAL_BOX_PAGE)) {
			return undefined;
		}
		const named =
			this.pickNamedModule(`BPMSoft.${MODAL_BOX_SCHEMA_MODULE}`) ||
			this.pickNamedModule(MODAL_BOX_SCHEMA_MODULE) ||
			this.pickNamedModule(`BPMSoft.configuration.${MODAL_BOX_SCHEMA_MODULE}`);
		if (named) {
			return named;
		}
		const filePath = this.hierarchy.resolveEntitySchemaPath(
			MODAL_BOX_SCHEMA_MODULE
		);
		return filePath ? this.ensureModule(filePath) : undefined;
	}

	private appendRuntimeThisMembers(
		result: IndexedMember[],
		seen: Set<string>
	): void {
		const runtime: IndexedMember[] = [
			{
				name: "Ext",
				kind: "property",
				detail: "injected Ext",
				documentation:
					"Экземпляр Ext модуля (тот же API, что у глобального Ext)"
			},
			{
				name: "BPMSoft",
				kind: "property",
				detail: "injected BPMSoft",
				documentation:
					"Экземпляр BPMSoft модуля (тот же API, что у глобального BPMSoft)"
			},
			{
				name: "sandbox",
				kind: "property",
				detail: "module sandbox",
				documentation:
					"Песочница модуля: publish / subscribe / loadModule",
				children: this.getSandboxMembers(),
				filePath: this.sandboxOrigin?.filePath,
				position: this.sandboxOrigin?.position
			}
		];
		for (const member of runtime) {
			const key = memberDedupeKey(member);
			const existingIdx = result.findIndex((m) => memberDedupeKey(m) === key);
			if (existingIdx >= 0) {
				const existing = result[existingIdx];
				if (member.children?.length && !existing.children?.length) {
					result[existingIdx] = {
						...existing,
						children: member.children,
						documentation: existing.documentation || member.documentation,
						filePath: existing.filePath || member.filePath,
						position: existing.position || member.position
					};
				}
				continue;
			}
			seen.add(key);
			result.push(member);
		}
	}

	private getSandboxMembers(): IndexedMember[] {
		if (this.sandboxMembers.length) {
			return this.sandboxMembers;
		}
		const built = buildSandboxStubs(this.workspaceRoots);
		this.sandboxMembers = built.members;
		this.sandboxOrigin = built.origin;
		return this.sandboxMembers;
	}

	private appendEntityColumns(
		owners: IndexedModule[],
		result: IndexedMember[],
		seen: Set<string>
	): void {
		const entityMod = this.getEntityModuleForChain(owners);
		if (!entityMod) {
			return;
		}
		for (const member of entityMod.members) {
			this.pushUnseen(result, seen, {
				...member,
				detail: member.detail || `entity ${entityMod.name}`,
				filePath: member.filePath || entityMod.filePath
			});
		}
	}

	/**
	 * `this.entitySchema` — instance of BPMSoft.BaseEntitySchema
	 * (SchemaBuilder: BPMSoft.require(entitySchemaName)).
	 */
	private appendEntitySchemaObject(
		owners: IndexedModule[],
		result: IndexedMember[],
		seen: Set<string>
	): void {
		const entityMod = this.getEntityModuleForChain(owners);
		const children = this.entitySchemaObjectMembers(entityMod);
		if (!children.length) {
			return;
		}
		const member: IndexedMember = {
			name: "entitySchema",
			kind: "property",
			detail: entityMod
				? `BPMSoft.${entityMod.name}`
				: "BPMSoft.BaseEntitySchema",
			documentation: entityMod
				? `Схема объекта ${entityMod.name} (BPMSoft.BaseEntitySchema)`
				: "Схема объекта страницы (BPMSoft.BaseEntitySchema)",
			children,
			filePath: entityMod?.filePath || children[0]?.filePath
		};
		const existingIdx = result.findIndex((item) => item.name === "entitySchema");
		if (existingIdx >= 0) {
			const existing = result[existingIdx];
			result[existingIdx] = {
				...existing,
				detail: member.detail || existing.detail,
				documentation: existing.documentation || member.documentation,
				filePath: existing.filePath || member.filePath,
				position: existing.position || member.position,
				children
			};
			return;
		}
		this.pushUnseen(result, seen, member);
	}

	private entitySchemaObjectMembers(
		entityMod: IndexedModule | undefined
	): IndexedMember[] {
		const base =
			this.pickNamedModule("BPMSoft.BaseEntitySchema") ||
			this.pickNamedModule("BPMSoft.data.models.BaseEntitySchema") ||
			this.pickNamedModule("BaseEntitySchema");
		const mods: IndexedModule[] = [];
		if (entityMod?.entityClassMembers?.length) {
			mods.push({
				...entityMod,
				members: entityMod.entityClassMembers
			});
		}
		if (base) {
			mods.push(base, ...this.collectInheritanceChain(base));
		}
		const members = mods.length ? this.mergeMembers(mods, true) : [];
		const columnChildren = (entityMod?.members || []).map((column) => ({
			...column,
			kind: column.kind === "attribute" ? "property" : column.kind
		}));
		const columnsIdx = members.findIndex((item) => item.name === "columns");
		const columnsMember: IndexedMember = {
			name: "columns",
			kind: "property",
			detail: entityMod ? `entity ${entityMod.name} columns` : "entity columns",
			documentation: "Колонки схемы объекта",
			children: columnChildren,
			filePath:
				(columnsIdx >= 0 ? members[columnsIdx].filePath : undefined) ||
				entityMod?.filePath
		};
		if (columnsIdx >= 0) {
			members[columnsIdx] = {
				...members[columnsIdx],
				...columnsMember,
				detail: members[columnsIdx].detail || columnsMember.detail,
				documentation:
					members[columnsIdx].documentation || columnsMember.documentation
			};
		} else if (columnChildren.length) {
			members.push(columnsMember);
		}
		return members;
	}

	/**
	 * Entity object columns as `this.$` / `this.get` / `this.set` only on
	 * card schemas (`EDIT_VIEW_MODEL_SCHEMA`, details). Sections
	 * (`MODULE_VIEW_MODEL_SCHEMA`) keep `entitySchemaName` / `entitySchema`
	 * but do not bind columns onto the view model.
	 */
	private pageChainBindsEntityColumns(owners: IndexedModule[]): boolean {
		const page = owners.find((m) => m.kind === "page");
		if (!page) {
			return false;
		}
		const schemaType = this.hierarchy.resolveSchemaType(page.name);
		if (schemaType && NO_ENTITY_COLUMN_SCHEMA_TYPES.has(schemaType)) {
			return false;
		}
		return true;
	}

	private schemaBindsEntityColumns(owners: IndexedModule[]): boolean {
		if (this.pageChainBindsEntityColumns(owners)) {
			return true;
		}
		const current = owners[0];
		if (!current) {
			return false;
		}
		return this.collectMixinCardHosts(current).length > 0;
	}

	private getEntityModuleForChain(
		owners: IndexedModule[]
	): IndexedModule | undefined {
		const ownName = this.entityNameFromChain(owners);
		if (ownName) {
			return this.getEntityModule(ownName);
		}
		const current = owners[0];
		if (!current) {
			return undefined;
		}
		return this.getEntityModuleFromMixinHosts(current);
	}

	private getEntityModule(entityName: string): IndexedModule | undefined {
		if (this.entityCache.has(entityName)) {
			return this.entityCache.get(entityName) || undefined;
		}
		const confPath = this.hierarchy.resolveEntitySchemaPath(entityName);
		const metaPaths = this.hierarchy.resolveEntityPkgMetadataPaths(entityName);
		if (!confPath && !metaPaths.length) {
			this.entityCache.set(entityName, null);
			return undefined;
		}
		try {
			const byName = new Map<string, IndexedMember>();
			let classMembers: IndexedMember[] = [];
			if (confPath) {
				const source = fs.readFileSync(confPath, "utf8");
				for (const member of parseEntityColumns(source, confPath)) {
					byName.set(member.name, {
						...member,
						filePath: member.filePath || confPath,
						detail: member.detail || `entity ${entityName}`
					});
				}
				const api = parseAmdModule(source, confPath);
				classMembers = api?.members || [];
			}
			const captions = loadEntityColumnCaptions(
				this.hierarchy.resolveEntityPkgResourceDirs(entityName)
			);
			for (const metaPath of metaPaths) {
				const source = fs.readFileSync(metaPath, "utf8");
				for (const column of parsePkgEntityColumns(source, metaPath)) {
					if (byName.has(column.name)) {
						continue;
					}
					const lookup = Boolean(column.children?.length);
					byName.set(column.name, {
						...column,
						detail: column.detail || `entity ${entityName}`,
						documentation: entityColumnDocumentation(
							captions,
							column.name,
							lookup
						)
					});
				}
			}
			const members = Array.from(byName.values());
			if (!members.length) {
				this.entityCache.set(entityName, null);
				return undefined;
			}
			const mod: IndexedModule = {
				name: entityName,
				filePath: confPath || metaPaths[0],
				kind: "unknown",
				dependencies: [],
				paramNames: [],
				members,
				entityClassMembers: classMembers,
				mixins: {},
				messages: {},
				entitySchemaName: entityName
			};
			this.entityCache.set(entityName, mod);
			return mod;
		} catch {
			this.entityCache.set(entityName, null);
			return undefined;
		}
	}

	resolveLocalAlias(filePath: string, alias: string): string | undefined {
		const mod = this.modulesByPath.get(filePath);
		if (!mod) {
			return undefined;
		}
		if (alias === mod.name) {
			return mod.name;
		}
		const idx = mod.paramNames.indexOf(alias);
		if (idx >= 0 && idx < mod.dependencies.length) {
			return mod.dependencies[idx];
		}
		if (mod.dependencies.includes(alias)) {
			return alias;
		}
		return undefined;
	}

	private mergeMembers(
		mods: IndexedModule[],
		annotateSource = false
	): IndexedMember[] {
		const result: IndexedMember[] = [];
		const seen = new Set<string>();
		for (const mod of mods) {
			const label = packageLabel(mod.filePath);
			for (const member of mod.members) {
				this.pushUnseen(
					result,
					seen,
					annotateSource
						? {
								...member,
								detail: member.detail || label,
								filePath: member.filePath || mod.filePath
							}
						: member
				);
			}
		}
		return result;
	}

	private pushUnseen(
		result: IndexedMember[],
		seen: Set<string>,
		member: IndexedMember
	): void {
		const key = memberDedupeKey(member);
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		result.push(member);
	}

	private pushNamed(
		map: Map<string, IndexedModule[]>,
		key: string,
		mod: IndexedModule
	): void {
		const list = map.get(key);
		if (list) {
			list.push(mod);
		} else {
			map.set(key, [mod]);
		}
	}

	private pullNamed(
		map: Map<string, IndexedModule[]>,
		key: string,
		filePath: string
	): void {
		const list = map.get(key);
		if (!list) {
			return;
		}
		const next = list.filter((m) => m.filePath !== filePath);
		if (next.length) {
			map.set(key, next);
		} else {
			map.delete(key);
		}
	}
}
